# acom-flex-bridge

**One dashboard for an ACOM S-series amp, ACOM autotuner, and FlexRadio — with one-button tuning that actually works.**

A small cross-platform bridge (Windows, macOS, Linux, Raspberry Pi) that sits between an **ACOM S-series amplifier + ACOM 04AT/06AT autotuner** and a **FlexRadio FLEX-6000/8000-series** transceiver. Press TUNE on the amp — or in the dashboard — and it just works, whether you're driving the radio directly, through SmartSDR, AetherSDR, or Maestro, at home or remotely.

Developed and tested against an ACOM 700S + 06AT and a FLEX-8400. Applies to the 500S/600S/1200S/2020S and 04AT with little or no change (reports welcome).

---

## The problem

The ACOM S-series amps speak Kenwood CAT to the radio. When you press **TUNE** on the amp, it commands the radio into RTTY and keys TX, expecting a continuous FSK carrier for the tuner to match against. FlexRadio's RTTY is **AFSK** — no audio, no carrier — so the tuner waits for a timeout. Worse, the amp's post-tune CAT traffic can knock the Flex slice to 0 Hz or freeze SmartSDR entirely. This is a long-standing, ACOM-acknowledged incompatibility (see FlexRadio community threads going back to 2018).

## The fix

The bridge removes the serial link between the amp and the radio entirely. Instead:

- Toward the **amp**, it impersonates a Kenwood TS-2000 on the CAT/AUX port, and speaks the ACOM remote protocol on the amp's second RS-232 port for telemetry and control.
- Toward the **radio**, it connects over the LAN as a native SmartSDR API client (TCP 4992) — the same protocol SmartSDR, AetherSDR, and Maestro use. It binds to whichever GUI client is active and rebinds automatically when you switch clients (or pin one from the dashboard).

| Amp sends (Kenwood CAT) | Bridge does |
|---|---|
| `FA;` / `IF;` frequency polls | Answers live from the radio's TX slice — band-following keeps working |
| `MD6;` (switch to RTTY) | **Swallowed.** The radio's mode is never touched; a shadow value is echoed back |
| `PC025;` power request during tune | `transmit set tunepower=25` on the Flex |
| `TX;` | `transmit tune on` — a true continuous carrier at tune power |
| `RX;` | `transmit tune off` |
| Frequency writes below 1.8 MHz | **Blocked** — kills the post-tune "jumps to 0 Hz" bug |

Because the radio never changes mode and is never keyed through CAT semantics, the entire class of ACOM/Flex sequencing bugs becomes irrelevant.

## Features

- 🎛 **One-button tuning** — press TUNE on the amp *or* the dashboard's TUNE button; carrier on, power tracked, carrier off, done
- 🗺 **Per-band tune memory** — every successful tune is remembered per band (frequency, SWR, age); band buttons QSY straight back to the last-tuned spot; memories survive restarts
- 📻 **Radio control** — big click-to-QSY frequency readout, band buttons, mode buttons, RF-power and tune-power sliders, internal-ATU state — all live from the radio, working alongside whatever SDR client is running (or none)
- 📊 **Amp control & telemetry** — OPERATE / STANDBY / power-OFF buttons, PA state banner, live gauges (forward/reflected power, SWR, PA temp, drive power, DC input power), band + fan readout, decoded protection errors
- 📈 **Rolling history charts** — power, SWR, and PA temperature over the last 1–30 minutes, with crosshair readout
- 🧭 **Multi-client aware** — shows every GUI client on the radio (SmartSDR, AetherSDR, Maestro); auto-binds to the active one, or pin one from the header dropdown
- 🔔 **Tune-complete reporting** — dashboard events + history + CSV export, browser notifications on any machine with the dashboard open, and an optional outbound webhook (JSON POST, or ntfy.sh-compatible)
- 🛡 **Internal-ATU guard** — forces and holds the radio's built-in ATU in **BYPASS** (startup, pre-tune, and re-asserted if it ever leaves bypass) — mandatory with an amp + external tuner in line
- ⏱ **Safety timeout** — carrier force-dropped if the amp never releases TX
- 📱 **Remote-friendly** — the dashboard is a mobile-ready web app (installable to a phone home screen), with optional login + rate-limited lockout and documented HTTPS/VPN paths for access from anywhere
- 🖱 **No command line** — double-click installers on Windows, two shell scripts everywhere else; all configuration (auto-discovered radio IP, serial-port pick-lists, tune power, amp model, notifications) lives in the dashboard's Settings panel
- 🧾 **Deep logging** — every byte in both directions, timestamped, for protocol refinement

## Quick start

