#!/usr/bin/env python3
"""
Promemoria push degli eventi del calendario: la sera prima (dalle 18:00 ora di Roma) ogni dispositivo registrato
nell'app riceve «Domani: <tipo> - <titolo>, alle <ora>, <luogo>».

 * Chi ha risposto «Non ci sono» all'evento non riceve il promemoria di quell'evento.
 * Ogni evento viene ricordato una sola volta per data (registro nella raccolta Firestore «calendario_promemoria»);
   se l'evento cambia giorno, il promemoria si rimanda per la nuova data.

La notifica e' silenziosa (nessuna vibrazione ne' suono): il flag «silenzioso» e' gestito dal service worker dell'app.

Variabili d'ambiente: FIREBASE_SERVICE_ACCOUNT (obbligatoria), PROMEMORIA_ORA (predefinita 18).
Prova senza inviare nulla:  python promemoria_push.py --prova
"""
import argparse, json, os, sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Rome")


def da_ricordare(eventi, inviati, adesso, ora_invio=18):
    """[(doc_id, evento)] degli eventi che iniziano domani, se sono passate le ore di invio e non gia' ricordati per quella data."""
    if adesso.hour < ora_invio:
        return []
    domani = (adesso.date() + timedelta(days=1)).isoformat()
    return [(i, e) for i, e in sorted(eventi.items()) if e.get("data") == domani and inviati.get(i) != domani]


def testo_messaggio(e):
    tipo = str(e.get("tipo") or "Evento")
    titolo = str(e.get("titolo") or tipo).strip()
    dettagli = []
    if not e.get("tuttoGiorno") and e.get("ora"):
        dettagli.append("alle " + str(e["ora"]))
    if str(e.get("luogo") or "").strip():
        dettagli.append(str(e["luogo"]).strip())
    return f"Domani: {tipo}", titolo + (" - " + ", ".join(dettagli) if dettagli else "")


def invia_promemoria(eventi, adesioni, dispositivi, inviati, adesso, invia, rimuovi, ora_invio=18):
    """
    adesioni: [{eventoId, utente, stato}]   dispositivi: [{id, token, email}]
    invia(token, dati) -> True/False/"non_valido"      rimuovi(id_dispositivo)
    Ritorna {doc_id: data} degli eventi ricordati (da registrare come inviati).
    """
    fatti = {}
    for doc_id, e in da_ricordare(eventi, inviati, adesso, ora_invio):
        esclusi = {str(a.get("utente") or "").lower() for a in adesioni if a.get("eventoId") == doc_id and a.get("stato") == "no"}
        titolo, testo = testo_messaggio(e)
        destinatari = [d for d in dispositivi if str(d.get("email") or "").lower() not in esclusi]
        ok = 0
        for d in destinatari:
            r = invia(d["token"], {"titolo": titolo, "testo": testo, "tag": "cal-" + doc_id, "icona": "📅", "url": "./", "silenzioso": "1"})
            if r == "non_valido":
                rimuovi(d["id"])
            elif r:
                ok += 1
        print(f"{titolo}: {testo} -> {ok}/{len(destinatari)} dispositivi")
        if ok > 0 or not destinatari:           # se tutti gli invii falliscono si riprova alla prossima esecuzione
            fatti[doc_id] = e.get("data")
    return fatti


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prova", action="store_true", help="mostra cosa invierebbe senza inviare")
    a = ap.parse_args()
    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "")
    if not raw.strip():
        sys.exit("Manca FIREBASE_SERVICE_ACCOUNT")
    import firebase_admin
    from firebase_admin import credentials, firestore, messaging
    firebase_admin.initialize_app(credentials.Certificate(json.loads(raw)))
    db = firestore.client()
    ora_invio = int(os.environ.get("PROMEMORIA_ORA") or 18)
    adesso = datetime.now(TZ)
    eventi = {d.id: d.to_dict() for d in db.collection("calendario_eventi").stream()}
    inviati = {d.id: (d.to_dict() or {}).get("data") for d in db.collection("calendario_promemoria").stream()}
    if not da_ricordare(eventi, inviati, adesso, ora_invio):
        print("Nessun promemoria da inviare.")
        return
    adesioni = [d.to_dict() for d in db.collection("calendario_adesioni").stream()]
    dispositivi = [{"id": d.id, "token": (d.to_dict() or {}).get("token"), "email": (d.to_dict() or {}).get("email")} for d in db.collection("push_dispositivi").stream()]
    dispositivi = [d for d in dispositivi if d["token"]]

    def invia(token, dati):
        if a.prova:
            return True
        try:
            messaging.send(messaging.Message(token=token, data=dati,
                                             webpush=messaging.WebpushConfig(headers={"Urgency": "normal", "TTL": "43200"}),
                                             android=messaging.AndroidConfig(priority="normal")))
            return True
        except (messaging.UnregisteredError, firebase_admin.exceptions.InvalidArgumentError):
            return "non_valido"
        except Exception as x:
            print("::warning::Push non inviato:", str(x)[:160])
            return False

    def rimuovi(i):
        if not a.prova:
            db.collection("push_dispositivi").document(i).delete()

    fatti = invia_promemoria(eventi, adesioni, dispositivi, inviati, adesso, invia, rimuovi, ora_invio)
    if not a.prova:
        for i, data in fatti.items():
            db.collection("calendario_promemoria").document(i).set({"data": data, "inviatoIl": adesso.isoformat()})


if __name__ == "__main__":
    main()
