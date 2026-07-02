#!/usr/bin/env bash
# One-shot installer for Raspberry Pi (Pi OS Bookworm, 64-bit) / Debian / Ubuntu.
# Run from the repo root:  bash pi/install-pi.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ME="$(whoami)"

echo "== acom-flex-bridge Pi installer =="
echo "Repo: $REPO_DIR   User: $ME"

# 1. Node.js >= 18 (Pi OS Bookworm's apt node is 18, which is fine; prefer NodeSource 20 if absent)
if ! command -v node >/dev/null || [ "$(node -e 'console.log(parseInt(process.versions.node))')" -lt 18 ]; then
  echo "-- Installing Node.js 20 (NodeSource)..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "-- Node $(node -v)"

# 2. Dependencies
echo "-- npm install..."
cd "$REPO_DIR"
npm install --no-audit --no-fund

# 3. Serial port permissions
if ! id -nG "$ME" | grep -qw dialout; then
  echo "-- Adding $ME to the 'dialout' group (serial port access)..."
  sudo usermod -aG dialout "$ME"
  NEED_RELOGIN=1
fi

# 4. Show stable serial paths for config.json
echo
echo "-- Your USB-serial adapters (use THESE paths in config.json, not /dev/ttyUSB*):"
ls -1 /dev/serial/by-id/ 2>/dev/null | sed 's|^|     /dev/serial/by-id/|' || echo "     (none detected - plug the FTDI adapters in and re-run: ls /dev/serial/by-id/)"
echo
echo "   /dev/ttyUSB0 and /dev/ttyUSB1 can SWAP between boots when the adapters"
echo "   are identical; the by-id paths are tied to each adapter's serial number"
echo "   and never move. The dashboard Settings port dropdown lists them too."

# 5. systemd service (runs at boot, restarts on crash, powers the Settings->Restart button)
echo "-- Installing systemd service..."
sudo cp "$REPO_DIR/pi/acom-flex-bridge@.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable "acom-flex-bridge@$ME"
sudo systemctl restart "acom-flex-bridge@$ME"

echo
echo "== Done =="
echo "Dashboard:  http://$(hostname -I | awk '{print $1}'):8990   (or the Pi's ZeroTier address)"
echo "Logs:       journalctl -u acom-flex-bridge@$ME -f     (plus ./logs/ files)"
echo "Configure everything from the dashboard's gear icon, then Restart from there."
[ "${NEED_RELOGIN:-0}" = "1" ] && echo "NOTE: log out/in (or reboot) once so the dialout group takes effect."
