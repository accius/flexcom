# acom-flex-bridge (flexcom)

Node.js bridge between an ACOM S-series amplifier + 04AT/06AT autotuner and a
FlexRadio FLEX-6000/8000. It impersonates a Kenwood TS-2000 toward the amp over
serial, talks to the radio as a native SmartSDR TCP API client (port 4992), and
serves a web dashboard on http://localhost:8990. Full user docs: README.md,
wiring: HOOKUP.md, Raspberry Pi: pi/README-PI.md.

## Running locally

- Node >= 18 (see `.nvmrc`). Zero build step; plain CommonJS + vanilla JS web UI.
- `npm install` once, then `npm start` (or press F5 in VS Code).
- `npm run dev` runs the bridge under `node --watch` so it restarts on file edits.
- `npm run check` syntax-checks every JS file. There is no test suite.
- `npm run diag` prints a station diagnostics report (serial ports, radio reachability, log tail).
- The bridge boots fine with no radio and no serial ports configured: it logs
  "not configured yet" for each and still serves the dashboard. That is the
  normal state on a dev machine without the station attached.

## Layout

```
bridge.js         entry point: loads config.json, wires modules, dashboard command table
diag.js           one-shot diagnostics (npm run diag / Diagnose.bat)
lib/flex.js       SmartSDR TCP API client, GUI-client binding, radio control, ATU bypass guard
lib/cat.js        Kenwood CAT emulator facing the amp (serial)
lib/tune.js       tune state machine, per-band tune memory (data/), history, webhook notify
lib/telemetry.js  ACOM RS-232 remote protocol: 0x55-framed telegrams, parser, OPERATE/STANDBY/OFF
lib/bands.js      band plan helpers
lib/discovery.js  FlexRadio UDP discovery listener (4992)
lib/dashboard.js  HTTP + WebSocket server, /api/* endpoints, config save, optional Basic Auth
lib/log.js        logger + event bus (logs/bridge-YYYY-MM-DD.log)
web/              dashboard SPA: index.html, app.js, style.css, manifest.json (no bundler)
pi/               Raspberry Pi install script, systemd unit, Caddy HTTPS setup
*.bat, *.sh       double-click / shell launchers, autostart, installers
```

## Things to know before editing

- `config.json` is tracked in git AND rewritten by the dashboard Settings panel
  (POST /api/config). If you save real settings (radio IP, COM ports) while
  developing, keep them out of commits with:
  `git update-index --skip-worktree config.json`
  (undo with `--no-skip-worktree`). Commit config.json only for schema/default changes.
- `logs/` and `data/` are runtime output and gitignored.
- Serial port names are platform-native: `COM3` on Windows, `/dev/serial/by-id/...`
  on Linux, `/dev/tty.usbserial-...` on macOS.
- The dashboard's Restart button calls `process.exit(0)`; the launcher scripts
  (`Start Bridge.bat`, `start.sh`) loop to bring it back. `npm run dev` does the
  same via `--watch`.
- Safety-relevant invariants (do not weaken casually): frequency writes from the
  amp below `cat.minValidFreqHz` are dropped; the radio's internal ATU is held in
  BYPASS when `flex.enforceAtuBypass` is true; the tune carrier is force-dropped
  after `tune.maxTuneSeconds`. This software keys a transmitter.
- Log level stays `debug` by default on purpose; the logs are the ground truth
  for refining CAT translation rules (`lib/cat.js`). Unknown CAT commands are
  logged as `Unhandled command from amp: ...`.
- Amp protocol details (telegram layout, field offsets) follow SM7IUN's
  ACOM-Controller; see the README "ACOM remote protocol notes" section.

## Style

- CommonJS (`require`), `'use strict'`, 2-space indent, single quotes, semicolons.
- Keep dependencies minimal: currently only `serialport` and `ws`.
- Bump `version` in package.json for user-visible changes; the dashboard shows it.
