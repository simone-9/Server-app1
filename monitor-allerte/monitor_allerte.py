#!/usr/bin/env python3
"""
Monitoraggio del Bollettino / Avviso di allerta regionale (CFD Veneto) per la zona E1 (Curtarolo).

A ogni esecuzione:
  1. legge la pagina dei bollettini del CFD e trova i PDF "Bollettino/Avviso di allerta regionale" (BAR_ / AAR_);
  2. per ogni documento nuovo scarica il PDF e legge i livelli della zona per OGNI tipo di rischio;
  3. salva i dati su Firestore (le schede dell'app si aggiornano da sole);
  4. invia Telegram per allerte ARANCIONE/ROSSA (e per il rientro da quei livelli), senza ripetizioni;
  5. se un documento non si legge con certezza segna "DA VERIFICARE" e avvisa: mai "verde" per default.

Prova locale su un PDF (nessun accesso a Firebase):
    python monitor_allerte.py --pdf BAR_261022.pdf
"""
import argparse, hashlib, io, json, os, re, sys
from datetime import datetime, timedelta
from urllib.parse import urljoin
from zoneinfo import ZoneInfo

CFD_URL = "https://www.regione.veneto.it/web/protezione-civile/cfd"
ZONA = (os.environ.get("CFD_ZONA") or "E1").strip().upper()
# Più gruppi sullo stesso Firebase: con GRUPPO_ID i dati stanno sotto "gruppi/<codice>/" (altrimenti percorso storico).
GRUPPO = os.environ.get("GRUPPO_ID", "").strip().lower()
PREF = f"gruppi/{GRUPPO}/" if GRUPPO else ""
COMUNE = (os.environ.get("COMUNE") or "Curtarolo").strip()
NOME_ZONA = (os.environ.get("CFD_NOME_ZONA") or "Pianura centrale")
TELEGRAM_CONSENTITO = True   # il gruppo può spegnere Telegram dall'app (impostazioni del gruppo)
CFD_ATTIVO = True            # idem per le allerte CFD
CHAT_GRUPPO = ""             # ID della chat Telegram scritto nelle impostazioni del gruppo (precedenza sul segreto)
SOGLIA_TELEGRAM = os.environ.get("SOGLIA_TELEGRAM", "ARANCIONE").strip().upper()
USER_AGENT = "ProtezioneCivile-Monitor/1.0 (monitoraggio allerte, protezione civile comunale)"
MAX_DOCUMENTI = 6
TIMEOUT = 40
TIMEOUT_CONNESSIONE = (10, 40)   # (connessione, lettura): se il sito della Regione non risponde in 10 s si smette subito di aspettare
TZ = ZoneInfo("Europe/Rome")

LIVELLI = ["VERDE", "GIALLA", "ARANCIONE", "ROSSA"]
RANGO = {l: i for i, l in enumerate(LIVELLI)}
MESI = {"gennaio": 1, "febbraio": 2, "marzo": 3, "aprile": 4, "maggio": 5, "giugno": 6, "luglio": 7,
        "agosto": 8, "settembre": 9, "ottobre": 10, "novembre": 11, "dicembre": 12}
# intestazione colonna (senza "RISCHIO") -> (chiave, etichetta)
RISCHI_NOTI = {
    "IDRAULICO": ("idraulico", "Idraulico"),
    "IDROGEOLOGICO": ("idrogeologico", "Idrogeologico"),
    "IDROGEOLOGICO TEMPORALI": ("temporali", "Idrogeologico per temporali"),
    "VALANGHE": ("valanghe", "Valanghe"),
    "NEVE": ("neve", "Neve"),
    "GHIACCIO AL SUOLO": ("ghiaccio", "Ghiaccio al suolo"),
    "VENTO": ("vento", "Vento"),
    "ONDATE DI CALORE": ("calore", "Ondate di calore"),
}


class ErroreLettura(Exception):
    """Documento non letto con certezza: va verificato a mano."""


def data_it(g, mese_nome, anno):
    mese = MESI.get(mese_nome.lower())
    if not mese:
        raise ErroreLettura(f"mese non riconosciuto: {mese_nome}")
    return f"{int(g)}/{mese}/{int(anno)}"       # stesso formato di toLocaleDateString('it-IT') nell'app


GIORNI_SETTIMANA = ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"]


def data_con_giorno(data):
    """'5/11/2026' -> 'giovedì 5/11/2026' (solo per i messaggi: nello storico la data resta com'è)."""
    try:
        g, m, a = (int(x) for x in str(data).split("/"))
        return f"{GIORNI_SETTIMANA[datetime(a, m, g).weekday()]} {data}"
    except Exception:
        return str(data)


def giorno_da_tabella(tabella):
    """tabella = righe di pdfplumber. Ritorna {rischio: livello|None} per la zona configurata."""
    if not tabella or not tabella[0] or (tabella[0][0] or "").strip().upper() != "ZONA":
        raise ErroreLettura("intestazione della tabella non riconosciuta")
    nomi = []
    for c in tabella[0][1:]:
        t = re.sub(r"\s+", " ", (c or "")).strip().upper()
        t = re.sub(r"^RISCHIO\s+", "", t)
        nomi.append(t)
    riga = next((r for r in tabella[1:] if r and (r[0] or "").strip().upper() == ZONA), None)
    if riga is None:
        raise ErroreLettura(f"riga della zona {ZONA} non trovata")
    valori = [re.sub(r"\s+", "", (c or "")).upper() for c in riga[1:]]
    if len(valori) != len(nomi):
        raise ErroreLettura(f"{len(nomi)} colonne ma {len(valori)} valori per la zona {ZONA}")
    rischi = {}
    for nome, val in zip(nomi, valori):
        if val not in LIVELLI and val != "-":
            raise ErroreLettura(f"valore non riconosciuto per {nome}: '{val}'")
        chiave, etichetta = RISCHI_NOTI.get(nome, (re.sub(r"\W+", "_", nome.lower()), nome.capitalize()))
        rischi[chiave] = {"nome": etichetta, "livello": None if val == "-" else val}
    if not any(v["livello"] for v in rischi.values()):
        raise ErroreLettura("nessun livello leggibile per la zona")
    return rischi


