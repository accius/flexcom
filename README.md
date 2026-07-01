# acom-flex-bridge

**One-button ACOM autotuning for FlexRadio — plus live amp telemetry and a remote dashboard.**

A Windows bridge that sits between an **ACOM S-series amplifier + ACOM 04AT/06AT autotuner** and a **FlexRadio FLEX-6000/8000-series** transceiver. Press TUNE on the amp and it just works — with SmartSDR, AetherSDR, or Maestro, unchanged.

Developed and tested against an ACOM 700S + 06AT and a FLEX-8400. Should apply to the 500S/600S/1200S/2020S and 04AT with little or no change (reports welcome).

---

## The problem

The ACOM S-series amps speak Kenwood CAT to the radio. When you press **TUNE** on the amp, it commands the radio into RTTY and keys TX, expecting a continuous FSK carrier for the tuner to match against. FlexRadio's RTTY is **AFSK** — no audio, no carrier — so the tuner waits for a timeout. Worse, the amp's post-tune CAT traffic can knock the Flex slice to 0 Hz or freeze SmartSDR entirely. This is a long-standing, ACOM-acknowledged incompatibility (see FlexRadio community threads going back to 2018).

## The fix

The bridge removes the serial link between the amp and the radio entirely. Instead:

- Toward the **amp**, it impersonates a Kenwood TS-2000 on the CAT/AUX port.
- Toward the **radio**, it connects over the LAN as a native SmartSDR API client (TCP 4992) — the same protocol SmartSDR, AetherSDR, and Maestro use. It binds to whichever GUI client is active and rebinds automatically when you switch clients.

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

- 🎛 **One-button tuning** — press TUNE on the amp; carrier on, power tracked, carrier off, done
- 📊 **Live web dashboard** — radio state, tune state and history, amp gauges (forward/reflected power, SWR, PA temps, drain volts/amps), event log; optional password protection; remote-access options in the README
- 📈 **Amp telemetry** — parses the ACOM S-series remote protocol on the amp's second RS-232 port
- 🔔 **Tune-complete reporting** — dashboard event + history, browser notifications on any machine with the dashboard open, and an optional outbound webhook (JSON POST, or ntfy.sh-compatible) for feeding anything else in your stack ("Tune COMPLETE on 14.250 MHz in 4.2 s, SWR 1.21")
- 🛡 **Internal-ATU guard** — forces and holds the radio's built-in ATU in **BYPASS** (startup, pre-tune, and re-asserted if it ever leaves bypass) — mandatory with an amp + external tuner in line
- ⏱ **Safety timeout** — carrier force-dropped if the amp never releases TX
- 🖱 **No command line** — double-click installers, and all configuration (auto-discovered radio IP, COM port pick-lists, tune power, notifications) lives in the dashboard's Settings panel
- 🧾 **Deep logging** — every byte in both directions, timestamped, for protocol refinement

## Quick start

