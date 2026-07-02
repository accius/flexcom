#!/usr/bin/env bash
# Puts a Caddy HTTPS reverse proxy in front of the dashboard, with automatic
# Let's Encrypt certificates. Result: https://your.domain.com from anywhere,
# encrypted end to end, with the bridge's own username/password login.
#
# Prerequisites:
#   - A DNS name pointed at your home IP (an A record, or a dynamic-DNS name).
#   - Router port-forwards:  TCP 80 -> this Pi   and   TCP 443 -> this Pi.
#     (80 is needed for the Let's Encrypt challenge and HTTP->HTTPS redirect.)
#   - A dashboard password set (Settings gear, or config.json dashboard.password).
#
# Run:  bash pi/setup-remote-caddy.sh shack.example.com
set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  read -rp "Domain name pointing at your home IP (e.g. shack.example.com): " DOMAIN
fi

echo "== Installing Caddy =="
if ! command -v caddy >/dev/null; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt-get update && sudo apt-get install -y caddy
fi

echo "== Writing /etc/caddy/Caddyfile =="
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$DOMAIN {
    reverse_proxy 127.0.0.1:8990
}
EOF

sudo systemctl enable caddy
sudo systemctl restart caddy

echo
echo "== Done =="
echo "  1. Confirm router forwards TCP 80 and 443 to this Pi ($(hostname -I | awk '{print $1}'))."
echo "  2. In the bridge config, set dashboard.host to \"127.0.0.1\" and set a"
echo "     dashboard user/password, then restart the bridge. That way the only"
echo "     path to the dashboard is through Caddy's HTTPS."
echo "  3. Browse https://$DOMAIN - certificate is issued automatically on first hit"
echo "     and renews itself forever."
echo
echo "No static IP? Use a dynamic-DNS name (your router likely supports one),"
echo "or skip port-forwarding entirely with a Cloudflare Tunnel - see pi/README-PI.md."
