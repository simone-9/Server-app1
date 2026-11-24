#!/usr/bin/env bash
# Collega (o scollega) il runner a una VPN WireGuard con uscita in Italia.
# Serve perche' il sito della Regione Veneto risponde solo a indirizzi italiani.
#   scripts/vpn-italia.sh su      collega, se e' presente la configurazione nella variabile WG_CONF
#   scripts/vpn-italia.sh giu     scollega
# Senza la configurazione (segreto non impostato) non fa nulla e il flusso prosegue come prima.
set -u
AZIONE="${1:-su}"

if [ "$AZIONE" = "giu" ]; then
  sudo wg-quick down wg0 >/dev/null 2>&1 && echo "VPN scollegata." || true
  exit 0
fi

if [ -z "${WG_CONF:-}" ]; then
  echo "VPN italiana non configurata: si usa la rete di GitHub."
  exit 0
fi

echo "Collego la VPN italiana..."
sudo apt-get install -y -qq wireguard-tools resolvconf >/dev/null 2>&1 || { echo "::warning::Installazione di WireGuard non riuscita: si continua senza VPN."; exit 0; }

TMP="$(mktemp)"
umask 077
printf '%s\n' "$WG_CONF" > "$TMP"
# il DNS della VPN deve esserci, altrimenti con tutto il traffico nel tunnel i nomi non si risolvono
grep -qiE '^[[:space:]]*DNS[[:space:]]*=' "$TMP" || sed -i '0,/^\[Interface\]/s//[Interface]\nDNS = 1.1.1.1/' "$TMP"
sudo install -m 600 "$TMP" /etc/wireguard/wg0.conf
rm -f "$TMP"

if ! sudo wg-quick up wg0 >/dev/null 2>&1; then
  echo "::warning::VPN non collegata: si continua con la rete di GitHub."
  exit 0
fi

PAESE="$(curl -s -m 15 https://ipinfo.io/country 2>/dev/null | tr -d '[:space:]')"
echo "VPN collegata. Paese di uscita: ${PAESE:-sconosciuto}"
if [ "${PAESE:-}" != "IT" ]; then
  echo "::warning::L'uscita della VPN non risulta in Italia (${PAESE:-?}): scegli un server italiano."
fi
exit 0
