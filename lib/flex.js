'use strict';
const net = require('net');
const { log, printable, bus } = require('./log');

/**
 * Native SmartSDR TCP API client (port 4992).
 * Client-agnostic: binds to whatever GUI client (SmartSDR, AetherSDR,
 * Maestro, or an M-model front panel) is driving the radio, and rebinds
 * when clients come and go. The dashboard can also pin a specific client.
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
    this.pinnedClientId = null;   // user picked a client in the dashboard
    this.atuStatus = null;
    this.interlockState = null;
    this.transmit = {};           // rfpower, tunepower, tune - from transmit status
    this.radioInfo = {};          // nickname, callsign - from radio status
    this.pingTimer = null;
    this._atuReassertAt = 0;
    this._atuFights = 0;
  }

  // Statuses where the internal ATU is NOT inline: bypassed, absent, or
  // never engaged. TUNE_NOT_STARTED is the 6000/8000-series idle state.
  _atuIsSafe(status) { return /BYPASS|NONE|NOT_STARTED/i.test(status || ''); }

  connect() {
    if (!this.cfg.flex.host) {
      log('info', 'FLEX', 'Radio IP not configured yet - pick it in dashboard Settings.');
      return;
    }
    log('info', 'FLEX', `Connecting to ${this.cfg.flex.host}:${this.cfg.flex.port} ...`);
    this.sock = net.createConnection({ host: this.cfg.flex.host, port: this.cfg.flex.port });
    this.sock.setNoDelay(true);

    this.sock.on('connect', () => {
      this.connected = true;
      log('info', 'FLEX', 'Connected to radio.');
      bus.emit('event', { ts: new Date().toISOString(), kind: 'info', tag: 'FLEX', text: 'Connected to radio' });
      this._programSeq = this.send('client program AcomFlexBridge');
      this.send('sub slice all');
      this.send('sub tx all');
      this.send('sub client all');
      this.send('sub atu all');
      this.send('sub radio all');
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
      this.interlockState = null;
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
      if (parts[1] && parts[1] !== '0') {
        // Some firmware (FLEX-8400M) rejects 'client program' registration
        // outright - purely cosmetic, everything works without it.
        if (parseInt(parts[0], 10) === this._programSeq) {
          log('info', 'FLEX', 'Radio declined client-program registration (normal on 8400M firmware) - continuing.');
        } else {
          log('warn', 'FLEX', `Command reply error: ${line}`);
        }
      }
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

    if (type === 'transmit') {
      const kv = this._kv(tokens.slice(1));
      if (kv.rfpower !== undefined) this.transmit.rfpower = parseInt(kv.rfpower, 10);
      if (kv.tunepower !== undefined) this.transmit.tunepower = parseInt(kv.tunepower, 10);
      if (kv.tune !== undefined) this.transmit.tune = kv.tune === '1';
      this._publish();
    }

    if (type === 'interlock') {
      const kv = this._kv(tokens.slice(1));
      if (kv.state !== undefined) {
        this.interlockState = kv.state;
        this._publish();
      }
    }

    if (type === 'radio') {
      const kv = this._kv(tokens.slice(1));
      if (kv.nickname !== undefined) this.radioInfo.nickname = kv.nickname;
      if (kv.callsign !== undefined) this.radioInfo.callsign = kv.callsign;
      if (kv.nickname !== undefined || kv.callsign !== undefined) this._publish();
    }

    if (type === 'atu') {
      const kv = this._kv(tokens.slice(1));
      if (kv.status !== undefined) {
        this.atuStatus = kv.status;
        this._publish();
        // Enforce bypass: if the ATU reports an engaged state, put it back.
        // Rate-limited, and backing off if the radio keeps re-engaging it
        // (usually an ATU memory being re-applied on every QSY).
        if (this.cfg.flex.enforceAtuBypass !== false && !this._atuIsSafe(kv.status)) {
          const now = Date.now();
          const interval = this._atuFights >= 5 ? 30000 : 3000;
          if (now - this._atuReassertAt > interval) {
            this._atuReassertAt = now;
            this._atuFights++;
            log('warn', 'FLEX', `Internal ATU engaged (status=${kv.status}) -> forcing BYPASS (amp + external tuner in line).`);
            if (this._atuFights === 5) {
              log('warn', 'FLEX', 'The radio keeps re-engaging its internal ATU - it is most likely re-applying an ATU memory on QSY. Disable ATU memories in SmartSDR (ATU panel -> MEM off) and clear them; backing off to one re-assert per 30s.');
            }
            this.enforceAtuBypass('atu status change');
          }
        } else if (this._atuIsSafe(kv.status)) {
          this._atuFights = 0;
        }
      }
    }

    if (type === 'client') {
      const handle = tokens[1];
      const verb = tokens[2];
      const kv = this._kv(tokens.slice(2));
      if (verb === 'connected' && kv.client_id && kv.program &&
          kv.program !== 'acom-flex-bridge' && kv.program !== 'AcomFlexBridge') {
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
    const clients = [...this.guiClients.values()];
    let pick = this.pinnedClientId ? clients.find((c) => c.client_id === this.pinnedClientId) : null;
    if (!pick && this.cfg.flex.preferredClient) {
      pick = clients.find((c) => c.program === this.cfg.flex.preferredClient ||
                                 c.station === this.cfg.flex.preferredClient);
    }
    if (!pick) pick = clients[0];
    if (pick) {
      this.boundClientId = pick.client_id;
      this.send(`client bind client_id=${pick.client_id}`);
      log('info', 'FLEX', `Bound to GUI client ${pick.program} (${pick.client_id})`);
      bus.emit('event', { ts: new Date().toISOString(), kind: 'info', tag: 'FLEX', text: `Bound to ${pick.program}${pick.station ? ' / ' + pick.station : ''}` });
    } else {
      log('info', 'FLEX', 'No GUI client yet (SmartSDR/AetherSDR not running?).');
    }
  }

  /** Dashboard-driven: pin the binding to a specific GUI client. */
  bindTo(clientId) {
    this.pinnedClientId = clientId || null;
    this.boundClientId = null;
    this._maybeBind();
    this._publish();
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

  /**
   * Dashboard-driven QSY of the TX slice.
   *
   * IMPORTANT: the radio does NOT echo status updates back to the client
   * that issued a command - so for our own commands we update local state
   * optimistically. Without this, the amp's CAT polls keep getting the OLD
   * frequency after a dashboard QSY (amp stays on the previous band) even
   * though the radio itself moved. A status update from the radio (e.g. if
   * the command was rejected or clamped) still overrides this later.
   */
  qsy(hz) {
    const s = this.txSlice();
    if (!s) { log('warn', 'FLEX', 'QSY ignored: no slice.'); return; }
    if (!Number.isFinite(hz) || hz < 30000 || hz > 54000000) {
      log('warn', 'FLEX', `QSY ignored: bad frequency ${hz}.`);
      return;
    }
    log('info', 'FLEX', `QSY slice ${s.index} -> ${(hz / 1e6).toFixed(6)} MHz (dashboard).`);
    this.send(`slice tune ${s.index} ${(hz / 1e6).toFixed(6)}`);
    s.freq = hz;              // optimistic - see note above
    this._publish();
  }

  /** Dashboard-driven mode change of the TX slice (optimistic, see qsy). */
  setMode(mode) {
    const ok = /^(LSB|USB|CW|AM|SAM|FM|NFM|DFM|DIGL|DIGU|RTTY)$/i.test(String(mode));
    const s = this.txSlice();
    if (!ok || !s) { log('warn', 'FLEX', `Mode change ignored (mode=${mode}, slice=${!!s}).`); return; }
    const m = String(mode).toUpperCase();
    log('info', 'FLEX', `Mode slice ${s.index} -> ${m} (dashboard).`);
    this.send(`slice set ${s.index} mode=${m}`);
    s.mode = m;               // optimistic - see note above
    this._publish();
  }

  setTunePower(w) {
    const v = Math.max(1, Math.min(100, Math.round(w)));
    this.send(`transmit set tunepower=${v}`);
    this.transmit.tunepower = v;   // optimistic - see qsy note
    this._publish();
  }

  setRfPower(w) {
    const v = Math.max(0, Math.min(100, Math.round(w)));
    this.send(`transmit set rfpower=${v}`);
    this.transmit.rfpower = v;     // optimistic - see qsy note
    this._publish();
  }
  tune(on) { this.send(`transmit tune ${on ? 'on' : 'off'}`); }

  snapshot() {
    const bound = [...this.guiClients.values()].find((c) => c.client_id === this.boundClientId);
    const tx = this.txSlice();
    return {
      connected: this.connected,
      host: this.cfg.flex.host || '',
      radioInfo: this.radioInfo,
      boundTo: bound ? bound.program + (bound.station ? ' / ' + bound.station : '') : null,
      boundClientId: this.boundClientId,
      pinnedClientId: this.pinnedClientId,
      clients: [...this.guiClients.values()],
      atuStatus: this.atuStatus,
      interlock: this.interlockState,
      transmit: this.transmit,
      txSlice: tx ? { freq: tx.freq, mode: tx.mode, index: tx.index } : null,
      slices: [...this.slices.values()].map((s) => ({ index: s.index, freq: s.freq, mode: s.mode, tx: !!s.tx })),
    };
  }

  _publish() { bus.emit('flex', this.snapshot()); }
}

module.exports = { FlexClient };