1. Install [Node.js LTS](https://nodejs.org) (≥ 18).
2. Clone or download this repo to a permanent folder (e.g. `C:\acom-flex-bridge`).
3. Double-click **`Install.bat`**.
4. Cable the hardware — follow **[HOOKUP.md](HOOKUP.md)** for the exact sequence.
5. Double-click **`Start Bridge.bat`** — the dashboard opens at `http://localhost:8990`.
6. Click **⚙ Settings**: select your radio (auto-discovered), pick the two COM ports, Save, Restart.
7. Optional: **`Enable Autostart.bat`** runs the bridge silently at every login.

CLI equivalents: `npm install`, `npm start`, `npm run ports`.

## First tune session

Leave `logging.level` at `"debug"` for the first sessions and start with the **amp in STANDBY**:

1. Confirm the log shows `Bound to GUI client ...` and the dashboard shows the ATU in BYPASS.
2. QSY around — the amp's display should follow band and frequency.
3. Press TUNE on the amp. Watch for two things in the log:
   - `Unhandled command from amp: ...` — a CAT command that needs a translation rule (`lib/cat.js`)
   - `Frame addr=0x..` — telemetry telegrams. The address that streams constantly is the measurement telegram: set it as `telemetry.measurementAddress` in `config.json`, restart, and the amp gauges come alive. Sanity check: idle PA temp ≈ room temperature, drain volts ≈ 48–53 V. If values look scrambled, adjust `telemetry.measurementFieldOffset`.
4. Repeat in OPERATE once standby is clean.
5. Keep the log (`logs/bridge-YYYY-MM-DD.log`) — it's the ground truth for refining the rules.

## Configuration

Everything lives in `config.json` (edited by the dashboard Settings panel, or by hand):

| Section | Key | Meaning |
|---|---|---|
| `serial` | `port`, `baudRate` | COM port to the amp **CAT/AUX** port (Kenwood, 9600 8N1 by default) |
| `telemetry` | `port`, `enabled` | COM port to the amp **RS-232 remote** port |
| `telemetry` | `measurementAddress`, `measurementFieldOffset` | Measurement telegram identification (see First tune session) |
| `flex` | `host` | Radio IP (give it a DHCP reservation) |
| `flex` | `enforceAtuBypass` | Keep the internal ATU in BYPASS (default `true`) |
| `tune` | `tunePowerDefault`, `followAmpPowerRequest`, `maxTuneSeconds` | Carrier behavior |
| `cat` | `allowFreqWritesFromAmp`, `minValidFreqHz` | Frequency-write filtering (the 0 Hz bug guard) |
| `notify` | `url` | Optional webhook fired on tune complete/fail |
| `dashboard` | `host`, `port` | Web UI binding (default `0.0.0.0:8990`) |

## Project structure

```
bridge.js            entry point / wiring
lib/flex.js          SmartSDR TCP API client, client binding, ATU guard
lib/cat.js           Kenwood CAT emulator facing the amp
lib/tune.js          tune state machine, history, notifications
lib/telemetry.js     ACOM S-series remote protocol parser (0x55 frames)
lib/discovery.js     FlexRadio UDP discovery listener
lib/dashboard.js     HTTP + WebSocket server, config API
lib/log.js           logger + event bus
web/index.html       dashboard SPA (vanilla JS, zero build step)
```

## Remote access

Pick whichever fits your station — the bridge doesn't care:

1. **LAN.** From any computer on your network, browse `http://<bridge-ip>:8990`. This covers "away from the shack but in the building" with nothing configured. Leave `dashboard.password` blank if the LAN is trusted.
2. **From anywhere, with login (recommended on a Pi).** Set `dashboard.user`/`dashboard.password` (Settings gear), then put HTTPS in front — one script installs a Caddy reverse proxy with automatic Let's Encrypt certificates (`pi/setup-remote-caddy.sh`, port-forward 443), or use a Cloudflare Tunnel for the same result with zero forwarded ports. Full walkthrough for both: [pi/README-PI.md → Access from anywhere](pi/README-PI.md#access-from-anywhere). Failed logins are rate-limited (5 tries → 5-minute IP lockout).
3. **VPN into your home network.** From a computer elsewhere, connect via your router's WireGuard/OpenVPN and browse the LAN address.

**Do not raw port-forward 8990 to the internet.** The built-in login is sound but runs over plain HTTP — it needs TLS in front (option 2 provides it).

## Troubleshooting

- **Radio not auto-discovered** — SmartSDR on the same PC may hold UDP 4992; enter the IP manually (SmartSDR's radio chooser shows it).
- **Amp doesn't follow frequency** — check CAT protocol = Kenwood, interface = RS232, baud matches config; verify TX/RX aren't swapped on the CAT cable.
- **Telemetry gauges dead** — `measurementAddress` not set yet (see First tune session), or DTR/RTS wired on the remote cable (they must not be).
- **Amp front-panel power button stops working** — a handshake line is wired on the remote port. Use pins 2/3/5 only; the bridge holds DTR/RTS low, but hardware-looped handshake lines defeat that.
- **Tune carrier never appears** — confirm a GUI client is bound (dashboard header) and the radio connection is green; check `R<seq>|` error replies in the debug log.

## Status / roadmap

- [x] CAT translation, tune carrier, freq-write guard
- [x] ATU bypass enforcement
- [x] Telemetry frame parser + dashboard + notifications
- [ ] Confirm 700S measurement-telegram address & field offsets from live capture
- [ ] Post-tune restore sequence rules from live capture
- [ ] System-tray app packaging
- [ ] SWR-vs-frequency tune log export

## Acknowledgments

- Klaus **DL4FCJ**, whose Arduino translator on the FlexRadio community forum proved the man-in-the-middle approach and documented the ACOM tune sequence quirks
- Björn **SM7IUN**'s [ACOM-Controller](https://github.com/bjornekelund/ACOM-Controller), which established the amp remote-protocol handling (including the DTR/RTS gotcha)
- The official *ACOM 600S Serial Port Communication Protocol* document (frame format shared across the S-series)

## Disclaimer

This project is not affiliated with, or endorsed by, ACOM Ltd. or FlexRadio Systems. It keys your transmitter and drives a legal-limit amplifier chain: **you** are responsible for verifying behavior at low power before trusting it, and for everything that happens at RF. No warranty of any kind — see [LICENSE](LICENSE).

## License

MIT
