'use strict';
const net = require('net');
const { log, printable, bus } = require('./log');

/**
 * Native SmartSDR TCP API client (port 4992).
 * Client-agnostic: binds to whatever GUI client (SmartSDR, AetherSDR,
 * Maestro) is driving the radio, and rebinds when clients come and go.
 * Also enforces the internal ATU staying in BYPASS - mandatory when an
 * amp + external tuner hang off the radio.
 */
class FlexClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.sock = null;
    this.connected = false;
    this.seq = 0;
    this.rxBuf = '';
    this.slices = new Map();
    this.guiClients = new Map();
    this.boundClientId = null;
    this.atuStatus = null;
    this.pingTimer = null;
    this._atuReassertAt = 0;
  }

  connect() {
    log('info', 'FLEX', `Connecting to ${this.cfg.flex.host}:${this.cfg.flex.port} ...`);
    this.sock = net.createConnection({ host: this.cfg.flex.host, port: this.cfg.flex.port });
    this.sock.setNoDelay(true);

    this.sock.on('connect', () => {
      this.connected = true;
      log('info', 'FLEX', 'Connected to radio.');
      bus.emit('event', { ts: new Date().toISOString(), kind: 'info', tag: 'FLEX', text: 'Connected to radio' });
      this.send('client program acom-flex-bridge');
      this.send('sub slice all');
      this.send('sub tx all');
      this.send('sub client all');
      this.send('sub atu all');
      this.enforceAtuBypass('startup');
      this.pingTimer = setInterval(() => this.send('ping'), this.cfg.flex.pingIntervalMs || 5000);
      this._publish();
    });

    this.sock.on('data', (b) => this._onData(b));
    this.sock.on('error', (e) => { log('error', 'FLEX', `Socket error: ${e.message}`); this.sock.destroy(); });
    this.sock.on('close', () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.connected) log('warn', 'FLEX', `Connection lost; retrying in ${this.cfg.flex.reconnectDelayMs} ms`);
      this.connected = false;
      this.boundClientId = null;
      this.slices.clear();
      this.guiClients.clear();
      this._publish();
      setTimeout(() => this.connect(), this.cfg.flex.reconnectDelayMs || 3000);
    });
  }

  send(cmd) {
    const seq = ++this.seq;
    const line = `C${seq}|${cmd}\n`;
    log('debug', 'FLEX', `>> ${printable(line.trim())}`);
    try { this.sock.write(line); } catch (e) { log('error', 'FLEX', `write failed: ${e.message}`); }
    return seq;
  }

  _onData(buf) {
    this.rxBuf += buf.toString('utf8');
    let i;
    while ((i = this.rxBuf.indexOf('\n')) >= 0) {
      const line = this.rxBuf.slice(0, i).trim();
      this.rxBuf = this.rxBuf.slice(i + 1);
      if (line) this._onLine(line);
    }
  }

  _onLine(line) {
    log('debug', 'FLEX', `<< ${printable(line)}`);
    if (line[0] === 'S') {
      const bar = line.indexOf('|');
      if (bar > 0) this._onStatus(line.slice(bar + 1));
    } else if (line[0] === 'R') {
      const parts = line.slice(1).split('|');
      if (parts[1] && parts[1] !== '0') log('warn', 'FLEX', `Command reply error: ${line}`);
    } else if (line[0] === 'M') {
      log('info', 'FLEX', `Radio message: ${line}`);
    }
  }

  _kv(tokens) {
    const o = {};
    for (const t of tokens) {
      const eq = t.indexOf('=');
      if (eq > 0) o[t.slice(0, eq)] = t.slice(eq + 1);
    }
    return o;
  }

  _onStatus(status) {
    const tokens = status.split(' ').filter(Boolean);
    const type = tokens[0];

    if (type === 'slice') {
      const index = tokens[1];
      const kv = this._kv(tokens.slice(2));
      const s = this.slices.get(index) || { index };
      if (kv.RF_frequency !== undefined) s.freq = Math.round(parseFloat(kv.RF_frequency) * 1e6);
      if (kv.mode !== undefined) s.mode = kv.mode;
      if (kv.tx !== undefined) s.tx = kv.tx === '1';
      if (kv.in_use !== undefined) s.in_use = kv.in_use === '1';
      if (kv.active !== undefined) s.active = kv.active === '1';
      this.slices.set(index, s);
      if (s.in_use === false) this.slices.delete(index);
      this._publish();
    }

    if (type === 'atu') {
      const kv = this._kv(tokens.slice(1));
      if (kv.status !== undefined) {
        this.atuStatus = kv.status;
        this._publish();
        // Enforce bypass: if the ATU reports anything other than a bypass
        // state, put it back. Rate-limited to avoid fighting a user who is
        // deliberately experimenting (they can disable enforcement in config).
        if (this.cfg.flex.enforceAtuBypass !== false && !/BYPASS|NONE/i.test(kv.status)) {
          const now = Date.now();
          if (now - this._atuReassertAt > 3000) {
            this._atuReassertAt = now;
            log('warn', 'FLEX', `Internal ATU left bypass (status=${kv.status}) -> forcing BYPASS (amp + external tuner in line).`);
            this.enforceAtuBypass('atu status change');
          }
        }
      }
    }

    if (type === 'client') {
      const handle = tokens[1];
      const verb = tokens[2];
      const kv = this._kv(tokens.slice(2));
      if (verb === 'connected' && kv.client_id && kv.program && kv.program !== 'acom-flex-bridge') {
        this.guiClients.set(handle, { client_id: kv.client_id, program: kv.program, station: kv.station || '' });
        log('info', 'FLEX', `GUI client present: ${kv.program} (${kv.station || 'no station'})`);
        this._maybeBind();
        this._publish();
      }
      if (verb === 'disconnected') {
        const gone = this.guiClients.get(handle);
        this.guiClients.delete(handle);
        if (gone && gone.client_id === this.boundClientId) {
          log('warn', 'FLEX', `Bound client ${gone.program} disconnected; rebinding.`);
          this.boundClientId = null;
          this._maybeBind();
        }
        this._publish();
      }
    }
  }

  _maybeBind() {
    if (this.boundClientId) return;
    const first = this.guiClients.values().next().value;
    if (first) {
      this.boundClientId = first.client_id;
      this.send(`client bind client_id=${first.client_id}`);
      log('info', 'FLEX', `Bound to GUI client ${first.program} (${first.client_id})`);
      bus.emit('event', { ts: new Date().toISOString(), kind: 'info', tag: 'FLEX', text: `Bound to ${first.program}` });
    } else {
      log('info', 'FLEX', 'No GUI client yet (SmartSDR/AetherSDR not running?).');
    }
  }

  txSlice() {
    let fallback = null;
    for (const [, s] of this.slices) {
      if (s.tx && s.in_use !== false) return s;
      if (s.active && !fallback) fallback = s;
    }
    return fallback || this.slices.values().next().value || null;
  }

  enforceAtuBypass(reason) {
    if (this.cfg.flex.enforceAtuBypass === false) return;
    log('info', 'FLEX', `ATU -> bypass (${reason}).`);
    this.send('atu bypass');
  }

  setTunePower(w) { this.send(`transmit set tunepower=${Math.max(1, Math.min(100, Math.round(w)))}`); }
  setRfPower(w) { this.send(`transmit set rfpower=${Math.max(0, Math.min(100, Math.round(w)))}`); }
  tune(on) { this.send(`transmit tune ${on ? 'on' : 'off'}`); }

  snapshot() {
    const bound = [...this.guiClients.values()].find((c) => c.client_id === this.boundClientId);
    const tx = this.txSlice();
    return {
      connected: this.connected,
      boundTo: bound ? bound.program : null,
      clients: [...this.guiClients.values()].map((c) => c.program),
      atuStatus: this.atuStatus,
      txSlice: tx ? { freq: tx.freq, mode: tx.mode, index: tx.index } : null,
      slices: [...this.slices.values()].map((s) => ({ index: s.index, freq: s.freq, mode: s.mode, tx: !!s.tx })),
    };
  }

  _publish() { bus.emit('flex', this.snapshot()); }
}

module.exports = { FlexClient };
