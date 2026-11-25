#!/usr/bin/env bash
# Collega (o scollega) il runner a una VPN WireGuard con uscita in Italia.
# Serve perche' il sito della Regione Veneto risponde solo a indirizzi italiani.
#   scripts/vpn-italia.sh su      collega, se e' presente la configurazione nella variabile WG_CONF
#                                 (WG_CONF_2, facoltativa: configurazione di riserva, provata se la prima non passa traffico)
#   scripts/vpn-italia.sh giu     scollega
# Senza la configurazione (segreto non impostato) non fa nulla e il flusso prosegue come prima.
# Ogni comando ha un tempo massimo e, se il tunnel non passa traffico, viene spento subito:
# con tutto il traffico nel tunnel una VPN che non risponde taglierebbe fuori anche il runner da GitHub
# e l'esecuzione resterebbe bloccata. In ogni caso di problema si prosegue con la rete di GitHub.
set -u
AZIONE="${1:-su}"
INIZIO=$SECONDS
# Le righe scritte mentre il tunnel e' aperto possono andare perse nel log di GitHub (il traffico del runner passa dalla VPN):
# si salvano anche in un file e il passo «Scollega la VPN», a tunnel chiuso, le ristampa tutte.
LOG=/tmp/vpn-italia.log
dire() { echo "$*"; echo "$*" >> "$LOG" 2>/dev/null || true; }
fase() { dire "  [VPN +$((SECONDS - INIZIO))s] $*"; }

if [ "$AZIONE" = "giu" ]; then
  if sudo -n true 2>/dev/null && ip link show wg0 >/dev/null 2>&1; then
    T="$(sudo wg show wg0 transfer 2>/dev/null | awk '{print "ricevuti " $2 " byte, inviati " $3 " byte"}' | head -n1)"
    [ -n "${T:-}" ] && dire "  traffico nel tunnel: $T"
    timeout 20 sudo wg-quick down wg0 >/dev/null 2>&1 || sudo ip link delete wg0 >/dev/null 2>&1 || true
    dire "VPN scollegata."
  fi
  if [ -s "$LOG" ]; then
    echo "--- Riepilogo della VPN di questa esecuzione ---"
    sed 's/^::warning:://' "$LOG"
    rm -f "$LOG"
  fi
  exit 0
fi

if [ -z "${WG_CONF:-}" ] && [ -z "${WG_CONF_2:-}" ]; then
  echo "VPN italiana non configurata: si usa la rete di GitHub."
  exit 0
fi

spegni() { timeout 20 sudo wg-quick down wg0 >/dev/null 2>&1 || sudo ip link delete wg0 >/dev/null 2>&1 || true; }

dire "Collego la VPN italiana..."
if ! command -v wg-quick >/dev/null 2>&1 || ! command -v resolvconf >/dev/null 2>&1; then
  # DPkg::Lock::Timeout: se il runner sta ancora facendo aggiornamenti si attende al massimo 30 s
  export DEBIAN_FRONTEND=noninteractive
  timeout 120 sudo apt-get -o DPkg::Lock::Timeout=30 install -y -qq wireguard-tools resolvconf >/dev/null 2>&1 \
    || { dire "::warning::Installazione di WireGuard non riuscita o troppo lenta: si continua senza VPN."; exit 0; }
  fase "pacchetti installati"
else
  fase "pacchetti gia' presenti"
fi

# paese di uscita: prima per indirizzo IP (senza DNS, che subito dopo l'apertura puo' non essere pronto), poi con un secondo servizio
paese() {
  local p
  p="$(curl -s -m 6 https://1.1.1.1/cdn-cgi/trace 2>/dev/null | sed -n 's/^loc=//p' | tr -d '[:space:]')"
  case "$p" in [A-Z][A-Z]) echo "$p"; return ;; esac
  p="$(curl -s -m 6 https://ipinfo.io/country 2>/dev/null | tr -d '[:space:]')"
  case "$p" in [A-Z][A-Z]) echo "$p" ;; esac
}

