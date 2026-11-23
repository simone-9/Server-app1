"""Prove della lettura di riserva dal bollettino nazionale (DPC). Si lancia con: python prove/monitor_riserva_dpc_test.py"""
import os, sys, types
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "monitor-allerte"))
import monitor_allerte as m

NESSUNA = "Assenza di fenomeni significativi prevedibili / NESSUNA ALLERTA"


def geo(idr=NESSUNA, idg=NESSUNA, tem=NESSUNA, comuni=("Curtarolo", "Padova")):
    return {"features": [
        {"properties": {"Per rischio idraulico": NESSUNA, "Per rischio temporali": NESSUNA, "Per rischio idrogeologico": NESSUNA, "Nome zona": "Altra", "Comuni": ["Belluno"]}},
        {"properties": {"Per rischio idraulico": idr, "Per rischio temporali": tem, "Per rischio idrogeologico": idg, "Nome zona": "Pianura centrale", "Comuni": list(comuni)}}]}


def prova(oggi, domani, prima=None, regionale=None, sigla="20261123_1430"):
    A = m.ArchivioMemoria()
    if prima: A.scrivi("cfd_stato/notifiche", {"firme": prima})
    if regionale: A.scrivi("cfd_stato/monitor", {"ultimaEmissione": regionale})
    msgs = []
    m.ultimo_bollettino_dpc = lambda: sigla
    m.scarica_dpc = lambda s, q: oggi if q == "today" else domani
    n = m.riserva_dpc(A, lambda t: msgs.append(t) or True)
    return A, n, msgs


def ok(c, t):
    print(("OK   " if c else "FAIL ") + t)
    if not c: ok.fail = True
ok.fail = False

# 1) arancione domani -> scritto + Telegram; oggi verde -> non scritto
A, n, msgs = prova(geo(), geo(idg="Moderata / ALLERTA ARANCIONE"))
r = A.liste.get("allerte_cfd_veneto", [])
ok(n == 1 and len(r) == 1 and r[0]["livello"] == "ARANCIONE" and r[0]["data"] == "24/11/2026" and r[0]["giorno"] == "DOMANI", "arancione domani registrato, verde oggi ignorato")
ok(len(msgs) == 1 and "ALLERTA ARANCIONE" in msgs[0] and "senza vento" in msgs[0], "Telegram con avviso sulla fonte di riserva")
ok(A.doc["cfd_stato/dpc"]["ultimo"] == "20261123_1430", "bollettino segnato come visto")

# 2) gialla: registrata ma niente Telegram
A, n, msgs = prova(geo(tem="Ordinaria / ALLERTA GIALLA"), geo())
ok(n == 1 and not msgs and A.liste["allerte_cfd_veneto"][0]["livello"] == "GIALLA", "gialla registrata senza Telegram")

# 3) tutto verde: non scrive nulla (mai verde dalla riserva)
A, n, msgs = prova(geo(), geo())
ok(n == 0 and "allerte_cfd_veneto" not in A.liste and not msgs, "tutto verde: nessuna scrittura")

# 4) livello gia' noto uguale o piu' alto: non abbassa e non ripete
A, n, msgs = prova(geo(idr="Ordinaria / ALLERTA GIALLA"), geo(), prima={"23/11/2026": "ARANCIONE|vento:ARANCIONE"})
ok(n == 0 and not msgs, "non abbassa un livello regionale piu' alto")

# 5) documento regionale piu' recente: non serve
A, n, msgs = prova(geo(idg="Elevata / ALLERTA ROSSA"), geo(), regionale="2026-11-23T14:50:00+01:00")
ok(n == 0 and not msgs, "regionale piu' recente: riserva non usata")

# 6) stesso bollettino gia' letto: non lo rilegge
A = m.ArchivioMemoria(); A.scrivi("cfd_stato/dpc", {"ultimo": "20261123_1430"})
scaricati = []
m.ultimo_bollettino_dpc = lambda: "20261123_1430"; m.scarica_dpc = lambda s, q: scaricati.append(q)
ok(m.riserva_dpc(A) == 0 and not scaricati, "bollettino gia' visto: niente download")

# 7) comune non presente: nessuna eccezione, nessuna scrittura
A, n, msgs = prova(geo(comuni=("Padova",), idg="Elevata / ALLERTA ROSSA"), geo(comuni=("Padova",)))
ok(n == 0 and "allerte_cfd_veneto" not in A.liste, "comune non trovato: niente scritto, nessun errore")

# 8) testo del livello sconosciuto: non scrive
A, n, msgs = prova(geo(idr="boh"), geo())
ok(n == 0 and "allerte_cfd_veneto" not in A.liste, "livello illeggibile: niente scritto")

# 9) dal ramo errore di esegui(): scatta solo dopo le soglie
import requests
requests.get = lambda *a, **k: (_ for _ in ()).throw(requests.ConnectTimeout("x"))
os.environ["PAUSE_RIPROVA"] = "0,0"
chiamate = []
m.riserva_dpc = lambda a, i=None: chiamate.append(1)
A = m.ArchivioMemoria()
for k in range(3): m.esegui(A, lambda t: True)
ok(len(chiamate) == 1, "la riserva parte al terzo controllo fallito di fila (non prima)")
sys.exit(1 if ok.fail else 0)
