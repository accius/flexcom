#!/usr/bin/env node
/**
 * acom-flex-bridge
 * ACOM S-series + 04AT/06AT  <->  FlexRadio translator, telemetry,
 * amp/radio control, and web dashboard.
 * See README.md for wiring and first-session procedure.
 */
'use strict';

const fs = require('fs');

const VERSION = require('./package.json').version;
const paths = require('./lib/paths');
paths.ensureHome();
const cfg = JSON.parse(fs.readFileSync(paths.CONFIG, 'utf8'));

const { init, log } = require('./lib/log');
init(cfg.logging, paths.HOME);

const { FlexClient } = require('./lib/flex');
const { TuneController } = require('./lib/tune');
const { CatEmulator } = require('./lib/cat');
const { AcomTelemetry } = require('./lib/telemetry');
const { startDashboard } = require('./lib/dashboard');
const { FlexDiscovery } = require('./lib/discovery');

log('info', 'MAIN', `=== acom-flex-bridge v${VERSION} starting (home: ${paths.HOME}) ===`);

const flex = new FlexClient(cfg);
const telemetry = new AcomTelemetry(cfg);
const tuner = new TuneController(cfg, flex, () => telemetry.snapshot(), paths.HOME);
const catEmu = new CatEmulator(cfg, flex, tuner);
const discovery = new FlexDiscovery();

// During a tune cycle, feed amp-reported SWR into the tune result.
telemetry.onSwr = (swr) => tuner.observeSwr(swr);
// Never move the client binding while a carrier is up.
flex.isTuning = () => tuner.tuning;

// Dashboard-initiated actions (arrive over the WebSocket).
const clampW = (w, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(w) || 0)));
const commands = {
  'radio.qsy': (a) => flex.qsy(Number(a.hz)),
  'radio.mode': (a) => flex.setMode(a.mode),
  'radio.rfpower': (a) => flex.setRfPower(clampW(a.watts, 0, 100)),
  'radio.tunepower': (a) => flex.setTunePower(clampW(a.watts, 1, 100)),
  'radio.bind': (a) => flex.bindTo(a.clientId || null),
  'radio.atuBypass': () => flex.enforceAtuBypass('dashboard'),
  'tune.start': (a) => tuner.start(clampW(a.watts || cfg.tune.tunePowerDefault, 1, 100), 'dashboard'),
  'tune.stop': () => tuner.stop('dashboard'),
  'amp.operate': () => telemetry.operate(),
  'amp.standby': () => telemetry.standby(),
  'amp.off': () => telemetry.powerOff(),
};

startDashboard(cfg, () => ({
  version: VERSION,
  flex: flex.snapshot(),
  tune: tuner.snapshot(),
  amp: telemetry.snapshot(),
  cat: catEmu.snapshot(),
}), { discovery, tuner, commands });

discovery.start();

flex.connect();
catEmu.open();
telemetry.open();

function shutdown() {
  log('info', 'MAIN', 'Shutting down...');
  try { tuner.stop('shutdown'); } catch {}
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (e) => log('error', 'MAIN', `Uncaught: ${e.stack || e}`));