# prova una configurazione: ritorna 0 se il tunnel e' aperto e passa traffico, altrimenti lo spegne e ritorna 1
# $1 = testo della configurazione, $2 = nome (per il log), $3 = tentativi del controllo della rete
PAESE=""
prova() {
  local conf="$1" nome="$2" tent="$3" tmp h ok=0 t
  tmp="$(mktemp)"
  umask 077
  printf '%s\n' "$conf" > "$tmp"
  # il DNS della VPN deve esserci, altrimenti con tutto il traffico nel tunnel i nomi non si risolvono
  grep -qiE '^[[:space:]]*DNS[[:space:]]*=' "$tmp" || sed -i '0,/^\[Interface\]/s//[Interface]\nDNS = 1.1.1.1/' "$tmp"
  # mantiene vivo il collegamento dietro il NAT del runner
  grep -qiE '^[[:space:]]*PersistentKeepalive' "$tmp" || sed -i '0,/^\[Peer\]/s//[Peer]\nPersistentKeepalive = 25/' "$tmp"
  sudo install -m 600 "$tmp" /etc/wireguard/wg0.conf
  rm -f "$tmp"
  if ! timeout 30 sudo wg-quick up wg0 >/dev/null 2>&1; then
    spegni; fase "$nome: tunnel non aperto (tempo scaduto o errore)"; return 1
  fi
  fase "$nome: tunnel aperto"
  # il tunnel deve scambiare dati davvero: si attende l'handshake (al massimo 12 s)
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    h="$(sudo wg show wg0 latest-handshakes 2>/dev/null | awk '{print $2}' | head -n1)"
    if [ -n "${h:-}" ] && [ "$h" != "0" ]; then ok=1; break; fi
    sleep 1
  done
  if [ "$ok" != "1" ]; then spegni; fase "$nome: nessun handshake"; return 1; fi
  fase "$nome: handshake riuscito"
  # 3 tentativi (2 se c'e' una riserva) a distanza di 4 s prima di dichiarare il tunnel inutilizzabile
  for t in $(seq 1 "$tent"); do
    PAESE="$(paese)"
    [ -n "$PAESE" ] && return 0
    fase "$nome: controllo della rete senza risposta (tentativo $t di $tent)"
    [ "$t" != "$tent" ] && sleep 4
  done
  spegni; return 1
}

N=0; [ -n "${WG_CONF:-}" ] && N=$((N + 1)); [ -n "${WG_CONF_2:-}" ] && N=$((N + 1))
TENT=3; [ "$N" -gt 1 ] && TENT=2
RIUSCITA=""
if [ -n "${WG_CONF:-}" ] && prova "$WG_CONF" "VPN principale" "$TENT"; then
  RIUSCITA="principale"
elif [ -n "${WG_CONF_2:-}" ]; then
  [ -n "${WG_CONF:-}" ] && dire "La VPN principale non passa traffico: provo la configurazione di riserva."
  prova "$WG_CONF_2" "VPN di riserva" "$TENT" && RIUSCITA="di riserva"
fi
if [ -z "$RIUSCITA" ]; then
  dire "::warning::Nessuna VPN passa traffico: scollegata, si continua con la rete di GitHub."
  exit 0
fi
dire "VPN collegata ($RIUSCITA). Paese di uscita: ${PAESE} (in ${SECONDS}s dall'avvio dello script)"
if [ "${PAESE}" != "IT" ]; then
  dire "::warning::L'uscita della VPN non risulta in Italia (${PAESE}): scegli un server italiano."
fi
# solo informativo: il sito della Regione risponde da questa uscita? (000 = nessuna risposta)
RC="$(curl -s -m 10 -o /dev/null -w '%{http_code}' https://www.regione.veneto.it/web/protezione-civile/cfd 2>/dev/null)"
fase "sito della Regione Veneto: HTTP ${RC:-000}"
exit 0
