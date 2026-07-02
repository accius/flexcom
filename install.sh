#!/usr/bin/env bash
# One-time setup for macOS and Linux. (Windows: double-click Install.bat.
# Raspberry Pi headless: pi/install-pi.sh also installs a systemd service.)
set -euo pipefail
cd "$(dirname "$0")"

echo
echo "  acom-flex-bridge - one-time setup"
echo "  ---------------------------------"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js is not installed. Install the LTS version from https://nodejs.org"
  echo "  (macOS: 'brew install node' also works; Debian/Ubuntu: 'sudo apt install nodejs npm')"
  exit 1
fi
if [ "$(node -e 'console.log(parseInt(process.versions.node))')" -lt 18 ]; then
  echo "  Node.js >= 18 required (you have $(node -v)). Please upgrade."
  exit 1
fi
echo "  Node $(node -v) found."

echo "  Installing dependencies (this takes a minute)..."
npm install --no-audit --no-fund

# Serial port access on Linux needs the dialout (or uucp) group.
if [ "$(uname)" = "Linux" ] && [ -n "${USER:-}" ]; then
  GROUP=""
  getent group dialout >/dev/null && GROUP=dialout
  [ -z "$GROUP" ] && getent group uucp >/dev/null && GROUP=uucp
  if [ -n "$GROUP" ] && ! id -nG "$USER" | grep -qw "$GROUP"; then
    echo
    echo "  Adding $USER to the '$GROUP' group (serial port access)..."
    sudo usermod -aG "$GROUP" "$USER" || echo "  (couldn't - run: sudo usermod -aG $GROUP $USER)"
    echo "  Log out and back in once for that to take effect."
  fi
fi

echo
echo "  Your USB-serial adapters:"
if [ "$(uname)" = "Darwin" ]; then
  ls -1 /dev/tty.usbserial* /dev/tty.usbmodem* 2>/dev/null | sed 's/^/     /' || echo "     (none detected - plug the FTDI adapters in)"
else
  ls -1 /dev/serial/by-id/ 2>/dev/null | sed 's|^|     /dev/serial/by-id/|' || echo "     (none detected - plug the FTDI adapters in)"
  echo "     Tip: use the /dev/serial/by-id/ paths - unlike /dev/ttyUSB0/1 they never swap between boots."
fi

echo
echo "  Done! Start the bridge with:   ./start.sh"
echo "  The dashboard opens at http://localhost:8990 - click the gear icon"
echo "  to pick your radio and serial ports, then Save and Restart."
echo "  Optional autostart at login/boot:   ./service.sh install"
echo
