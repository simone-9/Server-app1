#!/usr/bin/env bash
# Sceglie da dove far uscire il runner per raggiungere il sito della Regione Veneto (risponde solo a indirizzi italiani).
# Ordine: 1) Tailscale, con il mini PC di casa come uscita (exit node)   2) VPN WireGuard in Italia   3) rete di GitHub (come prima).
# Ogni uscita viene provata con una richiesta alla pagina della Regione: se non risponde si passa alla successiva.
#   scripts/rete-italia.sh su      collega
#   scripts/rete-italia.sh giu     scollega
# Segreti (tutti facoltativi): TS_AUTHKEY (chiave Tailscale), TS_EXIT_NODE (nome o indirizzo dell'uscita), WG_CONF (configurazione WireGuard).
set -u
AZIONE="${1:-su}"
PROVA_URL="${PROVA_URL:-https://www.regione.veneto.it/web/protezione-civile/cfd}"
DIR="$(cd "$(dirname "$0")" && pwd)"

raggiungibile() {   # il blocco della Regione si manifesta come timeout: qualunque risposta HTTP vale come "raggiungibile"
  local c; c="$(curl -s -o /dev/null -m 20 -w '%{http_code}' "$PROVA_URL" 2>/dev/null)"
  [ -n "$c" ] && [ "$c" != "000" ]
}

ts_giu() {
  command -v tailscale >/dev/null 2>&1 || return 0
  sudo tailscale set --exit-node= >/dev/null 2>&1 || true
  sudo tailscale logout >/dev/null 2>&1 || sudo tailscale down >/dev/null 2>&1 || true
}

if [ "$AZIONE" = "giu" ]; then
  ts_giu
  bash "$DIR/vpn-italia.sh" giu
  exit 0
fi

# ---- 1) Tailscale ----
if [ -n "${TS_AUTHKEY:-}" ] && [ -n "${TS_EXIT_NODE:-}" ]; then
  echo "Provo Tailscale con l'uscita di casa..."
  if ! command -v tailscale >/dev/null 2>&1; then
    curl -fsSL https://tailscale.com/install.sh 2>/dev/null | sudo sh >/dev/null 2>&1 || echo "::warning::Installazione di Tailscale non riuscita."
  fi
  if command -v tailscale >/dev/null 2>&1; then
    NOME="gh-$(printf '%s-%s' "${GITHUB_WORKFLOW:-job}" "${GITHUB_RUN_ID:-0}" | tr -c 'A-Za-z0-9' '-' | cut -c1-40)"
    if sudo tailscale up --authkey="${TS_AUTHKEY}?ephemeral=true&preauthorized=true" --hostname="$NOME" --accept-dns=false --timeout=40s >/dev/null 2>&1; then
      for i in 1 2 3 4; do   # l'elenco dei dispositivi può arrivare con un po' di ritardo
        sudo tailscale set --exit-node="$TS_EXIT_NODE" >/dev/null 2>&1 && break
        sleep 5
      done
      if raggiungibile; then
        echo "Tailscale collegato: il sito della Regione risponde."
        exit 0
      fi
      echo "::warning::Tailscale collegato ma il sito della Regione non risponde (mini PC spento o uscita non approvata?): passo alla VPN."
    else
      echo "::warning::Tailscale non collegato: passo alla VPN."
    fi
    ts_giu
  fi
else
  echo "Tailscale non configurato (servono TS_AUTHKEY e TS_EXIT_NODE)."
fi

# ---- 2) VPN WireGuard ----
if [ -n "${WG_CONF:-}" ]; then
  bash "$DIR/vpn-italia.sh" su
  if raggiungibile; then
    echo "VPN WireGuard: il sito della Regione risponde."
    exit 0
  fi
  echo "::warning::La VPN è collegata ma il sito della Regione non risponde: scollego e uso la rete di GitHub."
  bash "$DIR/vpn-italia.sh" giu
else
  echo "VPN WireGuard non configurata."
fi

# ---- 3) rete di GitHub ----
echo "Si usa la rete di GitHub (il sito della Regione potrebbe non rispondere)."
exit 0