def livello_max(rischi):
    return max((v["livello"] for v in rischi.values() if v["livello"]), key=lambda l: RANGO[l])


def leggi_pdf(data: bytes):
    import pdfplumber
    giorni, testi = [], []
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for pag in pdf.pages:
            testo = pag.extract_text() or ""
            testi.append(testo)
            m = re.search(r"ALLERTA\s+PREVISTA\s+PER\s+(OGGI|DOMANI|DOPODOMANI)\s*[-–—]\s*\S+\s+(\d{1,2})\s+([^\W\d_]+)\s+(\d{4})", testo, re.I)
            if not m:
                continue
            tabelle = pag.extract_tables()
            if len(tabelle) != 1:
                raise ErroreLettura(f"attesa 1 tabella, trovate {len(tabelle)}")
            rischi = giorno_da_tabella(tabelle[0])
            giorni.append({"giorno": m.group(1).upper(), "data": data_it(m.group(2), m.group(3), m.group(4)),
                           "livello": livello_max(rischi), "rischi": rischi})
    tutto = "\n".join(testi)
    mt = re.search(r"(BOLLETTINO|AVVISO)\s+DI\s+ALLERTA\s+REGIONALE", tutto, re.I)
    if not mt:
        raise ErroreLettura("non sembra un documento di allerta regionale")
    if not any(g["giorno"] == "OGGI" for g in giorni):
        raise ErroreLettura("tabella dell'allerta di oggi non trovata")
    mn = re.search(r"Documento\s+n\.?\s*(\d+)\s*/\s*(\d{4})", tutto, re.I)
    me = re.search(r"Emissione:\s*\S+\s+(\d{1,2})\s+([^\W\d_]+)\s+(\d{4})\s+ore:?\s*(\d{1,2})[:.](\d{2})", tutto, re.I)
    emissione = None
    if me and MESI.get(me.group(2).lower()):
        emissione = datetime(int(me.group(3)), MESI[me.group(2).lower()], int(me.group(1)), int(me.group(4)), int(me.group(5)), tzinfo=TZ)
    fen = re.search(r"FENOMENI\s+PREVISTI\s*(.*?)\s*TENDENZA\s*(.*?)\s*(?:Note\b|Agenzia\s+Regionale)", tutto, re.S)
    return {"tipo": "Bollettino" if mt.group(1).upper() == "BOLLETTINO" else "Avviso",
            "numero": f"{int(mn.group(1))}/{mn.group(2)}" if mn else None, "emissione": emissione, "giorni": giorni,
            "fenomeni": re.sub(r"\s+", " ", fen.group(1)).strip() if fen else "",
            "tendenza": re.sub(r"\s+", " ", fen.group(2)).strip() if fen else ""}


# ------------------------------------------------------------------ pagina CFD
def trova_documenti(html):
    from bs4 import BeautifulSoup
    soup, visti, docs = BeautifulSoup(html, "lxml"), set(), []
    for a in soup.find_all("a", href=True):
        if re.search(r"/(BAR|AAR)_\d{6}[^/]*\.pdf", a["href"], re.I):
            url = urljoin(CFD_URL, a["href"])
            if url not in visti:
                visti.add(url)
                docs.append({"url": url, "testo": " ".join(a.get_text().split())})
    return docs[:MAX_DOCUMENTI]


class SitoNonRaggiungibile(Exception):
    """Il sito della Regione non risponde o segnala un guasto suo (503...): problema temporaneo, non dello script."""


_ULTIMI_TENTATIVI = 0   # tentativi usati dall'ultima http_get (serve al registro delle letture)


def http_get(url, tentativi=6):
    """Scarica una pagina. Riprova con pause crescenti se il sito non risponde (connessione rifiutata, timeout, errore 5xx):
    se non risponde mai solleva SitoNonRaggiungibile. Gli altri errori (es. 404) sono errori veri e passano subito."""
    import requests, time
    pause = [float(x) for x in os.environ.get("PAUSE_RIPROVA", "3,5").split(",")]
    ultimo = ""
    global _ULTIMI_TENTATIVI
    for i in range(tentativi):
        _ULTIMI_TENTATIVI = i + 1
        try:
            r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT_CONNESSIONE)
            if r.status_code < 500 and r.status_code not in (408, 429):
                r.raise_for_status()
                return r
            ultimo = f"risposta {r.status_code} dal sito"
        except (requests.ConnectionError, requests.Timeout) as e:
            ultimo = f"{type(e).__name__}: {str(e)[:120]}"
        if i < tentativi - 1:
            print(f"Sito non raggiungibile ({ultimo}), riprovo tra {pause[min(i, len(pause) - 1)]:.0f} s")
            time.sleep(pause[min(i, len(pause) - 1)])
    raise SitoNonRaggiungibile(f"{ultimo} dopo {tentativi} tentativi")


