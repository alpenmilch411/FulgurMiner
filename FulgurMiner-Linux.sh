#!/bin/bash
# FulgurMiner — control-panel launcher (Linux). Run it or double-click.
# Starts the local control-panel server (if not already running) and opens it in
# your browser. Mining runs as a detached child of the server, so it keeps going
# even if you close this terminal.
#
# Make executable once:  chmod +x FulgurMiner-Linux.sh

# Resolve this script's own directory, FOLLOWING SYMLINKS, so it works wherever
# the repo is cloned and even if the launcher is reached via a symlink.
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
REPO="$(cd -P "$(dirname "$SOURCE")" && pwd)"
URL="http://localhost:7311"
PORT=7311

cd "$REPO" || { echo "FulgurMiner repo not found at $REPO"; sleep 4; exit 1; }

port_listening() {
  if command -v ss >/dev/null 2>&1; then ss -ltn 2>/dev/null | grep -q ":$PORT "
  elif command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1
  else return 1; fi
}

if port_listening; then
  echo "Control panel already running."
else
  echo "Starting FulgurMiner control panel..."
  nohup node gui/server.mjs > "$REPO/gui/server.log" 2>&1 &
  disown
  for _ in $(seq 1 12); do sleep 0.5; port_listening && break; done
fi

sleep 1
# Open in the default browser (xdg-open, then gio as a fallback).
if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 &
elif command -v gio >/dev/null 2>&1; then gio open "$URL" >/dev/null 2>&1 &
else echo "Open $URL in your browser."; fi
echo "Opened $URL"
sleep 1