Everything needs [Node.js LTS](https://nodejs.org) (≥ 18) and the wiring in **[HOOKUP.md](HOOKUP.md)**.

**Windows**
1. Download/clone this repo to a permanent folder (e.g. `C:\acom-flex-bridge`).
2. Double-click **`Install.bat`**, then **`Start Bridge.bat`** — the dashboard opens at `http://localhost:8990`.
3. Optional: **`Enable Autostart.bat`** runs the bridge silently at every login.

**macOS / Linux**
```sh
./install.sh
./start.sh              # dashboard at http://localhost:8990
./service.sh install    # optional: autostart at login/boot (launchd / systemd)
```

**Raspberry Pi (headless)** — `bash pi/install-pi.sh` does all of the above plus a system-level systemd service; see [pi/README-PI.md](pi/README-PI.md).

Then in the dashboard click **⚙ Settings**: select your radio (auto-discovered), pick the two serial ports, set the amp model, Save, Restart. CLI equivalents: `npm install`, `npm start`, `npm run ports`.

## First tune session

Leave `logging.level` at `"debug"` for the first sessions and start with the **amp in STANDBY**:

1. Confirm the dashboard header shows radio + amp CAT + amp data green, and the ATU pill reads BYPASS.
2. QSY around — the amp's display should follow band and frequency, and the amp gauges should be alive (idle PA temp ≈ room temperature).
3. Press TUNE (amp or dashboard). Watch the log for `Unhandled command from amp: ...` — a CAT command that needs a translation rule (`lib/cat.js`).
4. Repeat in OPERATE once standby is clean.
5. Keep the log (`logs/bridge-YYYY-MM-DD.log`) — it's the ground truth for refining the rules.

## Configuration

Everything lives in `config.json` (edited by the dashboard Settings panel, or by hand):

| Section | Key | Meaning |
|---|---|---|
| `serial` | `port`, `baudRate` | Serial port to the amp **CAT/AUX** port (Kenwood, 9600 8N1 by default) |
| `telemetry` | `port`, `enabled` | Serial port to the amp **RS-232 remote** port |
| `telemetry` | `model`, `tempOffset` | Amp model (sets PA-temp calibration); explicit offset overrides |
| `telemetry` | `keepaliveMs`, `allowPowerControl` | Telemetry-enable resend rate; gate the dashboard power-off button |
| `flex` | `host` | Radio IP (give it a DHCP reservation) |
| `flex` | `enforceAtuBypass` | Keep the internal ATU in BYPASS (default `true`) |
| `flex` | `preferredClient` | Program/station name to prefer when several GUI clients are connected |
| `tune` | `tunePowerDefault`, `followAmpPowerRequest`, `maxTuneSeconds` | Carrier behavior |
| `cat` | `allowFreqWritesFromAmp`, `minValidFreqHz` | Frequency-write filtering (the 0 Hz bug guard) |
| `notify` | `url` | Optional webhook fired on tune complete/fail |
| `dashboard` | `host`, `port`, `user`, `password` | Web UI binding (default `0.0.0.0:8990`) and optional login |

Serial port names are platform-native: `COM3` on Windows, `/dev/serial/by-id/...` on Linux (stable across reboots — prefer these), `/dev/tty.usbserial-...` on macOS. The Settings pick-list shows what's present.

## Project structure

```
bridge.js            entry point / wiring / dashboard command table
lib/flex.js          SmartSDR TCP API client, client binding, radio control, ATU guard
lib/cat.js           Kenwood CAT emulator facing the amp
lib/tune.js          tune state machine, per-band memory, history, notifications
lib/telemetry.js     ACOM S-series remote protocol: telemetry parser + amp control
lib/bands.js         band plan helpers
lib/discovery.js     FlexRadio UDP discovery listener
lib/dashboard.js     HTTP + WebSocket server, command channel, config API
lib/log.js           logger + event bus
web/                 dashboard SPA (vanilla JS, zero build step)
```

## ACOM remote protocol notes

The amp's RS-232 remote port speaks 0x55-framed telegrams (checksummed so the byte sum ≡ 0 mod 256). The bridge sends the **telemetry-enable** telegram (`55 92 04 15`) periodically; the amp then streams a 72-byte **measurement telegram** (address `0x2F`) with PA state, powers, SWR, temperature, band, and protection errors — field layout in `lib/telemetry.js`. OPERATE / STANDBY / OFF are state-request telegrams (`55 81 08 02 00 <06|05|0A> 00 ck`). Telegram set and field offsets follow SM7IUN's ACOM-Controller, which drives the same amps in production.

**Remote power-ON is deliberately not supported:** the amp powers on via the RS-232 handshake lines, and the recommended cable leaves them unwired (pins 2/3/5 only) so a stuck handshake line can never block the front-panel power button or power-cycle the amp mid-QSO. Power off remotely, power on at the panel.

## Remote access

Pick whichever fits your station — the bridge doesn't care:

1. **LAN.** From any computer or phone on your network, browse `http://<bridge-ip>:8990`. Leave `dashboard.password` blank if the LAN is trusted.
2. **From anywhere, with login (recommended on a Pi).** Set `dashboard.user`/`dashboard.password` (Settings gear), then put HTTPS in front — one script installs a Caddy reverse proxy with automatic Let's Encrypt certificates (`pi/setup-remote-caddy.sh`, port-forward 443), or use a Cloudflare Tunnel for the same result with zero forwarded ports. Full walkthrough for both: [pi/README-PI.md → Access from anywhere](pi/README-PI.md#access-from-anywhere). Failed logins are rate-limited (5 tries → 5-minute IP lockout).
3. **VPN into your home network.** From a computer elsewhere, connect via your router's WireGuard/OpenVPN and browse the LAN address.

**Do not raw port-forward 8990 to the internet.** The built-in login is sound but runs over plain HTTP — it needs TLS in front (option 2 provides it). And remember the dashboard can key your transmitter: treat its credentials accordingly.

## Troubleshooting

- **Radio not auto-discovered** — SmartSDR on the same PC may hold UDP 4992; enter the IP manually (SmartSDR's radio chooser shows it).
- **Amp doesn't follow frequency** — check CAT protocol = Kenwood, interface = RS232, baud matches config; verify TX/RX aren't swapped on the CAT cable.
- **Events show "Receiving garbage instead of CAT commands"** — the amp and bridge disagree on baud rate (or the cable is a TTL-level adapter, not RS-232). Set the amp's CAT menu to KENWOOD / RS232 and match the baud in dashboard Settings (both have baud dropdowns now). The log prints a raw hex sample to confirm. While the CAT link is garbled, the **amp itself raises `CAT error` telemetry codes** (0x70–0x73, and neighbors like 0x86) — fix the link and the error spam stops.
- **"Internal ATU engaged (status=TUNE_SUCCESSFUL)" repeatedly** — the radio is re-applying an internal-ATU memory on every QSY, and the bridge keeps bypassing it. Turn ATU memories off in SmartSDR (ATU panel → MEM) and clear stored memories; the internal ATU must stay in bypass with the amp + external tuner in line.
- **"Garbled command … salvaged" around transmissions** — RF is getting into the CAT serial cable. The bridge recovers these automatically, but clamp-on ferrites at both ends of both serial cables (and keeping them away from the coax run) is the real fix.
- **Amp error "0x… — see amp display"** — the amp raised a protection code that isn't in the public table; the amp's own front panel shows the full text. Codes seen at power-on usually clear themselves once the CAT link is polling.
- **Amp gauges dead** — telemetry port not set (Settings), or DTR/RTS wired on the remote cable (they must not be), or the two serial cables are swapped (CAT ↔ remote).
- **PA temperature reads ~10 °C off** — wrong amp model in Settings (each model has its own calibration offset).
- **Amp front-panel power button stops working** — a handshake line is wired on the remote port. Use pins 2/3/5 only; the bridge holds DTR/RTS low, but hardware-looped handshake lines defeat that.
- **Tune carrier never appears / "Tune refused: bound client ... has no TX slice"** — the bridge only keys the TX slice owned by the GUI client it is bound to (header dropdown), and reports that slice's frequency to the amp. On an M-model radio the front panel is a GUI client too, and it usually owns no slice: pick SmartSDR/AetherSDR/Maestro in the dropdown (or leave it on *auto*, which prefers whichever client owns a TX slice). A radio reply like `The transmitter is not ready` ends the cycle immediately and shows as a failed tune with that reason.
- **Radio drops off the network during a tune** (log shows `ECONNRESET` then `EHOSTUNREACH`, SmartSDR loses the radio too) — that is RF getting into the Ethernet, not a software fault. Ferrites on the network cables at the radio and the PC, and keep them away from the coax. The bridge marks the tune failed, keeps answering the amp with the last known frequency, and sends carrier-off the moment it reconnects.
- **Serial permissions on Linux** — `./install.sh` adds you to `dialout`; log out/in once after that.

## Status / roadmap

- [x] CAT translation, tune carrier, freq-write guard
- [x] ATU bypass enforcement
- [x] Telemetry parser (confirmed 0x2F telegram layout) + telemetry-enable keepalive
- [x] Amp control: OPERATE / STANDBY / power OFF
- [x] Radio control: QSY, band/mode buttons, power sliders
- [x] Per-band tune memory + history CSV export
- [x] Rolling telemetry charts
- [x] Cross-platform install/run/autostart (Windows, macOS, Linux, Pi)
- [ ] Verify measurement-telegram values against the 700S front panel at power (field offsets are from ACOM-Controller; sanity-check fwd/refl/temp on your amp at low power first)
- [ ] SWR-vs-frequency sweep during tune
- [ ] System-tray app packaging

## Acknowledgments

- Klaus **DL4FCJ**, whose Arduino translator on the FlexRadio community forum proved the man-in-the-middle approach and documented the ACOM tune sequence quirks
- Björn **SM7IUN**'s [ACOM-Controller](https://github.com/bjornekelund/ACOM-Controller), which established the amp remote-protocol handling — the control telegrams, measurement-telegram layout, and the DTR/RTS gotcha all follow it
- The official *ACOM 600S Serial Port Communication Protocol* document (frame format shared across the S-series)

## Disclaimer

This project is not affiliated with, or endorsed by, ACOM Ltd. or FlexRadio Systems. It keys your transmitter and drives a legal-limit amplifier chain: **you** are responsible for verifying behavior at low power before trusting it, and for everything that happens at RF. No warranty of any kind — see [LICENSE](LICENSE).

## License

MIT