# ------------------------------------------------------------------ Telegram
def messaggio_telegram(g, doc, url, prec_liv):
    icone = {"ARANCIONE": "\U0001F7E0", "ROSSA": "\U0001F534"}
    liv = g["livello"]
    if RANGO[liv] < RANGO[SOGLIA_TELEGRAM]:
        testa = f"✅ Allerta rientrata (era {prec_liv}): ora {liv} per {g['giorno']} ({data_con_giorno(g['data'])})"
    else:
        testa = f"{icone.get(liv, '')} ALLERTA {liv} - {g['giorno']} ({data_con_giorno(g['data'])})"
    righe = [testa, f"Zona {ZONA} - {NOME_ZONA} ({COMUNE})", ""]
    attivi = [v for v in g["rischi"].values() if v["livello"] and v["livello"] != "VERDE"]
    if attivi:
        righe.append("Rischi:")
        righe += [f"• {v['nome']}: {v['livello']}" for v in attivi]
    em = doc["emissione"].strftime("%d/%m/%Y ore %H:%M") if doc["emissione"] else "n.d."
    righe += ["", f"Fonte: {doc['tipo']} di allerta regionale n. {doc['numero'] or '?'} - emissione {em}", url]
    return "\n".join(righe)


_DB = None   # impostato quando c'è l'accesso a Firestore: serve per le notifiche push


def invia_push(testo):
    """Notifica push (Firebase Cloud Messaging) a tutti i dispositivi registrati dall'app. Ritorna True se almeno uno la riceve."""
    if _DB is None or os.environ.get("PUSH_DA_MONITOR", "") != "1":
        return False   # di norma le push delle allerte CFD le invia scripts/idro.mjs (workflow Idrometria): qui restano spente per non averle doppie
    try:
        from firebase_admin import messaging
        righe = [r.strip() for r in testo.split("\n") if r.strip()]
        titolo = (righe[0] if righe else "Allerta")[:120]
        corpo = " ".join(righe[1:3])[:200]
        inviati = 0
        for d in list(_DB.collection(PREF + "push_dispositivi").stream()):
            tok = (d.to_dict() or {}).get("token")
            if not tok:
                continue
            try:
                messaging.send(messaging.Message(
                    token=tok, data={"titolo": titolo, "testo": corpo, "tag": "allerta", "icona": "⚠️", "url": "./"},
                    webpush=messaging.WebpushConfig(headers={"Urgency": "high", "TTL": "3600"}),
                    android=messaging.AndroidConfig(priority="high")))
                inviati += 1
            except Exception as e:
                nome = type(e).__name__
                if nome in ("UnregisteredError", "NotFoundError", "InvalidArgumentError"):
                    d.reference.delete()      # dispositivo non più valido: si toglie dall'elenco
                else:
                    print("Push non inviato:", nome, str(e)[:120])
        print(f"Push: {inviati} dispositivi raggiunti")
        return inviati > 0
    except Exception as e:
        print("Errore push:", e)
        return False


def invia_avviso(testo):
    """Telegram (se configurato) e push (se c'è Firestore): ne basta uno."""
    t = invia_telegram(testo)
    p = invia_push(testo)
    return t or p


def applica_config_gruppo(c):
    """Impostazioni del gruppo scritte dall'app (comune, zona CFD, Telegram sì/no). Hanno la precedenza sulle variabili del repository."""
    global ZONA, COMUNE, NOME_ZONA, TELEGRAM_CONSENTITO, CFD_ATTIVO, CHAT_GRUPPO
    if not isinstance(c, dict):
        return
    if c.get("comune"):
        COMUNE = str(c["comune"]).strip()
    cfd = c.get("cfd") or {}
    if cfd.get("zona"):
        ZONA = str(cfd["zona"]).strip().upper()
        if cfd.get("zonaNome"):
            NOME_ZONA = str(cfd["zonaNome"]).strip()
    if cfd.get("attivo") is False:
        CFD_ATTIVO = False
    tg = c.get("telegram") or {}
    if tg.get("attivo") is False:
        TELEGRAM_CONSENTITO = False
    elif tg.get("chatId"):
        CHAT_GRUPPO = str(tg["chatId"]).strip()
    print(f"Impostazioni del gruppo lette: {COMUNE}, zona CFD {ZONA if CFD_ATTIVO else 'non usata'}, Telegram {'consentito' if TELEGRAM_CONSENTITO else 'spento'}")


def invia_telegram(testo):
    import requests
    if not TELEGRAM_CONSENTITO:
        print("Telegram disattivato nelle impostazioni del gruppo: messaggio non inviato")
        return False
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip(), (CHAT_GRUPPO or os.environ.get("TELEGRAM_CHAT_ID", "")).strip()
    if not token or not chat:
        print("Telegram non configurato: messaggio non inviato")
        return False
    try:
        r = requests.post(f"https://api.telegram.org/bot{token}/sendMessage",
                          json={"chat_id": chat, "text": testo, "disable_web_page_preview": True}, timeout=TIMEOUT)
        ok = bool(r.ok and r.json().get("ok"))
        if not ok:
            print("Errore Telegram:", r.text[:200])
        return ok
    except Exception as e:
        print("Errore Telegram:", e)
        return False


# ------------------------------------------------------------------ archivi
class ArchivioFirestore:
    def __init__(self):
        import firebase_admin
        from firebase_admin import credentials, firestore
        firebase_admin.initialize_app(credentials.Certificate(json.loads(os.environ["FIREBASE_SERVICE_ACCOUNT"])))
        self.db = firestore.client()
        global _DB
        _DB = self.db

    def leggi(self, p):
        d = self.db.document(PREF + p).get()
        return d.to_dict() if d.exists else None

    def scrivi(self, p, dati):
        self.db.document(PREF + p).set(dati, merge=True)

    def aggiungi(self, coll, dati):
        self.db.collection(PREF + coll).add(dati)

    def elimina_se(self, coll, condizione):
        n = 0
        for d in self.db.collection(PREF + coll).stream():
            if condizione(d.to_dict() or {}):
                d.reference.delete()
                n += 1
        return n


