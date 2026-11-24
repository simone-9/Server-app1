# VPN italiana per i workflow (alternativa al runner a casa)

## Perché
Il sito della Regione Veneto risponde solo a indirizzi italiani. I server di GitHub sono all'estero, quindi i controlli vanno in timeout. Con una VPN che esce in Italia i workflow raggiungono il sito senza altri cambiamenti.

## Cosa serve
- Un servizio VPN che fornisca **file di configurazione WireGuard** e abbia server in Italia (per esempio Mullvad, con server a Milano, o ProtonVPN a pagamento), oppure un tuo server WireGuard in Italia.
- **Due configurazioni diverse** (due "dispositivi" dello stesso abbonamento): una per il monitor allerte e una per l'idrometria. Le due esecuzioni possono sovrapporsi e la stessa chiave usata da due macchine nello stesso momento si disturba da sola.

## Attivazione
1. Dal servizio VPN scarica due file `.conf` WireGuard con un server in **Italia**.
2. Su GitHub: repository → **Settings → Secrets and variables → Actions → New repository secret**.
   - `WG_CONF` = tutto il contenuto del primo file (monitor allerte)
   - `WG_CONF_IDRO` = tutto il contenuto del secondo file (idrometria)
3. Avvia a mano **Actions → Monitoraggio allerte CFD Veneto → Run workflow** e apri il passo «Collega la VPN italiana»: deve scrivere `VPN collegata. Paese di uscita: IT`.
4. Se il passo scrive un avviso, il controllo prosegue comunque con la rete di GitHub (come prima).

## Da sapere
- Senza i segreti non cambia nulla: il passo si salta da solo.
- Il file di configurazione contiene una chiave privata: trattalo come una password, non incollarlo in chat né nel codice.
- Con la VPN passa tutto il traffico del controllo (compresi Firebase e Telegram): è normale.
- Per disattivare la VPN basta cancellare i due segreti.
- Se la VPN non si collega, il controllo parte lo stesso e il ripiego sul bollettino nazionale resta attivo.
