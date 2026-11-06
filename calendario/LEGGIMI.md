> **Nota:** questi file ora sono nella cartella `calendario/` del repository Server-app1 (il flusso è `.github/workflows/calendario.yml`); l'indirizzo pubblico diventa `https://simone-9.github.io/Server-app1/calendario.ics` dopo aver attivato GitHub Pages sul ramo `gh-pages`.

# Configurazione (una volta sola)

## 1. Caricare i file
Copia nel repository tutti i file di questa cartella, mantenendo le cartelle (anche `.github/workflows/`):
`sync_calendario_google.py`, `requirements_calendario.txt`, `pagina/index.html`, `.gitignore`, `README.md`, `LEGGIMI.md`,
`.github/workflows/calendario.yml`.
(Su github.com: *Add file → Upload files*; la cartella nascosta `.github` va caricata trascinando l'intera cartella.)

## 2. Segreto per leggere i dati dell'app
*Settings → Secrets and variables → Actions → New repository secret*
- Nome: `FIREBASE_SERVICE_ACCOUNT`
- Valore: il contenuto del file JSON dell'account di servizio (lo stesso già usato dal monitor allerte).

## 3. Primo avvio
*Actions → «Calendario (file .ics e Google Calendar)» → Run workflow.*
Al termine nel repository compare il branch `gh-pages` con il file `calendario.ics`.
(Se la scheda Actions chiede di abilitare i workflow, abilitali. In *Settings → Actions → General → Workflow permissions* scegli «Read and write permissions».)

## 4. Attivare GitHub Pages
*Settings → Pages → Build and deployment → Source: «Deploy from a branch» → Branch: `gh-pages`, cartella `/ (root)` → Save.*
Dopo un minuto il calendario è all'indirizzo:

    https://simone-9.github.io/Server-app1/calendario.ics

e la pagina con il pulsante di abbonamento a `https://simone-9.github.io/Server-app1/`.
L'app usa già questo indirizzo nel pulsante «Abbonati (Apple / Outlook)».

## 5. (Facoltativo) Google Calendar del gruppo
1. Google Cloud Console → progetto di Firebase → *API e servizi → Libreria* → «Google Calendar API» → **Abilita**.
2. Apri il JSON dell'account di servizio, copia `client_email` e condividi il calendario del gruppo con quell'email,
   permesso **«Apporta modifiche agli eventi»**.
3. Rendi il calendario visibile agli utenti (*Autorizzazioni di accesso → Rendi disponibile al pubblico*, con tutti i dettagli degli eventi).
4. Nel repository: *Settings → Secrets and variables → Actions → Variables → New repository variable*
   - Nome: `GOOGLE_CALENDAR_ID`
   - Valore: l'ID del calendario (nelle impostazioni del calendario, «Integra il calendario → ID calendario»; finisce con `@group.calendar.google.com`).
5. Prova: *Actions → Run workflow* con «Google Calendar: solo prova» spuntato; il log mostra cosa farebbe. Poi rilancia senza prova.

Senza la variabile `GOOGLE_CALENDAR_ID` la parte Google viene saltata e il file `.ics` funziona comunque.

## Promemoria push
Ogni evento del calendario viene ricordato la sera prima (dalle 18:00, ora di Roma) con una notifica sui dispositivi che hanno attivato le notifiche nell'app.
Chi ha risposto «Non ci sono» all'evento non riceve il promemoria. Ogni evento viene ricordato una sola volta per data.
Non serve configurare nulla (usa il segreto `FIREBASE_SERVICE_ACCOUNT`). **Nel repository Server-app1 questo vecchio promemoria è spento** (lo sostituisce «Calendario - notifiche push»); per riattivarlo: variabile del repository `PROMEMORIA_PUSH` = `true`;
per cambiare l'ora: variabile `PROMEMORIA_ORA` (es. `19`).
Prova: da terminale, `python promemoria_push.py --prova` mostra cosa invierebbe senza inviare nulla.

## Note
- Aggiornamento app → file: circa ogni 15 minuti (GitHub può ritardare le esecuzioni pianificate). Poi ogni programma di calendario ricarica il file con i propri tempi: Apple e Outlook in poche ore, Google Calendar (se ci si abbona a un `.ics`) anche 12–24 ore: per Google conviene il pulsante «Aggiungi a Google Calendar».
- Il file viene riscritto solo se gli eventi cambiano.
- Salvaguardia: se l'app risulta senza eventi ma in Google ce ne sono più di 3, lo script non cancella nulla (variabile `CONSENTI_SVUOTA=true` per forzare).
