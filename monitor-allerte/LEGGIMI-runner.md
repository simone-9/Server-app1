# Runner sul Raspberry per il monitoraggio allerte

## Perché
La Regione Veneto non risponde ai server di GitHub (il controllo andava in timeout). Un piccolo computer di casa, con una normale connessione italiana, fa lo stesso lavoro: GitHub Actions continua a lanciare il controllo ogni 10 minuti, ma lo esegue sul Raspberry.

## Che scheda serve
- **Raspberry Pi** con Linux: va bene uno **Zero 2 W** (circa 20 euro), meglio un **Pi 3, 4 o 5**. Sistema: *Raspberry Pi OS Lite a 64 bit*.
- **Non va bene la Raspberry Pi Pico / Pico 2**: è un microcontrollore (520 KB di memoria, nessun Linux) e non può far girare il runner né Python con le librerie usate.
- Alimentatore originale, scheda microSD di buona qualità (meglio "high endurance") o un SSD USB, collegamento in rete fisso (cavo o Wi-Fi stabile). Deve restare sempre acceso.

## Prima di cominciare
1. Il repository su GitHub deve essere **privato**: un runner personale su un repository pubblico può eseguire codice altrui.
2. Verifica da un computer della stessa rete che la Regione risponda: apri https://www.regione.veneto.it/web/protezione-civile/cfd

## Installazione (circa 10 minuti)
1. Installa Raspberry Pi OS Lite 64 bit con *Raspberry Pi Imager* (imposta nome utente, password, Wi-Fi e SSH).
2. Su GitHub: repository → **Settings → Actions → Runners → New self-hosted runner**. Scegli Linux e ARM64 e copia il **token** (vale un'ora).
3. Dal Raspberry (anche via SSH) copia la cartella e lancia:
   ```
   chmod +x installa_runner.sh
   ./installa_runner.sh https://github.com/UTENTE/REPOSITORY IL_TOKEN
   ```
4. Sostituisci nel repository il file `.github/workflows/monitor-allerte.yml` con quello di questa cartella.
5. Su GitHub: **Actions → Monitoraggio allerte CFD Veneto → Run workflow**, con "Invia solo un messaggio di prova su Telegram" attivo, poi un avvio normale. Il runner deve comparire come **Idle** in Settings → Actions → Runners.

I segreti (FIREBASE_SERVICE_ACCOUNT, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) restano quelli già impostati su GitHub: non vanno copiati sul Raspberry.

## Da sapere
- Se il Raspberry è spento o senza rete, il controllo **non parte** e non arriva nemmeno l'avviso su Telegram (l'avviso nasce dall'esecuzione stessa). Il sistema ufficiale resta il bollettino della Regione: controlla l'indicatore dell'ultimo aggiornamento nell'app.
- Per sicurezza: cambia la password predefinita, tieni il sistema aggiornato (`sudo apt update && sudo apt upgrade`) e non esporre il Raspberry a internet.
- Per tornare a GitHub: rimetti `runs-on: ubuntu-latest` (e il vecchio blocco `setup-python`) nel workflow.
