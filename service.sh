#!/usr/bin/env bash
# Autostart the bridge at boot/login on macOS (launchd) or Linux (systemd).
#   ./service.sh install     enable + start
#   ./service.sh uninstall   stop + remove
#   ./service.sh status      show service state
# Windows equivalent: "Enable Autostart.bat" / "Disable Autostart.bat".
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CMD="${1:-install}"
NODE_BIN="$(command -v node || true)"
[ -z "$NODE_BIN" ] && { echo "node not found in PATH"; exit 1; }

if [ "$(uname)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.acomflexbridge.plist"
  case "$CMD" in
    install)
      mkdir -p "$HOME/Library/LaunchAgents"
      cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.acomflexbridge</string>
  <key>ProgramArguments</key><array>
    <string>$NODE_BIN</string>
    <string>$HERE/bridge.js</string>
  </array>
  <key>WorkingDirectory</key><string>$HERE</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HERE/logs/launchd.log</string>
  <key>StandardErrorPath</key><string>$HERE/logs/launchd.log</string>
</dict></plist>
EOF
      mkdir -p "$HERE/logs"
      launchctl unload "$PLIST" 2>/dev/null || true
      launchctl load "$PLIST"
      echo "Installed. The bridge now starts at every login - dashboard at http://localhost:8990"
      ;;
    uninstall)
      launchctl unload "$PLIST" 2>/dev/null || true
      rm -f "$PLIST"
      echo "Autostart removed."
      ;;
    status) launchctl list | grep -i acomflexbridge || echo "not installed" ;;
    *) echo "usage: ./service.sh install|uninstall|status"; exit 1 ;;
  esac
else
  UNIT="$HOME/.config/systemd/user/acom-flex-bridge.service"
  case "$CMD" in
    install)
      mkdir -p "$(dirname "$UNIT")"
      cat > "$UNIT" <<EOF
[Unit]
Description=ACOM-Flex Bridge (CAT translator, telemetry, dashboard)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$HERE
ExecStart=$NODE_BIN $HERE/bridge.js
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
      systemctl --user daemon-reload
      systemctl --user enable --now acom-flex-bridge
      # Keep the user service running when not logged in (headless boxes):
      command -v loginctl >/dev/null && sudo loginctl enable-linger "$USER" 2>/dev/null || true
      echo "Installed. Status: systemctl --user status acom-flex-bridge"
      echo "Dashboard at http://$(hostname -I 2>/dev/null | awk '{print $1}'):8990"
      echo "(On a headless Raspberry Pi, pi/install-pi.sh sets up a system-level service instead.)"
      ;;
    uninstall)
      systemctl --user disable --now acom-flex-bridge 2>/dev/null || true
      rm -f "$UNIT"
      systemctl --user daemon-reload
      echo "Autostart removed."
      ;;
    status) systemctl --user status acom-flex-bridge --no-pager || true ;;
    *) echo "usage: ./service.sh install|uninstall|status"; exit 1 ;;
  esac
fi
