#!/bin/bash
# FulgurMiner — control-panel launcher (macOS). Double-click in Finder.
# Starts the local control-panel server (if not already running) and opens it in
# your browser. Mining runs as a detached child of the server, so it keeps going
# even if you close this window.

# Resolve this script's own directory so it works wherever the repo is cloned.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="http://localhost:7311"
PORT=7311

# Make Homebrew node/npm resolvable when launched from Finder (minimal PATH).
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

cd "$REPO" || { echo "FulgurMiner repo not found at $REPO"; sleep 4; exit 1; }

port_listening() { lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; }

if port_listening; then
  echo "Control panel already running."
else
  echo "Starting FulgurMiner control panel..."
  nohup node gui/server.mjs > "$REPO/gui/server.log" 2>&1 &
  disown
  for _ in $(seq 1 12); do sleep 0.5; port_listening && break; done
fi

sleep 1
open "$URL"
echo "Opened $URL"
sleep 1
