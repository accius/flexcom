'use strict';
const https = require('https');
const http = require('http');
const { log, bus } = require('./log');

/**
 * Tune-sequence state machine + completion reporting.
 * Start: amp sends TX; over CAT.  End: amp sends RX; (or safety timeout).
 * On completion, emits a 'tune' event for the dashboard and optionally
 * fires a push notification (generic JSON webhook, or ntfy.sh plain text).
 */
class TuneController {
  constructor(cfg, flex, getTelemetry) {
    this.cfg = cfg;
    this.flex = flex;
    this.getTelemetry = getTelemetry || (() => null);
    this.tuning = false;
    this.startedAt = 0;
    this.startFreq = null;
    this.peakSwr = null;
    this.lastSwr = null;
    this.timeoutTimer = null;
    this.history = [];   // last 20 tune cycles
  }

  start(requestedWatts) {
    const watts = (this.cfg.tune.followAmpPowerRequest && requestedWatts)
      ? requestedWatts : this.cfg.tune.tunePowerDefault;
    const s = this.flex.txSlice();
    this.startFreq = s ? s.freq : null;
    this.peakSwr = null;
    this.lastSwr = null;
    log('info', 'TUNE', `Tune START -> carrier ${watts} W @ ${this.startFreq ? (this.startFreq / 1e6).toFixed(3) + ' MHz' : '?'}`);
    this.tuning = true;
    this.startedAt = Date.now();
    this.flex.enforceAtuBypass('pre-tune');   // belt & suspenders
    this.flex.setTunePower(watts);
    this.flex.tune(true);
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

  stop(reason = 'amp RX') {
    if (!this.tuning) return;
    const durationMs = Date.now() - this.startedAt;
    this.tuning = false;
    clearTimeout(this.timeoutTimer);
    this.flex.tune(false);

    const tel = this.getTelemetry();
    const result = {
      ts: new Date().toISOString(),
      ok: reason !== 'timeout',
      reason,
      durationMs,
      freqHz: this.startFreq,
      finalSwr: this.lastSwr,             // SWR at amp output near end of cycle
      band: tel && tel.band ? tel.band : null,
    };
    this.history.unshift(result);
    this.history = this.history.slice(0, 20);

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
      sinceMs: this.tuning ? Date.now() - this.startedAt : null,
      history: this.history,
    };
  }

  _emitState() { bus.emit('tune', { state: this.snapshot(), result: null }); }
}

module.exports = { TuneController };