class ArchivioMemoria:
    def __init__(self):
        self.doc, self.liste = {}, {}

    def leggi(self, p):
        return self.doc.get(p)

    def scrivi(self, p, dati):
        self.doc[p] = {**self.doc.get(p, {}), **dati}

    def aggiungi(self, coll, dati):
        self.liste.setdefault(coll, []).append(dati)


# ------------------------------------------------------------------ elaborazione
def firma(g):
    return g["livello"] + "|" + ";".join(sorted(f"{k}:{v['livello']}" for k, v in g["rischi"].items() if v["livello"] and v["livello"] != "VERDE"))


def nome_documento(doc):
    n = f"{doc['tipo']} di allerta regionale n. {doc['numero'] or '?'}"
    return n + (f" (agg. {doc['aggiornamento']})" if doc.get("aggiornamento") not in (None, "", "00") else "")


def chiavi_lette(archivio):
    """Documenti gia' elaborati, da qualunque fonte (JSON o PDF): 'Bollettino 176/2026#00' ('#?' = aggiornamento non noto, dal PDF)."""
    return set((archivio.leggi("cfd_stato/letti") or {}).get("chiavi", []))


def segna_letto(archivio, doc):
    chiavi = list((archivio.leggi("cfd_stato/letti") or {}).get("chiavi", []))
    k = f"{doc['tipo']} {doc['numero']}#{doc.get('aggiornamento') or '?'}"
    if k not in chiavi:
        chiavi.append(k)
        archivio.scrivi("cfd_stato/letti", {"chiavi": chiavi[-300:]})


def elabora(archivio, url, testo_link, pdf_bytes, invia=None):
    invia = invia or invia_avviso
    doc_id, ora = hashlib.sha1(url.encode()).hexdigest()[:20], datetime.now(TZ).isoformat()
    try:
        doc = leggi_pdf(pdf_bytes)
    except Exception as e:          # qualsiasi problema = "da verificare", mai verde
        archivio.scrivi(f"cfd_documenti/{doc_id}", {"url": url, "stato": "errore", "errore": str(e), "elaborato": ora})
        archivio.scrivi("cfd_stato/monitor", {"daVerificare": {"url": url, "documento": testo_link, "motivo": str(e), "quando": ora}})
        invia(f"⚠️ Monitoraggio allerte: non riesco a leggere con certezza \"{testo_link}\".\nMotivo: {e}\nVerifica a mano: {url}")
        print("DA VERIFICARE:", url, e)
        return False
    return registra_documento(archivio, doc_id, url, url, doc, invia, "PDF")


def registra_documento(archivio, doc_id, url_doc, url_umano, doc, invia, formato):
    """Scrive allerte, stato e Telegram per un documento gia' letto (da PDF o da JSON). url_umano = il link da mostrare alle persone."""
    ora = datetime.now(TZ).isoformat()
    emis = (doc["emissione"] or datetime.now(TZ)).isoformat()
    nome = nome_documento(doc)
    firme = dict((archivio.leggi("cfd_stato/notifiche") or {}).get("firme", {}))
    for g in doc["giorni"]:
        f_new, f_old = firma(g), firme.get(g["data"])
        liv_old = f_old.split("|")[0] if f_old else "VERDE"
        notifica = f_new != f_old and (RANGO[g["livello"]] >= RANGO[SOGLIA_TELEGRAM] or RANGO[liv_old] >= RANGO[SOGLIA_TELEGRAM])
        inviata = invia(messaggio_telegram(g, doc, url_umano, liv_old)) if notifica else False
        firme[g["data"]] = f_new
        attivo = g["livello"] != "VERDE"
        rec = {
            "data": g["data"], "giorno": g["giorno"], "zona": f"{ZONA} ({NOME_ZONA})", "livello": g["livello"],
            "rischi": g["rischi"], "timestamp": emis, "documento": nome, "pdfUrl": url_umano,
            "fenomeni": doc["fenomeni"], "tendenza": doc["tendenza"], "inseritoDa": "Monitoraggio automatico CFD",
            "fonte": "AUTO", "formato": formato, "telegramInviato": inviata,
            "esitoWA": "Notifica inviata" if inviata else ("Registrato (senza invio)" if attivo else "Registrato")}
        if doc.get("allertaPrevista"):
            rec["allertaPrevista"] = doc["allertaPrevista"]
        if doc.get("noteRischi"):
            rec["noteRischi"] = doc["noteRischi"]
        archivio.aggiungi("allerte_cfd_veneto", rec)
    archivio.scrivi("cfd_stato/notifiche", {"firme": firme})
    archivio.scrivi(f"cfd_documenti/{doc_id}", {"url": url_doc, "stato": "ok", "numero": doc["numero"], "tipo": doc["tipo"], "emissione": emis, "elaborato": ora, "formato": formato})
    archivio.scrivi("cfd_stato/monitor", {"daVerificare": None, "ultimoDocumento": nome, "ultimoDocumentoUrl": url_umano, "ultimaEmissione": emis})
    segna_letto(archivio, doc)
    print("Elaborato:", nome, f"[{formato}]", [(g["giorno"], g["data"], g["livello"]) for g in doc["giorni"]])
    return True


