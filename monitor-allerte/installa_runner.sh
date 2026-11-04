#!/usr/bin/env bash
# Installa il runner GitHub Actions su un Raspberry Pi (Raspberry Pi OS a 64 bit).
# Uso:  ./installa_runner.sh https://github.com/UTENTE/REPOSITORY TOKEN
# Il TOKEN si ottiene da GitHub: repository > Settings > Actions > Runners > New self-hosted runner
# (vale un'ora: va usato subito). Non eseguire come root: usa il tuo utente normale.
set -euo pipefail
URL="${1:?Manca indirizzo del repository}"; TOKEN="${2:?Manca il token}"; NOME="${3:-raspberry-allerte}"
[ "$(id -u)" -ne 0 ] || { echo "Non eseguire come root."; exit 1; }

sudo apt-get update
sudo apt-get install -y python3 python3-venv python3-pip git curl libxml2 libxslt1.1

case "$(uname -m)" in
  aarch64) PKG=linux-arm64 ;;
  armv7l)  PKG=linux-arm ;;
  x86_64)  PKG=linux-x64 ;;
  *) echo "Architettura non supportata: $(uname -m)"; exit 1 ;;
esac
VER=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | python3 -c "import sys,json;print(json.load(sys.stdin)['tag_name'].lstrip('v'))")

mkdir -p "$HOME/actions-runner" && cd "$HOME/actions-runner"
curl -fsSL -o runner.tar.gz "https://github.com/actions/runner/releases/download/v${VER}/actions-runner-${PKG}-${VER}.tar.gz"
tar xzf runner.tar.gz && rm runner.tar.gz
sudo ./bin/installdependencies.sh
./config.sh --unattended --url "$URL" --token "$TOKEN" --name "$NOME" --labels monitor-allerte --replace
sudo ./svc.sh install "$USER"
sudo ./svc.sh start
echo
echo "Fatto. Il runner parte da solo a ogni accensione. Controlla su GitHub: Settings > Actions > Runners (deve risultare Idle)."
echo "Prova la connessione alla Regione:"
curl -sS -o /dev/null -w "CFD: HTTP %{http_code} in %{time_total}s\n" --max-time 40 https://www.regione.veneto.it/web/protezione-civile/cfd || echo "CFD: non raggiungibile da questa connessione"
