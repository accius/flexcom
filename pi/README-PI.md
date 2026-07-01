# Running on a Raspberry Pi 5

The bridge is pure Node.js — it runs identically on a Pi. A Pi 5 (even a Pi 4 or Zero 2 W;
the bridge idles at a few percent of one core) makes an ideal permanent home: always-on,
silent, sitting behind the amp, dashboard on your LAN (remote options in the main README).

## Install

```bash
sudo apt update && sudo apt install -y git
git clone https://github.com/<you>/acom-flex-bridge.git ~/acom-flex-bridge
cd ~/acom-flex-bridge
bash pi/install-pi.sh
```

The script installs Node if needed, installs dependencies, adds you to the `dialout`
group (serial access), prints your stable serial-port paths, and installs + starts a
systemd service that runs at boot and restarts on crash — which is also what makes the
dashboard's **Settings → Restart bridge** button work (the service brings the process
back after `exit(0)`, just like the Windows launcher loop does).

Then open `http://<pi-ip>:8990`, hit ⚙ Settings, pick the radio and ports, Save, Restart.

## The one Linux-specific gotcha: serial port naming

On Windows, COM ports stick. On Linux, **`/dev/ttyUSB0` and `/dev/ttyUSB1` can swap
between boots** when the two FTDI adapters are identical — which would silently connect
the Kenwood emulator to the telemetry port and vice versa.

The fix is built in: use the **`/dev/serial/by-id/…`** paths instead. They embed each
adapter's unique FTDI serial number and never move:

```
/dev/serial/by-id/usb-FTDI_UT232R_FT1A2B3C-if00-port0   → e.g. CAT/AUX
/dev/serial/by-id/usb-FTDI_UT232R_FT9X8Y7Z-if00-port0   → e.g. RS-232 remote
```

The dashboard's port dropdowns list these, and the install script prints them. To learn
which physical adapter is which, plug them in one at a time and run
`ls /dev/serial/by-id/`.

## Hardware notes

- Everything in [HOOKUP.md](../HOOKUP.md) applies unchanged — the Pi simply replaces the
  Windows PC in the diagram. Same two FTDI adapters, same pins-2/3/5 rule on the
  telemetry cable, same ferrites (the Pi is just as happy to eat RF as a PC; choke both
  serial runs and use a decent shielded USB-C supply, official 27 W recommended).
- Wired Ethernet strongly preferred over Wi-Fi — the Flex TCP session and the dashboard
  WebSocket both prefer a boring, low-jitter link.
- For access away from home, see "Remote access" in the main README — a router VPN
  (WireGuard) or a Cloudflare Tunnel gives any browser full dashboard access without
  opening ports.

## Access from anywhere

Set a login first (Settings gear → dashboard username/password, or `config.json` →
`dashboard.user` / `dashboard.password`; 5 failed attempts locks that IP out for 5
minutes). Then pick a transport:

### Option A — your own HTTPS server on the Pi (port forward)

```bash
bash pi/setup-remote-caddy.sh shack.yourdomain.com
```

This installs **Caddy** in front of the bridge. Caddy obtains and auto-renews a real
Let's Encrypt certificate, so you get `https://shack.yourdomain.com` — encrypted
login, green padlock, from any browser on any computer, anywhere.

You need: a DNS record pointing at your home IP (dynamic-DNS is fine — most routers
have it built in, or a Cloudflare A record you update), and **TCP 80 + 443 forwarded
to the Pi** on your router. After setup, change `dashboard.host` to `"127.0.0.1"` in
config so the only route to the dashboard is through Caddy's HTTPS — port 8990 stops
being reachable directly.

### Option B — Cloudflare Tunnel (no ports forwarded at all)

If forwarding ports isn't an option (CGNAT, or you just don't want holes in the
router), a `cloudflared` tunnel publishes the dashboard at a hostname on a domain in
your Cloudflare account with **zero inbound ports**:

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
cloudflared tunnel login
cloudflared tunnel create shack
cloudflared tunnel route dns shack shack.yourdomain.com
sudo cloudflared service install
# in /etc/cloudflared/config.yml: ingress -> http://127.0.0.1:8990
```

Same end result — `https://shack.yourdomain.com` from anywhere — and you can layer
Cloudflare Access rules on top of the bridge's own login if you want two gates.

Either way, **never expose bare port 8990 to the internet** — the built-in login is
sound, but it deserves TLS in front of it, and both options above provide that.

## Day-2 operations

```bash
journalctl -u acom-flex-bridge@$USER -f     # live logs (file logs still land in ./logs/)
sudo systemctl restart acom-flex-bridge@$USER
sudo systemctl stop acom-flex-bridge@$USER
git pull && npm install && sudo systemctl restart acom-flex-bridge@$USER   # update
```

## Windows vs Pi

| | Windows PC | Raspberry Pi 5 |
|---|---|---|
| Install | `Install.bat` / `Start Bridge.bat` | `bash pi/install-pi.sh` |
| Run at boot | `Enable Autostart.bat` (Task Scheduler) | systemd (installed automatically) |
| Serial ports | `COM3`, `COM4` | `/dev/serial/by-id/…` |
| Restart-from-dashboard | launcher loop | systemd `Restart=always` |
| Everything else | identical | identical |