# ------------------------------------------------------------------ lettura da JSON (pagina "Protezione civile" della Regione)
HOME_URL = "https://www.regione.veneto.it/web/protezione-civile/protezione-civile"
NOTE_RISCHI = {"nota_idraulico": "idraulico", "nota_idrogeologico": "idrogeologico", "nota_idrogeologico_temp": "temporali",
               "nota_vento": "vento", "nota_neve": "neve", "nota_gelo": "ghiaccio", "nota_valanghe": "valanghe"}


def testo_pulito(t):
    import html as _h
    if not t:
        return ""
    t = re.sub(r"<br\s*/?>", " ", str(t), flags=re.I)
    return re.sub(r"\s+", " ", _h.unescape(re.sub(r"<[^>]+>", " ", t))).strip()


def trova_json(html):
    """Collegamento 'Versione in formato JSON' dell'ultimo documento (BLMultiCfd_<numero>_<aggiornamento>_<data>.json)."""
    from bs4 import BeautifulSoup
    for a in BeautifulSoup(html, "lxml").find_all("a", href=True):
        if re.search(r"/BLMultiCfd_[^/]*\.json", a["href"], re.I):
            return urljoin(HOME_URL, a["href"])
    return None


def leggi_json(dati):
    """JSON della Regione -> stessa struttura di leggi_pdf. Qualunque dubbio = ErroreLettura (si ripiega sul PDF, mai 'verde' per default)."""
    try:
        g, zone, note = dati["dati_generali"], dati["zone"], dati.get("note") or {}
        intest = str(g.get("intestazione", "")).upper()
        if "ALLERTA REGIONALE" not in intest:
            raise ErroreLettura("non sembra un documento di allerta regionale")
        giorni = []
        for giorno, kz, kd in (("OGGI", "oggi", "data_oggi"), ("DOMANI", "domani", "data_domani")):
            elenco = zone.get(kz) or []
            if not elenco and giorno == "DOMANI":
                continue
            riga = next((z for z in elenco if str(z.get("area", "")).strip().upper() == ZONA), None)
            if riga is None:
                raise ErroreLettura(f"zona {ZONA} non trovata ({giorno.lower()})")
            rischi = {}
            for r in riga.get("rischi", []):
                nome = re.sub(r"\s+", " ", str(r.get("rischio", ""))).strip().upper()
                liv = str(r.get("liv_descrizione", "")).strip().upper()
                if liv not in LIVELLI:
                    raise ErroreLettura(f"livello non riconosciuto per {nome}: '{liv}'")
                chiave, etichetta = RISCHI_NOTI.get(nome, (re.sub(r"\W+", "_", nome.lower()), nome.capitalize()))
                rischi[chiave] = {"nome": etichetta, "livello": liv}
            if not rischi:
                raise ErroreLettura("nessun livello leggibile per la zona")
            gg, mm, aa = (int(x) for x in str(g[kd]).split("/"))
            giorni.append({"giorno": giorno, "data": f"{gg}/{mm}/{aa}", "livello": livello_max(rischi), "rischi": rischi})
        if not any(x["giorno"] == "OGGI" for x in giorni):
            raise ErroreLettura("allerta di oggi non trovata")
        emissione = datetime.strptime(f"{g['data_compilazione']} {g['ora_compilazione']}", "%d/%m/%Y %H:%M:%S").replace(tzinfo=TZ)
        note_rischi = {k: testo_pulito(note.get(c)) for c, k in NOTE_RISCHI.items() if testo_pulito(note.get(c))}
        return {"tipo": "Avviso" if "AVVISO" in intest else "Bollettino", "numero": str(g["num_boll"]).strip(),
                "aggiornamento": str(g.get("aggiornamento", "00")).strip() or "00", "emissione": emissione, "giorni": giorni,
                "fenomeni": testo_pulito(note.get("fenomeni_previsti")), "tendenza": testo_pulito(note.get("tendenza")),
                "allertaPrevista": testo_pulito(note.get("allerta_prevista")), "noteRischi": note_rischi}
    except ErroreLettura:
        raise
    except Exception as e:
        raise ErroreLettura(f"JSON non leggibile: {type(e).__name__}: {e}")


def passo_json(archivio, invia, prendi):
    """Fonte principale. Ritorna quanti documenti nuovi ha elaborato (0 se gia' letto). Solleva se non riesce."""
    link = trova_json(prendi(HOME_URL).text)
    if not link:
        raise ErroreLettura("collegamento al JSON non trovato nella pagina della Protezione civile")
    doc = leggi_json(prendi(link).json())
    chiavi, k = chiavi_lette(archivio), f"{doc['tipo']} {doc['numero']}#{doc['aggiornamento']}"
    ultimo = (archivio.leggi("cfd_stato/monitor") or {}).get("ultimoDocumento")
    if os.environ.get("RIELABORA", "").lower() != "true" and (
            k in chiavi or (doc["aggiornamento"] == "00" and (f"{doc['tipo']} {doc['numero']}#?" in chiavi or ultimo == nome_documento(doc)))):
        if k not in chiavi:
            segna_letto(archivio, doc)
        return 0
    registra_documento(archivio, hashlib.sha1(("json:" + k).encode()).hexdigest()[:20], link, CFD_URL, doc, invia, "JSON")
    return 1


