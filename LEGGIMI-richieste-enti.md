# Richieste agli enti: bozza con Groq e invio dalla casella del gruppo

Cosa fa: nell'app (menu **Segnalazioni e richieste agli enti → Lettere agli enti**, solo Admin) descrivi il problema; un workflow GitHub chiede a Groq di scrivere la lettera; tu la rivedi e la correggi; premi **Invia** e la mail parte dalla casella Gmail del gruppo. Nessuna mail parte senza il tuo clic.

```
App (Admin) ──salva la richiesta──▶ Firestore «richieste_ente»
     │                                   ▲  ▲
     └─ avvia il workflow (solo azione + ID)   │  └─ bozza / esito scritti dallo script
                    ▼                          │
          GitHub Actions (repo privato) ───────┘
              ├─ bozza → Groq (solo ente, tipo, luogo, descrizione)
              └─ invia → Gmail (SMTP) con le foto in allegato
```

## 1. Repository privato
1. Su GitHub crea un repository **privato**, per esempio `ente-mail` (Private, senza README).
2. Carica il contenuto di questa cartella così com'è: le cartelle `.github`, `scripts` e `assets` (contiene `logo.png`, il logo che compare in fondo alla mail; va bene anche `logo.png` direttamente nella radice) devono stare nella radice del repository (da «Add file → Upload files»; se non vedi `.github` perché nascosta, trascina l'intera cartella).
3. Perché privato: i registri delle esecuzioni di un repo pubblico sono visibili a tutti. Lo script non scrive mai testi, indirizzi o nomi nei registri, ma il repo privato è una seconda barriera.

## 2. Groq
1. Registrati su console.groq.com con l'indirizzo del gruppo, con email e password (non «Accedi con Google»).
2. **API Keys → Create API Key**. Copia la chiave (`gsk_...`), non si rivede più.
3. **Data Controls → attiva «Zero Data Retention»** (così Groq non conserva nemmeno i log temporanei).

## 3. Gmail del gruppo (password per app)
1. Sull'account `protezione.civile.curtarolo@gmail.com` attiva la **verifica in due passaggi** (myaccount.google.com → Sicurezza). Scegli un telefono che non cambi con le persone e conserva i **codici di backup**.
2. Vai su myaccount.google.com/apppasswords, crea una password per app chiamata «Richieste enti». Copia le 16 lettere (senza spazi).
3. Se si cambia la password dell'account, le password per app vengono revocate: va rifatta e aggiornata nei segreti.

## 4. Chiave di Firestore
Serve la stessa chiave dell'account di servizio già usata per le notifiche push (segreto `FIREBASE_SERVICE_ACCOUNT` nel repo dell'idrometria). Se non la trovi: Console Firebase → Impostazioni progetto → Account di servizio → «Genera nuova chiave privata». Il file JSON va incollato per intero nel segreto.

## 5. Segreti del repository
Nel repository: **Settings → Secrets and variables → Actions → New repository secret**.

| Nome | Valore |
|---|---|
| `GROQ_API_KEY` | la chiave Groq (`gsk_...`) |
| `SMTP_USER` | `protezione.civile.curtarolo@gmail.com` |
| `SMTP_PASSWORD` | la password per app di 16 lettere |
| `FIREBASE_SERVICE_ACCOUNT` | tutto il JSON della chiave |

Facoltative, nella scheda **Variables**: `GROQ_MODEL` (modello preferito; se non esiste più lo script prova quelli di riserva), `NOME_MITTENTE` (nome mostrato al destinatario, predefinito «Protezione Civile Curtarolo»), `MAX_INVII_24H` (tetto di mail nelle 24 ore, predefinito 20).

