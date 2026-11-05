# Server app · servizi automatici di Gestione Emergenze 2

Servizi che girano su GitHub Actions e parlano con il progetto Firebase `server-gestione-emergenze` (versione per più gruppi).
Ogni gruppo ha i suoi dati sotto `gruppi/<codice>/…`: tutti gli script leggono la variabile **`GRUPPO_ID`** e, se è impostata, usano quel percorso. Senza `GRUPPO_ID` usano i percorsi storici (senza gruppo).

| Servizio | Workflow | Script |
|---|---|---|
| Idrometria ARPAV, avvisi Telegram, push livelli e allerte CFD, registro eventi | `idrometria.yml` | `scripts/idro.mjs` |
| Push dei nuovi avvisi della bacheca | `bacheca-push.yml` | `scripts/bacheca-push.mjs` |
| Richieste agli enti (bozza con Groq, invio email) | `ente-mail.yml` | `scripts/ente-mail.mjs` |
| Lettura del bollettino CFD Veneto | `monitor-allerte.yml` | `monitor-allerte/monitor_allerte.py` |
| Eliminazione degli account di un gruppo cancellato da Firebase Authentication (avviata dall'app dal super admin, o a mano) | `elimina-account.yml` | `scripts/elimina-account.mjs` |
| Osservatorio, archivio, analisi (specifici del Brenta) | `osservatorio-*.yml`, `analisi-*.yml` | `scripts/…` |

`scripts/push.mjs` è il modulo comune per Firestore e per le notifiche push (Firebase Cloud Messaging): è lì che si applica `GRUPPO_ID`.

## Impostazioni (Settings → Secrets and variables → Actions)
**Segreti:** `FIREBASE_SERVICE_ACCOUNT` (chiave JSON dell'account di servizio del progetto Firebase), `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` (facoltativi), `SMTP_USER`, `SMTP_PASSWORD`, `GROQ_API_KEY` (richieste agli enti; con un provider diverso da Gmail anche le variabili `SMTP_HOST` e `SMTP_PORT`), `OSSERVATORIO_PASSWORD` (solo osservatorio).
**Variabili:** `GRUPPO_ID` (codice del gruppo, es. `curtarolo`), `COMUNE`, `CFD_ZONA`, `CFD_NOME_ZONA`, `NOME_GRUPPO`, `NOME_MITTENTE`.

**Impostazioni del gruppo da Firestore.** A ogni esecuzione gli script leggono `gruppi/<GRUPPO_ID>/impostazioni/gruppo`, cioè quello che il gruppo ha compilato in *Impostazioni gruppo* nell'app: comune, nome, zona CFD (e se è attiva), fiume e stazioni ARPAV (e se è attivo), «il gruppo usa Telegram». Quindi per un nuovo gruppo bastano `GRUPPO_ID` e `FIREBASE_SERVICE_ACCOUNT`; le variabili `COMUNE`, `CFD_ZONA`, `CFD_NOME_ZONA`, `NOME_GRUPPO`, `NOME_MITTENTE` restano come valori di riserva se le impostazioni non ci sono. Telegram parte solo se c'è il segreto `TELEGRAM_BOT_TOKEN` **e** l'ID della chat **e** nell'app è spuntato «usa Telegram». L'ID della chat lo scrive il gruppo nelle Impostazioni gruppo (campo «ID della chat»; ha la precedenza); in alternativa si può usare il segreto `TELEGRAM_CHAT_ID`. Il token non si scrive mai nell'app: con un bot solo è lo stesso segreto in tutti i repository. Per altri fiumi le stazioni sono quelle indicate nell'app (codice ARPAV); le stazioni extra e i pluviometri di `config/stazioni.json` valgono per il bacino del Brenta.

## Cosa sapere
- Un repository serve **un gruppo** (un `GRUPPO_ID`). Per un altro gruppo si copia il repository e si cambiano variabili e segreti.
- Le push delle allerte CFD le invia `idro.mjs` leggendo le allerte scritte dal monitor: nel monitor sono spente di proposito (`PUSH_DA_MONITOR=1` le riaccende) per non averle doppie.
- Telegram e push sono indipendenti: basta uno dei due. Senza segreti Telegram non parte nessun messaggio Telegram.
- Stazioni, soglie e zone meteo sono in `config/stazioni.json` (ora quelli del Brenta/Curtarolo).
- Il monitor CFD, se la Regione blocca gli indirizzi di GitHub, può girare su un runner a casa: `monitor-allerte/LEGGIMI-runner.md`.
- Richieste agli enti: `LEGGIMI-richieste-enti.md`; il logo nelle email è `assets/logo.png`.

---
# Idrometria Brenta · Protezione Civile Curtarolo

Ogni 10 minuti un piccolo programma su GitHub (GitHub Actions):

1. scarica i livelli ARPAV (file `Ultime48ore.xml`, licenza CC BY 4.0);
2. pubblica un file `idro.json` con le stazioni utili, che l'app legge (ramo `data` di questo archivio);
3. manda un messaggio **Telegram** quando **Barzizza** o **Limena** superano la soglia di guardia **G2** o **G3**, con stazione, livello, ora e link. Per ogni soglia l'avviso parte una volta sola; riparte se il livello rientra sotto la soglia (con un margine di 5 cm) e poi la supera di nuovo.

I dati ARPAV sono automatici e non validati: gli avvisi sono un aiuto per la sala operativa e non sostituiscono i bollettini ufficiali.

## Messa in funzione (una volta sola)

1. **Archivio.** Su GitHub crea un archivio **pubblico** (per esempio `idrometria-curtarolo`) e carica tutto il contenuto di questa cartella (anche la cartella nascosta `.github`). Pubblico serve perché l'app possa leggere i dati e perché i minuti di esecuzione sono gratuiti. Qui non c'è nulla di riservato: token e codici vanno nei *segreti*, mai nei file.
2. **Bot Telegram.** Su Telegram scrivi a **@BotFather**, invia `/newbot`, scegli nome e username. Ti dà un *token* (lungo, con i due punti): non condividerlo.
3. **Chat degli avvisi.** Crea un gruppo Telegram (o usa il tuo account), aggiungi il bot e scrivi un messaggio nel gruppo. Poi apri nel browser `https://api.telegram.org/bot<TOKEN>/getUpdates` (al posto di `<TOKEN>` il token) e cerca `"chat":{"id":...`: quel numero (per i gruppi è negativo, es. `-1001234567890`) è il *chat id*.
4. **Segreti.** In GitHub: archivio → Settings → Secrets and variables → Actions → *New repository secret*. Crea due segreti: `TELEGRAM_BOT_TOKEN` (il token) e `TELEGRAM_CHAT_ID` (il chat id).
5. **Permessi.** Settings → Actions → General → Workflow permissions → *Read and write permissions* → Save.
6. **Link delle stazioni.** Apri `config/stazioni.json` e i link ARPAV di Barzizza e Limena sono già inseriti; modificali solo se cambiano.
7. **Primo avvio.** Scheda *Actions* → *Idrometria Brenta* → *Run workflow*. Se va a buon fine compare il ramo `data` con `idro.json`.
8. **App.** Nell'app, scheda Idrometria → *Impostazioni della stima* → in «Indirizzo dati intermedio» scrivi:
   `https://raw.githubusercontent.com/<TUO-UTENTE>/<ARCHIVIO>/data/idro.json`

## Cose da sapere

- GitHub esegue i lavori programmati con qualche minuto di ritardo (a volte 10-20 minuti nei momenti di carico). Per questo l'app continua a leggere anche direttamente da ARPAV e, per gli avvisi urgenti, non è l'unica fonte da guardare.
- Se per 60 giorni non ci sono attività nell'archivio, GitHub sospende i lavori programmati: ogni tanto controlla la scheda *Actions* e, se serve, riattiva il flusso.
- Se ARPAV non risponde o non aggiorna i dati, nel registro del lavoro compare un avviso; non parte però alcun messaggio Telegram.
- Per cambiare soglie o stazioni di allerta: `config/stazioni.json` (`"allerta": true`).
- Prova senza inviare: `TELEGRAM_DRY_RUN=1 node scripts/idro.mjs`.
- **Messaggio di prova su Telegram**: scheda *Actions* → *Idrometria Brenta* → *Run workflow*, spunta *Invia un messaggio Telegram di PROVA* e avvia. Arrivano due messaggi (Barzizza e Limena) con il livello attuale, marcati come simulazione; lo stato degli avvisi reali non cambia.

## Bollettino di vigilanza meteorologica (pioggia)
Ad ogni esecuzione lo script cerca sulla pagina del CFD Veneto il bollettino BVM più recente, ne legge le classi di pioggia delle zone B2, B3, E1 (configurabili in `config/stazioni.json`) e le pubblica in `idro.json`. Se il bollettino non si legge, l'esecuzione non fallisce: l'app mostra l'ultimo letto con un avviso.

## Avvio con un servizio esterno di cron (cron-job.org)
La pianificazione interna di GitHub (`schedule`) può ritardare o saltare le esecuzioni. Un servizio esterno che chiama GitHub ogni 10 minuti è più puntuale.
Il flusso `Idrometria Brenta` si può già avviare dall'esterno (`workflow_dispatch`): non serve cambiare nulla nel codice. La pianificazione interna resta come riserva;
se due avvii arrivano insieme, il blocco `concurrency` del flusso li mette in fila.

### 1. Crea un token GitHub con il minimo dei permessi
1. GitHub → foto profilo → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token.
2. Nome: `cron idrometria`. Scadenza: la più lunga consentita (annotati la data per rinnovarlo).
3. Repository access: **Only select repositories** → solo `idrometria-brenta-curtarolo`.
4. Permissions → Repository permissions → **Actions: Read and write** (nient'altro).
5. Generate e copia il token (inizia per `github_pat_`). Non scriverlo in chat né nel codice: va solo nel servizio di cron.

### 2. Crea il lavoro su cron-job.org
1. Registrati su https://cron-job.org e crea un lavoro ("Create cronjob").
2. **URL**: `https://api.github.com/repos/simone-9/idrometria-brenta-curtarolo/actions/workflows/idrometria.yml/dispatches`
3. **Schedule**: ogni 10 minuti.
4. In *Advanced*:
   - Request method: **POST**
   - Headers (3 righe):
     - `Authorization`: `Bearer <il tuo token>`
     - `Accept`: `application/vnd.github+json`
     - `X-GitHub-Api-Version`: `2022-11-28`
   - Request body: `{"ref":"main"}`
   - Header `Content-Type`: `application/json`
5. Salva e premi "Test run": la risposta corretta è **HTTP 204** (nessun contenuto). Poi controlla in Actions che sia partita un'esecuzione con evento `workflow_dispatch`.
6. Attiva le notifiche di errore del lavoro: se il token scade o GitHub rifiuta la chiamata (401/403/404), cron-job.org ti avvisa.

### Codici di risposta
- 204: avvio accettato.
- 401/403: token sbagliato, scaduto o senza il permesso «Actions: Read and write».
- 404: nome del repository o del file `idrometria.yml` sbagliato, oppure il token non vede il repository.
- 422: il ramo indicato in `ref` non esiste.

### Da sapere
- I minuti di Actions dei repository pubblici sono gratuiti, quindi 144 avvii al giorno non hanno costo.
- Il token dà accesso solo alle Actions di questo repository, ma va trattato come una password: se pensi sia stato visto, revocalo da GitHub e creane uno nuovo.

## Archivio storico ARPAV (ramo `archivio`)
Ad ogni esecuzione, al massimo una volta ogni 6 ore, i dati ARPAV letti (livello e portata di ogni stazione, pioggia dei pluviometri) vengono aggiunti a file CSV mensili nel ramo `archivio`:
`dati/<id-stazione>/AAAA-MM.csv` (istante UTC, livello in m, portata in m³/s) e `dati/pioggia-<id>/AAAA-MM.csv` (pioggia cumulata giornaliera in mm). `indice.json` elenca i nomi delle stazioni.
Il file ARPAV contiene solo le ultime 48 ore, quindi basta che il flusso giri almeno una volta ogni 2 giorni per non perdere nulla. Serve a calibrare in futuro il tempo di viaggio della piena da Barzizza a Limena con piene reali.
**Osservatorio Alpi Orientali:** il gruppo sceglie il bacino (Adige, Brenta Bacchiglione, Lemene, Livenza, Piave, Tagliamento) in Impostazioni gruppo → Fiume e idrometria. Lo script mostra solo le stazioni di quel bacino: per «Brenta Bacchiglione» usa gli elenchi di `config/stazioni.json`, per gli altri bacini legge l'elenco dall'Osservatorio e tiene i livelli delle stazioni il cui nome comincia con il nome del fiume (per esempio «Piave a …»); i pluviometri di questi bacini si aggiungono in `osservatorio.bacini.<bacino>.pioggia` (gli id si trovano con il workflow «Elenco stazioni Osservatorio»). Servono i segreti `OSSERVATORIO_USER` e `OSSERVATORIO_PASSWORD`. **Scelta delle stazioni per provincia:** in Impostazioni gruppo → «Stazioni dell'Osservatorio» il gruppo sceglie livelli e pluviometri da un elenco filtrabile per provincia; le stazioni scelte valgono al posto del bacino. L'elenco lo prepara il workflow «Elenco stazioni Osservatorio» (avvio manuale, una volta al mese: scrive `config/osservatorio-stazioni.json`, che il workflow Idrometria pubblica accanto a `idro.json`). Va avviato una volta in ogni repository di gruppo.

I dati dell'Osservatorio non vengono archiviati (sono scaricabili a richiesta dal loro storico). I dati ARPAV sono CC BY 4.0 e quelli dell'Osservatorio delle Alpi Orientali sono rilasciati con la Italian Open Data License (IODL) v2.0 (vanno citati come fonte); sono dati automatici e non validati.

### Analisi dell'archivio
Actions → «Analisi archivio ARPAV» → Run workflow. Il log mostra la copertura dei dati, le piene trovate (salita ≥ 0,4 m a Barzizza) con il ritardo a Limena e, con almeno 5 piene utilizzabili, il tempo di viaggio e il coefficiente suggeriti per le «Impostazioni della stima» dell'app. Con meno piene dice di lasciare la stima spenta.


## Notifiche push dell'app (anche ad app chiusa)

Quando Barzizza o Limena superano **G1, G2 o G3** il servizio su GitHub invia una notifica push a tutti i dispositivi che hanno aperto l'app pubblicata e accettato le notifiche (indipendente dagli avvisi Telegram, che restano per G2 e G3). Funziona solo dall'app pubblicata in https (PWA o hosting), non dal file aperto in locale. Su iPhone solo dall'app aggiunta alla schermata Home (iOS 16.4 o successivo).

Una tantum, nella console Firebase del progetto:
1. **Impostazioni progetto → Cloud Messaging → Configurazione web → Certificati push web → Genera coppia di chiavi.** Copia la *chiave pubblica* e incollala nell'app: scheda Idrometria → Impostazioni della stima → «Notifiche push» → Salva.
2. **Impostazioni progetto → Account di servizio → Genera nuova chiave privata.** Si scarica un file JSON: incollane **tutto il contenuto** nel segreto GitHub `FIREBASE_SERVICE_ACCOUNT` (Settings → Secrets and variables → Actions). Non condividerlo e non metterlo in chat o nel repository: dà accesso al progetto.
3. Ripubblica le regole di `firestore.rules` (nuova raccolta `push_dispositivi`) e pubblica la nuova versione dell'app/PWA con `push-handler.js`.

Ogni utente, al primo tocco dopo l'accesso, vede la richiesta di consenso alle notifiche. Il lancio manuale con «prova_push» invia solo una notifica push di prova. I dispositivi non più validi vengono tolti da soli.

La push parte anche quando sale il livello dell'**allerta CFD** (zona E1) per oggi o domani: il servizio legge lo storico scritto dal monitoraggio automatico (raccolta `allerte_cfd_veneto`) e avvisa solo se il livello aumenta rispetto all'ultimo controllo.

## Registro automatico delle piene

A ogni esecuzione il servizio controlla Barzizza e Limena: una piena si apre quando una delle due supera G1 e si chiude dopo 6 ore sotto G1. Per ogni piena scrive in Firestore (raccolta `idro_eventi`) il picco e l'orario di ogni passaggio di soglia; a piena conclusa, se i due picchi sono ben distinti, calcola anche il tempo di viaggio da Barzizza a Limena e il coefficiente. L'app li mostra nella scheda Idrometria, li inserisce nel verbale e propone agli amministratori di usarli per attivare la stima. Serve il segreto `FIREBASE_SERVICE_ACCOUNT` e la regola `idro_eventi` in `firestore.rules` pubblicata.

## Licenza
Tutti i diritti riservati, © 2026 Simone Sabbadin: vedi il file `LICENSE`. Il servizio è offerto in abbonamento annuale ai gruppi di protezione civile e agli enti, secondo il contratto di licenza d'uso e servizio (salvo un accesso gratuito concesso per iscritto dall'autore). Copia, modifica e ridistribuzione richiedono il suo permesso scritto.