def passo_pdf(archivio, invia, prendi, breve=False):
    """Fonte di ripiego (e per i documenti che il JSON non copre, come gli avvisi). Ritorna quanti documenti nuovi ha elaborato."""
    pagina = prendi(CFD_URL, 2 if breve else 6)
    docs = trova_documenti(pagina.text)
    if not docs:
        raise RuntimeError("nessun documento di allerta trovato nella pagina (struttura cambiata?)")
    nuovi, chiavi = 0, chiavi_lette(archivio)
    rielabora = os.environ.get("RIELABORA", "").lower() == "true"
    if rielabora:
        docs = docs[:3]                           # solo i piu' recenti (gia' notificati: niente doppi messaggi Telegram)
    for d in reversed(docs):                      # dal piu' vecchio al piu' recente
        doc_id = hashlib.sha1(d["url"].encode()).hexdigest()[:20]
        if not rielabora and archivio.leggi(f"cfd_documenti/{doc_id}"):
            continue
        m = re.search(r"\bn\.?\s*(\d+/\d{4})", d["testo"])
        tipo = "Avviso" if re.search(r"avviso", d["testo"], re.I) else "Bollettino"
        if not rielabora and m and any(c.startswith(f"{tipo} {m.group(1)}#") for c in chiavi):
            archivio.scrivi(f"cfd_documenti/{doc_id}", {"url": d["url"], "stato": "ok", "numero": m.group(1), "nota": "gia' letto da un'altra fonte", "elaborato": datetime.now(TZ).isoformat()})
            continue
        elabora(archivio, d["url"], d["testo"], prendi(d["url"], 3 if breve else 6).content, invia)
        nuovi += 1
    return nuovi


GIORNI_STORICO = 15


def pulisci_storico(archivio, giorni=GIORNI_STORICO):
    """Cancella dallo storico le allerte piu' vecchie di `giorni`; oggi e domani non si toccano mai."""
    oggi = datetime.now(TZ).date()
    limite = oggi - timedelta(days=giorni)

    def vecchia(r):
        try:
            g, m, a = (int(x) for x in str(r.get("data", "")).split("/"))
            d = datetime(a, m, g).date()
        except Exception:
            return False                      # data illeggibile: non cancello
        return d < limite and d not in (oggi, oggi + timedelta(days=1))
    try:
        n = archivio.elimina_se("allerte_cfd_veneto", vecchia)
        if n:
            print(f"Pulizia storico: {n} allerte piu' vecchie di {giorni} giorni eliminate")
    except Exception as e:
        print("Pulizia storico non riuscita:", e)


# ------------------------------------------------------------------ riserva: bollettino nazionale della Protezione Civile
# Se il sito della Regione non risponde per piu' controlli di fila, si legge il bollettino di criticita' nazionale del DPC
# (repository pubblico su GitHub, CC BY 4.0). Copre solo idraulico, idrogeologico e temporali, esce dopo il bollettino regionale
# e non conosce vento, neve, ghiaccio, valanghe e calore. Per questo e' solo una RISERVA PRUDENTE:
#   - non scrive mai "verde" (se non ha niente da segnalare non cambia nulla);
#   - non cancella e non abbassa un livello gia' noto (niente messaggi di "rientro" da questa fonte);
#   - e' usata solo se piu' recente dell'ultimo documento regionale letto.
DPC_REPO = "pcm-dpc/DPC-Bollettini-Criticita-Idrogeologica-Idraulica"
DPC_RAW = f"https://raw.githubusercontent.com/{DPC_REPO}/master/files/geojson/"
DPC_URL = f"https://github.com/{DPC_REPO}"
RISCHI_DPC = {"Per rischio idraulico": ("idraulico", "Idraulico"), "Per rischio idrogeologico": ("idrogeologico", "Idrogeologico"),
              "Per rischio temporali": ("temporali", "Idrogeologico per temporali")}


def livello_da_testo_dpc(t):
    u = (t or "").upper()
    for l in ("ROSSA", "ARANCIONE", "GIALLA"):
        if l in u:
            return l
    if "NESSUNA" in u or "ASSENZA" in u:
        return "VERDE"
    raise ErroreLettura(f"livello non riconosciuto nel bollettino nazionale: '{t}'")


def zona_dpc(geojson, comune):
    """Dal geojson del DPC ricava la zona che contiene il comune: ({rischio: {nome, livello}}, nome zona)."""
    for f in geojson.get("features", []):
        p = f.get("properties") or {}
        if comune.lower() in [str(c).lower() for c in p.get("Comuni", [])]:
            rischi = {}
            for campo, (chiave, etichetta) in RISCHI_DPC.items():
                if campo not in p:
                    raise ErroreLettura(f"campo '{campo}' mancante nel bollettino nazionale")
                rischi[chiave] = {"nome": etichetta, "livello": livello_da_testo_dpc(p[campo])}
            return rischi, p.get("Nome zona", "")
    raise ErroreLettura(f"comune {comune} non trovato nel bollettino nazionale")


def ultimo_bollettino_dpc():
    """Sigla AAAAMMGG_HHMM dell'ultimo bollettino nel repository del DPC (ultimo commit che ha toccato files/geojson)."""
    import requests
    h = {"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"}
    if os.environ.get("GITHUB_TOKEN"):
        h["Authorization"] = "Bearer " + os.environ["GITHUB_TOKEN"]
    api = f"https://api.github.com/repos/{DPC_REPO}"
    c = requests.get(f"{api}/commits", params={"path": "files/geojson", "per_page": 1}, headers=h, timeout=TIMEOUT).json()
    if not isinstance(c, list) or not c:
        raise ErroreLettura("bollettino nazionale: elenco aggiornamenti non leggibile (" + str(c)[:120] + ")")
    sha = c[0]["sha"]
    det = requests.get(f"{api}/commits/{sha}", headers=h, timeout=TIMEOUT).json()
    sigle = sorted({m.group(1) for f in det.get("files", []) for m in [re.search(r"files/geojson/(\d{8}_\d{4})_(?:today|tomorrow)\.json$", f.get("filename", ""))] if m})
    if not sigle:
        raise ErroreLettura("bollettino nazionale: nessun file today/tomorrow nell'ultimo aggiornamento")
    return sigle[-1]


