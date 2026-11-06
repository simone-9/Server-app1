#!/usr/bin/env python3
"""
Calendario dell'app (Firestore, raccolta "calendario_eventi") -> file .ics in abbonamento e Google Calendar del gruppo.

  python sync_calendario_google.py --ics public/calendario.ics    scrive solo il file .ics (da pubblicare con GitHub Pages)
  python sync_calendario_google.py                                sincronizza il Google Calendar del gruppo
  python sync_calendario_google.py --prova                        mostra cosa farebbe su Google, senza modificare nulla

Sincronizzazione Google a senso unico: app -> Google Calendar.
  * evento nuovo o modificato nell'app  -> creato / aggiornato in Google Calendar
  * evento eliminato nell'app           -> eliminato da Google Calendar
  * eventi inseriti a mano direttamente in Google Calendar NON vengono toccati (si riconoscono perche'
    quelli sincronizzati portano la proprieta' privata pcSync=1).

Variabili d'ambiente:
  FIREBASE_SERVICE_ACCOUNT  JSON dell'account di servizio Firebase (lo stesso gia' usato dal monitor allerte)
  GOOGLE_CALENDAR_ID        ID del calendario Google del gruppo (variabile del repository, serve solo per la sincronizzazione Google)
  CONSENTI_SVUOTA           "true" per consentire di cancellare tutti gli eventi se l'app risulta vuota

Prova senza toccare nulla:   python sync_calendario_google.py --prova
"""
import argparse, hashlib, json, os, sys
from datetime import date, datetime, timedelta

CAL_ID = (os.environ.get("GOOGLE_CALENDAR_ID") or "").strip()
TZ = "Europe/Rome"
API = "https://www.googleapis.com/calendar/v3/calendars/"
COLORI = {"Esercitazione": "7", "Manifestazione": "5", "Prevenzione": "10"}   # azzurro, giallo, verde


def id_google(doc_id):
    """ID evento Google (ammessi solo 0-9 a-v): derivato dall'ID del documento, sempre lo stesso."""
    return "pc" + hashlib.sha1(doc_id.encode("utf-8")).hexdigest()[:30]


