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

## Tailscale con il mini PC di casa come uscita (con ripiego sulla VPN)
Lo script `scripts/rete-italia.sh` prova nell'ordine: **1) Tailscale** con il mini PC come uscita, **2) VPN WireGuard** (i segreti `WG_CONF` / `WG_CONF_IDRO`), **3) la rete di GitHub**. Ogni uscita viene provata con una richiesta alla pagina della Regione: se non risponde (mini PC spento, senza rete, uscita non approvata) si passa alla successiva.

Segreti da aggiungere (Settings → Secrets and variables → Actions):
- `TS_AUTHKEY`: chiave di autenticazione di Tailscale (pannello Tailscale → Settings → Keys → Generate auth key; riutilizzabile, temporanea, pre-approvata).
- `TS_EXIT_NODE`: nome (o indirizzo 100.x.y.z) del mini PC su Tailscale.

Sul mini PC: installare Tailscale, avviarlo con `sudo tailscale up --advertise-exit-node`, abilitare l'inoltro IP (`echo 'net.ipv4.ip_forward = 1' | sudo tee /etc/sysctl.d/99-tailscale.conf && sudo sysctl -p /etc/sysctl.d/99-tailscale.conf`) e **approvare l'uscita** dal pannello Tailscale (Machines → il mini PC → Edit route settings → Use as exit node).

Senza i segreti di Tailscale tutto funziona come prima (VPN, poi rete di GitHub).