def scarica_dpc(sigla, quando):
    return http_get(f"{DPC_RAW}{sigla}_{quando}.json").json()


def messaggio_riserva(g, url, emissione, prec_liv):
    icone = {"ARANCIONE": "\U0001F7E0", "ROSSA": "\U0001F534"}
    righe = [f"{icone.get(g['livello'], '')} ALLERTA {g['livello']} - {g['giorno']} ({data_con_giorno(g['data'])})",
             f"Zona {ZONA} - {NOME_ZONA} ({COMUNE})", ""]
    attivi = [v for v in g["rischi"].values() if v["livello"] and v["livello"] != "VERDE"]
    if attivi:
        righe.append("Rischi:")
        righe += [f"• {v['nome']}: {v['livello']}" for v in attivi]
    righe += ["", "ATTENZIONE: il sito della Regione non risponde. Fonte di riserva: bollettino nazionale della Protezione Civile "
              f"(emissione {emissione.strftime('%d/%m/%Y ore %H:%M')}), senza vento, neve, ghiaccio e calore. Verifica il bollettino regionale.", url]
    return "\n".join(righe)


def riserva_dpc(archivio, invia=None):
    """Ritorna quante allerte ha scritto. Non solleva eccezioni verso il chiamante."""
    invia = invia or invia_avviso
    try:
        sigla = ultimo_bollettino_dpc()
        stato = archivio.leggi("cfd_stato/dpc") or {}
        if stato.get("ultimo") == sigla:
            return 0                                   # gia' visto
        emissione = datetime.strptime(sigla, "%Y%m%d_%H%M").replace(tzinfo=TZ)
        reg = (archivio.leggi("cfd_stato/monitor") or {}).get("ultimaEmissione")
        if reg and datetime.fromisoformat(reg) >= emissione:
            archivio.scrivi("cfd_stato/dpc", {"ultimo": sigla})
            print(f"Riserva DPC {sigla}: il documento regionale letto e' piu' recente, non serve")
            return 0
        firme = dict((archivio.leggi("cfd_stato/notifiche") or {}).get("firme", {}))
        scritte = 0
        for quando, giorno, delta in (("today", "OGGI", 0), ("tomorrow", "DOMANI", 1)):
            rischi, nome_zona = zona_dpc(scarica_dpc(sigla, quando), COMUNE)
            d = emissione.date() + timedelta(days=delta)
            data = f"{d.day}/{d.month}/{d.year}"
            g = {"giorno": giorno, "data": data, "livello": livello_max(rischi), "rischi": rischi}
            f_old = firme.get(data)
            liv_old = f_old.split("|")[0] if f_old else "VERDE"
            if RANGO[g["livello"]] <= RANGO[liv_old] or g["livello"] == "VERDE":
                continue                               # mai verde, mai abbassare: la riserva puo' solo segnalare di piu'
            inviata = invia(messaggio_riserva(g, DPC_URL, emissione, liv_old)) if RANGO[g["livello"]] >= RANGO[SOGLIA_TELEGRAM] else False
            firme[data] = firma(g)
            archivio.aggiungi("allerte_cfd_veneto", {
                "data": data, "giorno": giorno, "zona": f"{ZONA} ({NOME_ZONA})", "livello": g["livello"], "rischi": rischi,
                "timestamp": emissione.isoformat(), "documento": "Bollettino di criticita' nazionale (Protezione Civile) - riserva",
                "pdfUrl": DPC_URL, "fenomeni": "", "tendenza": "", "inseritoDa": "Monitoraggio automatico (riserva Protezione Civile)",
                "fonte": "AUTO-DPC", "telegramInviato": inviata, "esitoWA": "Notifica inviata" if inviata else "Registrato (senza invio)"})
            scritte += 1
            print(f"Riserva DPC {sigla}: {giorno} {data} {g['livello']} (zona {nome_zona})")
        archivio.scrivi("cfd_stato/notifiche", {"firme": firme})
        archivio.scrivi("cfd_stato/dpc", {"ultimo": sigla, "letto": datetime.now(TZ).isoformat()})
        return scritte
    except Exception as e:
        print("Riserva DPC non riuscita:", e)
        return 0


MAX_VOCI_REGISTRO = 1000   # circa una settimana di controlli ogni 10 minuti


def registra_lettura(archivio, ora, esito, tentativi, secondi):
    """Aggiunge una voce al registro cfd_stato/letture: quando la Regione risponde e quando no (per capire a che ora conviene leggere)."""
    try:
        voci = list((archivio.leggi("cfd_stato/letture") or {}).get("voci", []))
        voci.append({"t": ora, "e": esito, "n": tentativi, "s": round(secondi)})
        archivio.scrivi("cfd_stato/letture", {"voci": voci[-MAX_VOCI_REGISTRO:]})
    except Exception as e:
        print("Registro letture non aggiornato:", e)


AVVISO_SITO_ORE = float(os.environ.get("AVVISO_SITO_ORE", "6"))


