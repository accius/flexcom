'use strict';
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { log, bus } = require('./log');
const { bandOf } = require('./bands');

/**
 * Tune-sequence state machine + completion reporting + per-band memory.
 * Start: amp sends TX; over CAT, or the dashboard requests a manual carrier.
 * End: amp sends RX; / dashboard stop / safety timeout.
 * On completion, emits a 'tune' event for the dashboard, records the result
 * in the per-band tune memory (persisted to data/), and optionally fires a
 * push notification (generic JSON webhook, or ntfy.sh plain text).
 */
class TuneController {
  constructor(cfg, flex, getTelemetry, baseDir) {
    this.cfg = cfg;
    this.flex = flex;
    this.getTelemetry = getTelemetry || (() => null);
    this.tuning = false;
    this.source = null;  // 'amp' | 'dashboard'
    this.startedAt = 0;
    this.startFreq = null;
    this.peakSwr = null;
    this.lastSwr = null;
    this.timeoutTimer = null;
    this.dataDir = path.join(baseDir || path.join(__dirname, '..'), 'data');
    this.history = this._load('tune-history.json', []);   // newest first
    this.bandMemory = this._load('tune-memory.json', {}); // band -> last good tune
    // Radio link gone mid-tune: the carrier is out of our hands (the radio
    // drops it when our session times out; flex.js also sends tune-off on
    // reconnect). Record the tune as failed so nobody trusts its result.
    bus.on('flex', (f) => { if (this.tuning && f && f.connected === false) this.stop('radio link lost'); });
  }

  _refuse(text) {
    log('warn', 'TUNE', `Tune refused: ${text}`);
  }

  _load(file, fallback) {
    try { return JSON.parse(fs.readFileSync(path.join(this.dataDir, file), 'utf8')); }
    catch { return fallback; }
  }

