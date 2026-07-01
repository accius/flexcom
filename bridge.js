#!/usr/bin/env node
/**
 * acom-flex-bridge v0.2
 * ACOM 700S + 06AT  <->  FLEX-8400 translator, telemetry, and dashboard.
 * See README.md for wiring and first-session capture procedure.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const { init, log } = require('./lib/log');
init(cfg.logging, __dirname);

const { FlexClient } = require('./lib/flex');
const { TuneController } = require('./lib/tune');
const { CatEmulator } = require('./lib/cat');
const { AcomTelemetry } = require('./lib/telemetry');
const { startDashboard } = require('./lib/dashboard');
const { FlexDiscovery } = require('./lib/discovery');

log('info', 'MAIN', '=== acom-flex-bridge v0.3.0 starting ===');

const flex = new FlexClient(cfg);
const telemetry = new AcomTelemetry(cfg);
const tuner = new TuneController(cfg, flex, () => telemetry.snapshot());
const catEmu = new CatEmulator(cfg, flex, tuner);
const discovery = new FlexDiscovery();

// During a tune cycle, feed amp-reported SWR into the tune result.
telemetry.onSwr = (swr) => tuner.observeSwr(swr);

startDashboard(cfg, () => ({
  flex: flex.snapshot(),
  tune: tuner.snapshot(),
  amp: telemetry.snapshot(),
}), { discovery });

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
