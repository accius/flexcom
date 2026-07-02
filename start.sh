#!/usr/bin/env bash
# Run the bridge with a restart loop (macOS / Linux). The dashboard's
# Settings -> Restart button exits the process; this loop brings it back.
cd "$(dirname "$0")"

URL="http://localhost:8990"
( sleep 2
  command -v open >/dev/null 2>&1 && open "$URL" && exit
  command -v xdg-open >/dev/null 2>&1 && xdg-open "$URL"
) >/dev/null 2>&1 &

trap 'echo; echo "Bridge stopped."; exit 0' INT TERM
while true; do
  node bridge.js
  echo
  echo "Bridge stopped (settings restart, or crash) - restarting in 2s... Ctrl-C to quit."
  sleep 2
done