def _data_ok(s):
    try:
        return datetime.strptime(str(s), "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None


def _ora_ok(s):
    try:
        return datetime.strptime(str(s), "%H:%M").time()
    except (ValueError, TypeError):
        return None


def corpo_evento(doc_id, e):
    """Evento Google a partire dal documento dell'app. None se il documento non e' valido."""
    d0 = _data_ok(e.get("data"))
    if not d0:
        return None
    d1 = _data_ok(e.get("dataFine")) or d0
    if d1 < d0:
        d1 = d0
    tipo = e.get("tipo") or "Evento"
    titolo = str(e.get("titolo") or "").strip() or tipo
    o0, o1 = _ora_ok(e.get("ora")), _ora_ok(e.get("oraFine"))
    tutto = bool(e.get("tuttoGiorno")) or o0 is None
    if tutto:
        inizio = {"date": d0.isoformat()}
        fine = {"date": (d1 + timedelta(days=1)).isoformat()}      # in Google la data finale e' esclusa
    else:
        a = datetime.combine(d0, o0)
        fine_giorno = datetime.combine(d1, datetime.strptime("23:59", "%H:%M").time())
        b = datetime.combine(d1, o1) if o1 else min(a + timedelta(hours=1), fine_giorno if d1 == d0 else a + timedelta(hours=1))
        if b <= a:
            b = min(a + timedelta(hours=1), datetime.combine(d0, datetime.strptime("23:59", "%H:%M").time()))
        inizio = {"dateTime": a.strftime("%Y-%m-%dT%H:%M:00"), "timeZone": TZ}
        fine = {"dateTime": b.strftime("%Y-%m-%dT%H:%M:00"), "timeZone": TZ}
    note = str(e.get("note") or "").strip()
    campi = {
        "summary": f"[{tipo}] {titolo}",
        "location": str(e.get("luogo") or "").strip(),
        "description": note,
        "start": inizio,
        "end": fine,
        "colorId": COLORI.get(tipo, "8"),
        "reminders": {"useDefault": True},
    }
    impronta = hashlib.sha1(json.dumps(campi, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
    campi["status"] = "confirmed"
    campi["extendedProperties"] = {"private": {"pcSync": "1", "pcDoc": doc_id, "pcHash": impronta}}
    return campi


def calcola_azioni(eventi, esistenti, consenti_svuota=False):
    """
    eventi:    {doc_id: dict} dall'app.   esistenti: {id_google: evento Google} gia' sincronizzati.
    Ritorna (crea, aggiorna, elimina, saltati): liste di (id_google, corpo) / id_google.
    """
    crea, aggiorna, saltati, voluti = [], [], [], set()
    for doc_id, e in sorted(eventi.items()):
        corpo = corpo_evento(doc_id, e)
        gid = id_google(doc_id)
        if corpo is None:
            saltati.append(doc_id)
            continue
        voluti.add(gid)
        if gid not in esistenti:
            crea.append((gid, corpo))
            continue
        priv = (esistenti[gid].get("extendedProperties") or {}).get("private") or {}
        if priv.get("pcHash") != corpo["extendedProperties"]["private"]["pcHash"] or esistenti[gid].get("status") == "cancelled":
            aggiorna.append((gid, corpo))
    elimina = [g for g, ev in esistenti.items() if g not in voluti and ev.get("status") != "cancelled"]
    # salvaguardia: se l'app risulta vuota ma in Google ci sono molti eventi, probabilmente e' un errore di lettura
    if elimina and not voluti and len(elimina) > 3 and not consenti_svuota:
        print(f"ATTENZIONE: nell'app non risulta nessun evento ma in Google ce ne sono {len(elimina)}: non cancello nulla "
              "(impostare CONSENTI_SVUOTA=true se e' voluto).")
        elimina = []
    return crea, aggiorna, elimina, saltati


def _testo_ics(t):
    return str(t or "").replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\r\n", "\\n").replace("\n", "\\n")


def _piega(riga):
    out = []
    b = riga.encode("utf-8")
    while len(b) > 74:                       # righe lunghe al massimo 75 byte, continuate con uno spazio
        taglio = 74
        while taglio > 0 and (b[taglio] & 0xC0) == 0x80:
            taglio -= 1
        out.append(b[:taglio].decode("utf-8"))
        b = b" " + b[taglio:]
    out.append(b.decode("utf-8"))
    return out


def _stamp(e):
    """DTSTAMP stabile (dall'ultima modifica dell'evento): se nulla cambia il file resta identico e non si creano commit inutili."""
    for k in ("aggiornato", "modificato", "creato"):
        v = str(e.get(k) or "")
        if len(v) >= 19:
            try:
                return datetime.strptime(v[:19], "%Y-%m-%dT%H:%M:%S").strftime("%Y%m%dT%H%M%SZ")
            except ValueError:
                pass
    return "20260101T000000Z"


def genera_ics(eventi):
    R = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Protezione Civile Curtarolo//Calendario attivita//IT", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
         "X-WR-CALNAME:Protezione Civile Curtarolo", "X-WR-TIMEZONE:Europe/Rome", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H",
         "BEGIN:VTIMEZONE", "TZID:Europe/Rome", "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST", "DTSTART:19700329T020000",
         "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT", "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET",
         "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD", "END:VTIMEZONE"]
    for doc_id, e in sorted(eventi.items()):
        c = corpo_evento(doc_id, e)
        if c is None:
            continue
        st = _stamp(e)
        R += ["BEGIN:VEVENT", f"UID:{doc_id}@pc-curtarolo", f"DTSTAMP:{st}", f"LAST-MODIFIED:{st}"]
        if "date" in c["start"]:
            R += ["DTSTART;VALUE=DATE:" + c["start"]["date"].replace("-", ""), "DTEND;VALUE=DATE:" + c["end"]["date"].replace("-", "")]
        else:
            R += ["DTSTART;TZID=Europe/Rome:" + c["start"]["dateTime"].replace("-", "").replace(":", ""),
                  "DTEND;TZID=Europe/Rome:" + c["end"]["dateTime"].replace("-", "").replace(":", "")]
        R.append("SUMMARY:" + _testo_ics(c["summary"]))
        if c["location"]:
            R.append("LOCATION:" + _testo_ics(c["location"]))
        if c["description"]:
            R.append("DESCRIPTION:" + _testo_ics(c["description"]))
        R += ["CATEGORIES:" + str(e.get("tipo") or "Evento").upper(), "END:VEVENT"]
    R.append("END:VCALENDAR")
    return "\r\n".join(r2 for r in R for r2 in _piega(r)) + "\r\n"


class GoogleCalendar:
    def __init__(self, info):
        from google.oauth2 import service_account
        from google.auth.transport.requests import AuthorizedSession
        cred = service_account.Credentials.from_service_account_info(info, scopes=["https://www.googleapis.com/auth/calendar"])
        self.s = AuthorizedSession(cred)
        self.url = API + CAL_ID.replace("@", "%40") + "/events"

    def _chiama(self, metodo, url, **kw):
        r = self.s.request(metodo, url, timeout=30, **kw)
        if r.status_code == 403 and "calendar" in r.text.lower() and "api" in r.text.lower() and "not been used" in r.text.lower():
            sys.exit("Google Calendar API non abilitata nel progetto Firebase/Google Cloud: vedi LEGGIMI.md (passo 1).")
        return r

    def elenco(self):
        out, token = {}, None
        while True:
            par = {"privateExtendedProperty": "pcSync=1", "showDeleted": "true", "maxResults": 2500}
            if token:
                par["pageToken"] = token
            r = self._chiama("GET", self.url, params=par)
            if r.status_code == 404:
                sys.exit("Calendario non trovato: controlla GOOGLE_CALENDAR_ID e che sia condiviso con l'account di servizio.")
            if r.status_code in (401, 403):
                sys.exit(f"Accesso al calendario negato ({r.status_code}): condividilo con l'email dell'account di servizio "
                         f"con il permesso «Apporta modifiche agli eventi». Dettaglio: {r.text[:200]}")
            r.raise_for_status()
            j = r.json()
            for ev in j.get("items", []):
                out[ev["id"]] = ev
            token = j.get("nextPageToken")
            if not token:
                return out

    def crea(self, gid, corpo):
        r = self._chiama("POST", self.url, json=dict(corpo, id=gid))
        if r.status_code == 409:                       # esiste (anche se cancellato): lo si aggiorna e si riattiva
            return self.aggiorna(gid, corpo)
        r.raise_for_status()

    def aggiorna(self, gid, corpo):
        r = self._chiama("PUT", f"{self.url}/{gid}", json=dict(corpo, id=gid))
        r.raise_for_status()

    def elimina(self, gid):
        r = self._chiama("DELETE", f"{self.url}/{gid}")
        if r.status_code not in (200, 204, 404, 410):
            r.raise_for_status()


def leggi_eventi_app(info):
    import firebase_admin
    from firebase_admin import credentials, firestore
    firebase_admin.initialize_app(credentials.Certificate(info))
    db = firestore.client()
    return {d.id: d.to_dict() for d in db.collection("calendario_eventi").stream()}


def sincronizza(eventi, gc, prova=False, consenti_svuota=False):
    esistenti = gc.elenco()
    crea, aggiorna, elimina, saltati = calcola_azioni(eventi, esistenti, consenti_svuota)
    for d in saltati:
        print(f"Saltato (dati non validi): {d}")
    print(f"App: {len(eventi)} eventi | Google: {len(esistenti)} | da creare {len(crea)}, da aggiornare {len(aggiorna)}, da eliminare {len(elimina)}")
    if prova:
        for g, c in crea:
            print("  + ", c["summary"], c["start"])
        for g, c in aggiorna:
            print("  ~ ", c["summary"], c["start"])
        for g in elimina:
            print("  - ", g)
        return 0
    errori = 0
    for g, c in crea:
        try: gc.crea(g, c)
        except Exception as x: errori += 1; print("Errore creazione:", c["summary"], x)
    for g, c in aggiorna:
        try: gc.aggiorna(g, c)
        except Exception as x: errori += 1; print("Errore aggiornamento:", c["summary"], x)
    for g in elimina:
        try: gc.elimina(g)
        except Exception as x: errori += 1; print("Errore eliminazione:", g, x)
    return errori


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prova", action="store_true", help="mostra cosa farebbe su Google Calendar senza modificarlo")
    ap.add_argument("--ics", metavar="FILE", help="scrive solo il file .ics (nessuna sincronizzazione con Google)")
    a = ap.parse_args()
    if not os.environ.get("FIREBASE_SERVICE_ACCOUNT"):
        sys.exit("Manca FIREBASE_SERVICE_ACCOUNT")
    info = json.loads(os.environ["FIREBASE_SERVICE_ACCOUNT"])
    eventi = leggi_eventi_app(info)
    if a.ics:
        os.makedirs(os.path.dirname(os.path.abspath(a.ics)), exist_ok=True)
        with open(a.ics, "w", encoding="utf-8", newline="") as f:
            f.write(genera_ics(eventi))
        print(f"Scritto {a.ics}: {len(eventi)} eventi")
        return
    if not CAL_ID:
        sys.exit("Manca GOOGLE_CALENDAR_ID (variabile del repository: Settings > Secrets and variables > Actions > Variables)")
    print("Account di servizio:", info.get("client_email"))
    errori = sincronizza(eventi, GoogleCalendar(info), a.prova, os.environ.get("CONSENTI_SVUOTA", "").lower() == "true")
    sys.exit(1 if errori else 0)


if __name__ == "__main__":
    main()