  _save(file, obj) {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(path.join(this.dataDir, file), JSON.stringify(obj, null, 2));
    } catch (e) { log('warn', 'TUNE', `Could not persist ${file}: ${e.message}`); }
  }

  start(requestedWatts, source = 'amp') {
    if (this.tuning) { log('warn', 'TUNE', 'Tune already in progress - start ignored.'); return; }
    if (!this.flex.connected) return this._refuse('radio not connected.');
    const watts = (source === 'amp' && !(this.cfg.tune.followAmpPowerRequest && requestedWatts))
      ? this.cfg.tune.tunePowerDefault
      : (requestedWatts || this.cfg.tune.tunePowerDefault);
    // Only ever key a slice we can vouch for: the bound client's own TX
    // slice, whose frequency is what the amp has been told over CAT.
    const s = this.flex.txSlice();
    if (!s) {
      const b = this.flex.snapshot().boundTo;
      return this._refuse(b ? `bound client ${b} has no TX slice (pick the client running your slice in the header dropdown).`
                            : 'no GUI client bound (is SmartSDR running?).');
    }
    if (!s.freq) return this._refuse('TX slice frequency unknown.');
    this.startFreq = s.freq;
    this.peakSwr = null;
    this.lastSwr = null;
    this.source = source;
    log('info', 'TUNE', `Tune START (${source}) -> carrier ${watts} W @ ${this.startFreq ? (this.startFreq / 1e6).toFixed(3) + ' MHz' : '?'}`);
    this.tuning = true;
    this.startedAt = Date.now();
    this.flex.enforceAtuBypass('pre-tune');   // belt & suspenders
    this.flex.setTunePower(watts);
    this.flex.tune(true, (err) => {
      // The radio said no ("The transmitter is not ready", interlock, ...):
      // there is no carrier, so end the cycle as a failure right away.
      if (err && this.tuning) this.stop(`radio rejected tune: ${err}`, { noCarrier: true });
    });
    this._emitState();
    clearTimeout(this.timeoutTimer);
    this.timeoutTimer = setTimeout(() => {
      log('warn', 'TUNE', `Safety timeout (${this.cfg.tune.maxTuneSeconds}s) - dropping carrier.`);
      this.stop('timeout');
    }, (this.cfg.tune.maxTuneSeconds || 30) * 1000);
  }

  updatePower(watts) {
    if (!this.tuning) return;
    log('info', 'TUNE', `Amp adjusted tune power -> ${watts} W`);
    this.flex.setTunePower(watts);
  }

  /** Fed by the telemetry module during a tune so we can report result SWR. */
  observeSwr(swr) {
    if (!this.tuning || !swr) return;
    this.lastSwr = swr;
    if (this.peakSwr === null || swr > this.peakSwr) this.peakSwr = swr;
  }

  stop(reason = 'amp RX', opts = {}) {
    if (!this.tuning) return;
    const durationMs = Date.now() - this.startedAt;
    this.tuning = false;
    clearTimeout(this.timeoutTimer);
    if (!opts.noCarrier) this.flex.tune(false, (err) => {
      if (err) log('warn', 'TUNE', `Carrier-off not confirmed by radio (${err}) - check the radio is not still keyed.`);
    });

    const tel = this.getTelemetry();
    const band = bandOf(this.startFreq) || (tel && tel.band) || null;
    const result = {
      ts: new Date().toISOString(),
      // Only a cycle the amp or the operator ended normally counts as a tune.
      ok: reason === 'amp RX' || reason === 'dashboard',
      reason,
      source: this.source,
      durationMs,
      freqHz: this.startFreq,
      finalSwr: this.lastSwr,             // SWR at amp output near end of cycle
      band,
    };
    this.history.unshift(result);
    this.history = this.history.slice(0, 50);
    this._save('tune-history.json', this.history);

    if (result.ok && band) {
      this.bandMemory[band] = { ts: result.ts, freqHz: result.freqHz, swr: result.finalSwr };
      this._save('tune-memory.json', this.bandMemory);
    }

    const fMHz = this.startFreq ? (this.startFreq / 1e6).toFixed(3) : '?';
    const swrTxt = result.finalSwr ? `, SWR ${result.finalSwr.toFixed(2)}` : '';
    const text = result.ok
      ? `Tune COMPLETE on ${fMHz} MHz in ${(durationMs / 1000).toFixed(1)}s${swrTxt}`
      : `Tune FAILED (${reason}) on ${fMHz} MHz after ${(durationMs / 1000).toFixed(1)}s`;
    log('info', 'TUNE', text);
    bus.emit('tune', { state: this.snapshot(), result });
    bus.emit('event', { ts: result.ts, kind: result.ok ? 'success' : 'warn', tag: 'TUNE', text });
    this._notify(text, result);
  }

  historyCsv() {
    const esc = (v) => (v == null ? '' : String(v));
    const rows = [['timestamp', 'band', 'freq_mhz', 'result', 'reason', 'source', 'duration_s', 'swr']];
    for (const h of [...this.history].reverse()) {
      rows.push([
        h.ts, esc(h.band), h.freqHz ? (h.freqHz / 1e6).toFixed(6) : '',
        h.ok ? 'complete' : 'failed', h.reason, esc(h.source),
        (h.durationMs / 1000).toFixed(1), h.finalSwr ? h.finalSwr.toFixed(2) : '',
      ]);
    }
    return rows.map((r) => r.join(',')).join('\n') + '\n';
  }

  _notify(text, result) {
    const n = this.cfg.notify || {};
    if (!n.url) return;
    try {
      const u = new URL(n.url);
      const isNtfy = /ntfy/i.test(u.hostname) || n.style === 'ntfy';
      const body = isNtfy ? text : JSON.stringify({ event: 'tune', text, ...result });
      const opts = {
        method: 'POST',
        headers: isNtfy
          ? { Title: 'ACOM Tuner', Priority: result.ok ? 'default' : 'high', Tags: result.ok ? 'white_check_mark' : 'warning' }
          : { 'Content-Type': 'application/json' },
      };
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request(u, opts, (res) => res.resume());
      req.on('error', (e) => log('warn', 'TUNE', `Notification failed: ${e.message}`));
      req.end(body);
    } catch (e) {
      log('warn', 'TUNE', `Bad notify.url in config: ${e.message}`);
    }
  }

  snapshot() {
    return {
      tuning: this.tuning,
      source: this.tuning ? this.source : null,
      sinceMs: this.tuning ? Date.now() - this.startedAt : null,
      history: this.history,
      bandMemory: this.bandMemory,
    };
  }

  _emitState() { bus.emit('tune', { state: this.snapshot(), result: null }); }
}

module.exports = { TuneController };
