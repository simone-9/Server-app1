#!/usr/bin/env bash
# Collega (o scollega) il runner a una VPN WireGuard con uscita in Italia.
# Serve perche' il sito della Regione Veneto risponde solo a indirizzi italiani.
#   scripts/vpn-italia.sh su      collega, se e' presente la configurazione nella variabile WG_CONF
#   scripts/vpn-italia.sh giu     scollega
# Senza la configurazione (segreto non impostato) non fa nulla e il flusso prosegue come prima.
# Ogni comando ha un tempo massimo e, se il tunnel non passa traffico, viene spento subito:
# con tutto il traffico nel tunnel una VPN che non risponde taglierebbe fuori anche il runner da GitHub
# e l'esecuzione resterebbe bloccata. In ogni caso di problema si prosegue con la rete di GitHub.
set -u
AZIONE="${1:-su}"
INIZIO=$SECONDS
fase() { echo "  [VPN +$((SECONDS - INIZIO))s] $*"; }

if [ "$AZIONE" = "giu" ]; then
  if sudo -n true 2>/dev/null && ip link show wg0 >/dev/null 2>&1; then
    timeout 20 sudo wg-quick down wg0 >/dev/null 2>&1 || sudo ip link delete wg0 >/dev/null 2>&1 || true
    echo "VPN scollegata."
  fi
  exit 0
fi

if [ -z "${WG_CONF:-}" ]; then
  echo "VPN italiana non configurata: si usa la rete di GitHub."
  exit 0
fi

spegni() { timeout 20 sudo wg-quick down wg0 >/dev/null 2>&1 || sudo ip link delete wg0 >/dev/null 2>&1 || true; }

echo "Collego la VPN italiana..."
if ! command -v wg-quick >/dev/null 2>&1 || ! command -v resolvconf >/dev/null 2>&1; then
  # DPkg::Lock::Timeout: se il runner sta ancora facendo aggiornamenti si attende al massimo 30 s
  export DEBIAN_FRONTEND=noninteractive
  timeout 120 sudo apt-get -o DPkg::Lock::Timeout=30 install -y -qq wireguard-tools resolvconf >/dev/null 2>&1 \
    || { echo "::warning::Installazione di WireGuard non riuscita o troppo lenta: si continua senza VPN."; exit 0; }
  fase "pacchetti installati"
else
  fase "pacchetti gia' presenti"
fi

TMP="$(mktemp)"
umask 077
printf '%s\n' "$WG_CONF" > "$TMP"
# il DNS della VPN deve esserci, altrimenti con tutto il traffico nel tunnel i nomi non si risolvono
grep -qiE '^[[:space:]]*DNS[[:space:]]*=' "$TMP" || sed -i '0,/^\[Interface\]/s//[Interface]\nDNS = 1.1.1.1/' "$TMP"
# mantiene vivo il collegamento dietro il NAT del runner
grep -qiE '^[[:space:]]*PersistentKeepalive' "$TMP" || sed -i '0,/^\[Peer\]/s//[Peer]\nPersistentKeepalive = 25/' "$TMP"
sudo install -m 600 "$TMP" /etc/wireguard/wg0.conf
rm -f "$TMP"

if ! timeout 30 sudo wg-quick up wg0 >/dev/null 2>&1; then
  spegni
  echo "::warning::VPN non collegata (tempo scaduto o errore): si continua con la rete di GitHub."
  exit 0
fi
fase "tunnel aperto"

# il tunnel deve scambiare dati davvero: si attende l'handshake (al massimo 12 s)
OK=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  H="$(sudo wg show wg0 latest-handshakes 2>/dev/null | awk '{print $2}' | head -n1)"
  if [ -n "${H:-}" ] && [ "$H" != "0" ]; then OK=1; break; fi
  sleep 1
done
if [ "$OK" != "1" ]; then
  spegni
  echo "::warning::La VPN non risponde (nessun handshake): scollegata, si continua con la rete di GitHub."
  exit 0
fi
fase "handshake riuscito"

# paese di uscita: prima per indirizzo IP (senza DNS, che subito dopo l'apertura puo' non essere pronto), poi con un secondo servizio;
# 3 tentativi a distanza di 4 s prima di dichiarare il tunnel inutilizzabile
paese() {
  local p
  p="$(curl -s -m 6 https://1.1.1.1/cdn-cgi/trace 2>/dev/null | sed -n 's/^loc=//p' | tr -d '[:space:]')"
  case "$p" in [A-Z][A-Z]) echo "$p"; return ;; esac
  p="$(curl -s -m 6 https://ipinfo.io/country 2>/dev/null | tr -d '[:space:]')"
  case "$p" in [A-Z][A-Z]) echo "$p" ;; esac
}
PAESE=""
for T in 1 2 3; do
  PAESE="$(paese)"
  [ -n "$PAESE" ] && break
  fase "controllo della rete: nessuna risposta (tentativo $T di 3)"
  [ "$T" != "3" ] && sleep 4
done
if [ -z "${PAESE:-}" ]; then
  spegni
  echo "::warning::Con la VPN non si raggiunge la rete: scollegata, si continua con la rete di GitHub."
  exit 0
fi
echo "VPN collegata. Paese di uscita: ${PAESE} (in ${SECONDS}s dall'avvio dello script)"
if [ "${PAESE}" != "IT" ]; then
  echo "::warning::L'uscita della VPN non risulta in Italia (${PAESE}): scegli un server italiano."
fi
exit 0