## 6. Token per avviare il workflow dall'app
1. GitHub → foto profilo → Settings → Developer settings → Personal access tokens → **Fine-grained tokens → Generate new token**.
2. Repository access: **Only select repositories → ente-mail**.
3. Permissions → Repository permissions → **Actions: Read and write** (nient'altro).
4. Scadenza: il massimo consentito. Segnati la data: alla scadenza l'app mostrerà «Token GitHub non valido o scaduto» e basterà crearne uno nuovo.

## 7. Regole di Firestore
Pubblica il nuovo `firestore.rules` (aggiunge `richieste_ente` e `config_privata`, entrambe solo Admin) dalla Console Firebase → Firestore → Regole.

## 8. Nell'app
1. Menu **Segnalazioni e richieste agli enti → Lettere agli enti → Impostazioni invio**: proprietario (il tuo utente GitHub), repository (`ente-mail`), file `ente-mail.yml`, ramo `main` (o quello predefinito del repo), token. **Salva**.
2. **Prova il collegamento**, poi apri GitHub → Actions: dopo circa un minuto il registro deve dire «Firestore: accesso riuscito», «Groq: risposta ricevuta» e «Gmail: mail di prova inviata». Arriva anche una mail di prova alla casella del gruppo.
3. Poi **Nuova richiesta**: compila, «Salva e scrivi la bozza», aspetta la bozza, correggila, **Invia dalla casella del gruppo**.

## Cosa arriva a chi
- **A Groq**: ente, tipo di richiesta, luogo, descrizione, urgenza, eventuale comunicazione precedente. Telefoni, email, codici fiscali e IBAN nel testo vengono oscurati prima. I **nomi di persona scritti nella descrizione non si riconoscono automaticamente**: l'app lo avvisa, e per i riferimenti di persone usa il campo «Dati riservati».
- **Mai a Groq**: «Dati riservati», «Firma», foto. Vengono aggiunti alla lettera dopo.
- **Ai registri di GitHub**: solo l'ID della richiesta e l'esito (bozza pronta, inviata, errore).
- **All'ente**: la mail con il testo che hai visto e approvato, la firma (nome, qualifica, gruppo, indirizzo, «Inviato dalla sala operativa»), il logo del gruppo in fondo e le foto.

## Se qualcosa non va
| Messaggio nell'app | Cosa fare |
|---|---|
| Token GitHub non valido o scaduto | Crea un nuovo token (punto 6) e aggiornalo nelle Impostazioni invio |
| Il token non ha il permesso «Actions» | Ricontrolla il punto 6 (Actions: Read and write, repository giusto) |
| Repository o workflow non trovati | Controlla proprietario, nome del repo e `ente-mail.yml` |
| Il ramo indicato non esiste | Metti il nome esatto del ramo predefinito (spesso `main`) |
| Nessun modello Groq ha risposto / chiave Groq non valida | Controlla `GROQ_API_KEY`; in `GROQ_MODEL` metti un modello presente nella console Groq |
| Limite di richieste Groq raggiunto | Aspetta qualche minuto e premi «Riscrivi con l'AI» |
| Gmail ha rifiutato l'accesso | Password per app errata o revocata, oppure avviso di sicurezza di Google: apri la posta dell'account, conferma «Sì, ero io» e ripeti |
| Limite di 20 invii nelle ultime 24 ore | Alza `MAX_INVII_24H` oppure attendi |
| «Invio in corso» fermo da oltre 5 minuti | Controlla la posta inviata del gruppo: se la mail non c'è, usa «reimposta la richiesta» e riprova |

Se l'invio automatico non funziona, **«Apri in Gmail»** apre la posta con destinatario, oggetto e testo già pronti (le foto vanno aggiunte a mano); poi premi **«L'ho spedita io»** per segnare la richiesta come inviata.

## Tipo di richiesta e titolo
Nel modulo scegli il **tipo**: *Problema* (segnalazione di qualcosa che non va: il campo «Dove» è obbligatorio), *Generico* o *Altro* (richieste e comunicazioni in generale: «Dove» è facoltativo). Il **titolo** dice di cosa si tratta e guida l'AI.

## Collegamento con le segnalazioni
Dalla scheda di una segnalazione (pagina Segnalazioni agli enti) il pulsante **Lettera con AI** precompila la richiesta con ente, luogo, descrizione e foto. Dopo l'invio la segnalazione passa a «Inviata» (se era «Da inviare») oppure registra un sollecito.

## Limiti da sapere
- Il testo scritto dall'AI va sempre riletto: può sbagliare tono o dimenticare un dettaglio. Per questo la bozza è modificabile e l'invio richiede la tua conferma.
- Gmail consente circa 500 mail al giorno; l'app ne limita 20 nelle 24 ore (modificabile).
- Il modulo di posta (`nodemailer`) viene scaricato dal workflow a ogni esecuzione. In fase di sviluppo non ho potuto provarlo con un vero server Gmail: il pulsante **Prova il collegamento** del punto 8 serve proprio a verificarlo.
