"""Prove della lettura dal JSON della Regione. Si lancia con: python prove/monitor_json_test.py"""
import copy, json, os, sys, types
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "monitor-allerte"))
import monitor_allerte as m

REALE = json.load(open(os.path.join(os.path.dirname(__file__), "dati", "BLMultiCfd_176_00_2026-11-23.json"), encoding="utf-8"))
LINK = "/documents/90748/14376036/BLMultiCfd_176_00_2026-11-23.json/4c5b89b5"
HOME = f'<html><a href="{LINK}">Versione in formato JSON</a><a href="/x/BAR_261123.pdf">pdf</a></html>'


def ok(c, t):
    print(("OK   " if c else "FAIL ") + t)
    if not c: ok.fail = True
ok.fail = False


def con_livello(dati, giorno, rischio, liv, desc):
    d = copy.deepcopy(dati)
    riga = next(z for z in d["zone"][giorno] if z["area"].strip().upper() == m.ZONA)
    for r in riga["rischi"]:
        if r["rischio"].upper().startswith(rischio):
            r["livello"], r["liv_descrizione"] = liv, desc
    return d


# 1) file vero: tutto verde, tendenza e fenomeni letti
r = m.leggi_json(REALE)
ok(r["numero"] == "176/2026" and r["tipo"] == "Bollettino" and [g["giorno"] for g in r["giorni"]] == ["OGGI", "DOMANI"], "bollettino reale letto (numero, oggi e domani)")
ok(all(g["livello"] == "VERDE" for g in r["giorni"]) and r["giorni"][0]["data"] == "23/11/2026", "livelli e date")
ok("perturbazione" in r["tendenza"] and "assenza" in r["fenomeni"], "tendenza e fenomeni letti")
ok(r["emissione"].strftime("%d/%m/%Y %H:%M") == "23/11/2026 10:41", "data di emissione")

# 2) arancione per idrogeologico domani
arancio = con_livello(REALE, "domani", "IDROGEOLOGICO", 3, "ARANCIONE")
r = m.leggi_json(arancio)
ok(r["giorni"][1]["livello"] == "ARANCIONE" and r["giorni"][0]["livello"] == "VERDE", "arancione domani, verde oggi")

# 3) dubbi => errore (mai verde per default)
for nome, d in (("zona mancante", {**REALE, "zone": {"oggi": [], "domani": []}}), ("livello strano", con_livello(REALE, "oggi", "IDRAULICO", 9, "BOH"))):
    try: m.leggi_json(d); ok(False, nome)
    except m.ErroreLettura: ok(True, f"{nome}: ErroreLettura")
try: m.leggi_json({"x": 1}); ok(False, "struttura sconosciuta")
except m.ErroreLettura: ok(True, "struttura sconosciuta: ErroreLettura")

# 4) trova_json
ok(m.trova_json(HOME).endswith(LINK) and m.trova_json(HOME).startswith("https://"), "collegamento JSON trovato nella pagina")
ok(m.trova_json("<html></html>") is None, "nessun collegamento -> None")


# 5) flusso completo: JSON letto, registrato una volta, secondo giro niente di nuovo
def esegui(dati, A, pdf_ok=False, home=HOME):
    msgs = []
    def finto(url, tentativi=6):
        if url == m.HOME_URL: return types.SimpleNamespace(text=home)
        if "BLMultiCfd" in url: return types.SimpleNamespace(json=lambda: dati)
        if url == m.CFD_URL and pdf_ok: return types.SimpleNamespace(text="<html></html>")
        raise m.SitoNonRaggiungibile("ConnectTimeout: finto")
    m.http_get = finto
    m.registra_lettura = lambda *a, **k: None
    return m.esegui(A, lambda t: msgs.append(t) or True), msgs

A = m.ArchivioMemoria()
rc, msgs = esegui(arancio, A)
reg = A.liste.get("allerte_cfd_veneto", [])
ok(rc == 0 and len(reg) == 2 and reg[1]["livello"] == "ARANCIONE" and reg[1]["formato"] == "JSON" and reg[1]["fonte"] == "AUTO", "registrati oggi+domani da JSON")
ok(len(msgs) == 1 and "ARANCIONE" in msgs[0], "Telegram arancione una volta")
ok(A.doc["cfd_stato/monitor"]["esito"] == "ok" and A.doc["cfd_stato/monitor"]["formato"] == "JSON" and A.doc["cfd_stato/monitor"]["ultimoOk"], "stato ok + ultimoOk")
ok(reg[0]["tendenza"] and reg[0]["pdfUrl"] == m.CFD_URL, "tendenza salvata, link per le persone = pagina bollettini")
rc, msgs = esegui(arancio, A)
ok(len(A.liste["allerte_cfd_veneto"]) == 2 and not msgs, "secondo giro: niente doppioni, niente Telegram")

# 6) il PDF dello stesso bollettino (gia' letto da JSON) non viene riletto
ok("Bollettino 176/2026#00" in A.doc["cfd_stato/letti"]["chiavi"], "documento segnato come letto")

# 7) JSON illeggibile e pagina PDF raggiungibile ma vuota -> errore generico, non verde
A = m.ArchivioMemoria()
rc, _ = esegui({"x": 1}, A, pdf_ok=True)
ok(rc == 1 and A.doc["cfd_stato/monitor"]["esito"] == "errore" and not A.liste, "JSON rotto + PDF vuoto: errore segnalato, nulla scritto")

# 8) sito irraggiungibile: stato 'non raggiungibile', niente errore
A = m.ArchivioMemoria()
m.riserva_dpc = lambda *a, **k: None
rc, _ = esegui(REALE, A, home=None)
ok(rc == 0 and A.doc["cfd_stato/monitor"].get("nonRaggiungibile") is True, "sito giu': stato non raggiungibile, run verde")

sys.exit(1 if ok.fail else 0)