def esegui(archivio, invia=None):
    import time
    invia = invia or invia_avviso
    ora = datetime.now(TZ).isoformat()
    t0 = time.monotonic()
    registrata = [False]

    def prendi(url, tentativi=6):
        r = http_get(url, tentativi)
        if not registrata[0]:                     # primo contatto riuscito con il sito: lo si scrive nel registro delle letture
            registrata[0] = True
            registra_lettura(archivio, ora, "ok", _ULTIMI_TENTATIVI, time.monotonic() - t0)
        return r
    try:
        nuovi, via, json_irraggiungibile = None, "JSON", False
        try:
            nuovi = passo_json(archivio, invia, prendi)
        except SitoNonRaggiungibile as e:
            json_irraggiungibile = True
            print("JSON non raggiunto, provo la pagina dei bollettini PDF:", e)
        except Exception as e:
            print(f"::warning::JSON non utilizzabile ({e}): ripiego sul PDF")
        if nuovi is None:                         # ripiego: PDF come sempre (gli errori vanno ai gestori qui sotto)
            via = "PDF"
            nuovi = passo_pdf(archivio, invia, prendi, breve=json_irraggiungibile)   # sito gia' lento: pochi tentativi
        else:                                     # JSON riuscito: il PDF solo per i documenti che il JSON non copre; se non risponde non e' un errore
            try:
                nuovi += passo_pdf(archivio, invia, prendi, breve=True)
            except SitoNonRaggiungibile:
                print("Pagina dei bollettini PDF non raggiunta: eventuali avvisi solo-PDF non controllati in questo giro")
            except Exception as e:
                print("Controllo dei PDF non riuscito:", e)
        archivio.scrivi("cfd_stato/monitor", {"ultimoControllo": ora, "ultimoOk": ora, "esito": "ok", "messaggio": f"{nuovi} nuovi documenti ({via})", "formato": via, "erroriConsecutivi": 0, "nonRaggiungibile": False})
        return 0
    except SitoNonRaggiungibile as e:
        # il sito della Regione e' fuori uso: non e' un errore dello script. Si tiene l'ultimo bollettino, si segnala "non aggiornato"
        # nell'app e il lavoro su GitHub resta verde. Avviso su Telegram solo se dura da circa un'ora (6 controlli).
        n = int((archivio.leggi("cfd_stato/monitor") or {}).get("erroriConsecutivi", 0)) + 1
        msg = "Sito della Regione non raggiungibile: bollettino non aggiornato (" + str(e)[:150] + ")"
        archivio.scrivi("cfd_stato/monitor", {"ultimoControllo": ora, "esito": "errore", "messaggio": msg[:300], "erroriConsecutivi": n, "nonRaggiungibile": True})
        print("ATTENZIONE:", msg)
        if not registrata[0]:   # se la pagina e' stata letta e manca solo un PDF, la lettura e' gia' registrata come riuscita
            registra_lettura(archivio, ora, "timeout", _ULTIMI_TENTATIVI, time.monotonic() - t0)
        if n >= int(os.environ.get("RISERVA_DPC_DOPO", "3")):
            riserva_dpc(archivio, invia)       # fonte di riserva: bollettino nazionale (solo se piu' recente e piu' grave)
        if n >= 6:
            # un solo avviso ogni 6 ore: se il sito va e viene, il contatore riparte da zero e lo stesso messaggio si ripeterebbe di continuo
            ultimo = (archivio.leggi("cfd_stato/monitor") or {}).get("avvisoSito")
            if not ultimo or datetime.now(TZ) - datetime.fromisoformat(ultimo) > timedelta(hours=AVVISO_SITO_ORE):
                if invia(f"⚠️ Monitoraggio allerte: il sito della Regione non risponde da circa un'ora, i bollettini non sono aggiornati.\nVerifica a mano: {CFD_URL}"):
                    archivio.scrivi("cfd_stato/monitor", {"avvisoSito": ora})
        return 0
    except Exception as e:
        n = int((archivio.leggi("cfd_stato/monitor") or {}).get("erroriConsecutivi", 0)) + 1
        archivio.scrivi("cfd_stato/monitor", {"ultimoControllo": ora, "esito": "errore", "messaggio": str(e)[:300], "erroriConsecutivi": n})
        print("ERRORE:", e)
        if n == 3:
            invia(f"⚠️ Monitoraggio allerte: 3 controlli consecutivi falliti ({str(e)[:150]}).\nVerifica a mano: {CFD_URL}")
        return 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", help="legge un PDF locale e stampa il risultato (senza Firebase)")
    ap.add_argument("--test-telegram", action="store_true", help="invia solo un messaggio di prova su Telegram")
    a = ap.parse_args()
    if a.test_telegram or os.environ.get("TEST_TELEGRAM", "").lower() == "true":
        ok = invia_telegram(f"\u2705 Test Protezione Civile {COMUNE}: il monitoraggio allerte CFD e' collegato a Telegram.")
        print("Test Telegram:", "INVIATO" if ok else "FALLITO")
        return 0 if ok else 1
    if a.pdf:
        d = leggi_pdf(open(a.pdf, "rb").read())
        d["emissione"] = d["emissione"].isoformat() if d["emissione"] else None
        print(json.dumps(d, ensure_ascii=False, indent=2))
        return 0
    if not os.environ.get("FIREBASE_SERVICE_ACCOUNT"):
        print("Manca FIREBASE_SERVICE_ACCOUNT")
        return 2
    archivio = ArchivioFirestore()
    try:
        if os.environ.get("GRUPPO_CONFIG_FILE"):
            applica_config_gruppo(json.load(open(os.environ["GRUPPO_CONFIG_FILE"], encoding="utf-8")))
        else:
            applica_config_gruppo(archivio.leggi("impostazioni/gruppo"))
    except Exception as e:
        print("Impostazioni del gruppo non lette, uso le variabili del repository:", e)
    if not CFD_ATTIVO:
        print("Allerte CFD disattivate nelle impostazioni del gruppo: niente da fare.")
        return 0
    esito = esegui(archivio)
    pulisci_storico(archivio)
    return esito


if __name__ == "__main__":
    sys.exit(main())
