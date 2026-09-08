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
    this.lastTxFreq = null;       // last good TX-slice frequency, survives link loss
    this.pending = new Map();     // seq -> reply callback (cmd, err)
    this.isTuning = () => false;  // wired by bridge.js to the tune controller
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
      // Safety: if the link dropped mid-tune, the radio may still be keyed
      // with our old (dead) session's carrier. Drop it before anything else.
      // Errors are expected when nothing is keyed - swallow them.
      this.send('transmit tune off', () => {});
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
      for (const cb of this.pending.values()) { try { cb('radio link lost'); } catch {} }
      this.pending.clear();
      this._publish();
      setTimeout(() => this.connect(), this.cfg.flex.reconnectDelayMs || 3000);
    });
  }

  /**
   * Send a command. Optional cb(err) fires on the radio's reply: err is null
   * on success, the radio's message text (or hex code) on failure, and
   * 'radio link lost' / 'not connected' if it could never be delivered.
   */
  send(cmd, cb) {
    const seq = ++this.seq;
    const line = `C${seq}|${cmd}\n`;
    if (!this.connected || !this.sock || this.sock.destroyed) {
      log('warn', 'FLEX', `Not connected - dropped '${cmd}'.`);
      if (cb) cb('not connected');
      return seq;
    }
    log('debug', 'FLEX', `>> ${printable(line.trim())}`);
    if (cb) this.pending.set(seq, cb);
    try { this.sock.write(line); } catch (e) {
      log('error', 'FLEX', `write failed: ${e.message}`);
      this.pending.delete(seq);
      if (cb) cb(e.message);
    }
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
      const seq = parseInt(parts[0], 10);
      const failed = !!(parts[1] && parts[1] !== '0');
      const cb = this.pending.get(seq);
      this.pending.delete(seq);
      if (cb) {
        cb(failed ? (parts[2] || `error ${parts[1]}`) : null);
      } else if (failed) {
        // Some firmware (FLEX-8400M) rejects 'client program' registration
        // outright - purely cosmetic, everything works without it.
        if (seq === this._programSeq) {
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
      if (kv.client_handle !== undefined) s.handle = kv.client_handle;
      this.slices.set(index, s);
      if (s.in_use === false) this.slices.delete(index);
      this._maybeRebindForSlices();
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
        this.guiClients.set(handle, { handle, client_id: kv.client_id, program: kv.program, station: kv.station || '' });
        log('info', 'FLEX', `GUI client present: ${kv.program} (${kv.station || 'no station'})`);
        this._maybeBind();
        this._maybeRebindForSlices();   // a better-equipped client may have just appeared
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

  /** Slices owned by a given GUI client handle (0x... as the radio reports it). */
  _slicesOf(handle) {
    return [...this.slices.values()].filter((s) => s.handle === handle);
  }

  /**
   * Auto-bind preference (when the user hasn't pinned a client and no
   * preferredClient matches): a client that owns a TX slice, then one that
   * owns any slice, then whatever is first. Binding to a client with no
   * slices (typically an M-model front panel sitting idle) would key the
   * radio on nothing - or, worse, on a slice the amp was never told about.
   */
  _autoPick(clients) {
    return clients.find((c) => this._slicesOf(c.handle).some((s) => s.tx))
        || clients.find((c) => this._slicesOf(c.handle).length)
        || clients[0];
  }

  _maybeBind() {
    if (this.boundClientId) return;
    const clients = [...this.guiClients.values()];
    let pick = this.pinnedClientId ? clients.find((c) => c.client_id === this.pinnedClientId) : null;
    if (!pick && this.cfg.flex.preferredClient) {
      pick = clients.find((c) => c.program === this.cfg.flex.preferredClient ||
                                 c.station === this.cfg.flex.preferredClient);
    }
    if (!pick) pick = this._autoPick(clients);
    if (pick) {
      this.boundClientId = pick.client_id;
      this.send(`client bind client_id=${pick.client_id}`);
      log('info', 'FLEX', `Bound to GUI client ${pick.program} (${pick.client_id})`);
      bus.emit('event', { ts: new Date().toISOString(), kind: 'info', tag: 'FLEX', text: `Bound to ${pick.program}${pick.station ? ' / ' + pick.station : ''}` });
    } else {
      log('info', 'FLEX', 'No GUI client yet (SmartSDR/AetherSDR not running?).');
    }
  }

  /**
   * In auto mode, move the binding when the bound client owns no TX slice
   * but another one does (SmartSDR restarted after a crash while we sat on
   * the front panel, for example). Never mid-tune, never when pinned.
   */
  _maybeRebindForSlices() {
    if (!this.boundClientId || this.pinnedClientId || this.isTuning()) return;
    const bound = this._boundClient();
    if (!bound || this._slicesOf(bound.handle).some((s) => s.tx)) return;
    const better = [...this.guiClients.values()].find((c) => c !== bound && this._slicesOf(c.handle).some((s) => s.tx));
    if (!better) return;
    log('warn', 'FLEX', `Bound client ${bound.program} owns no TX slice; ${better.program} does -> rebinding.`);
    this.boundClientId = null;
    this._maybeBind();
  }

  _boundClient() {
    return [...this.guiClients.values()].find((c) => c.client_id === this.boundClientId) || null;
  }

  /** Dashboard-driven: pin the binding to a specific GUI client. */
  bindTo(clientId) {
    this.pinnedClientId = clientId || null;
    this.boundClientId = null;
    this._maybeBind();
    this._publish();
  }

  /**
   * The slice the radio will actually key when WE say 'transmit tune on':
   * the TX slice of the GUI client we are bound to. Slices owned by other
   * clients are never returned - reporting one of those to the amp while
   * the radio keys a different one means RF on a band the amp isn't set
   * for. Slices with no owner info (older firmware) are used only when the
   * bound client owns nothing we know of.
   */
  txSlice() {
    const bound = this._boundClient();
    if (!bound) return null;
    const own = this._slicesOf(bound.handle).filter((s) => s.in_use !== false);
    const pool = own.length ? own : [...this.slices.values()].filter((s) => !s.handle && s.in_use !== false);
    return pool.find((s) => s.tx) || pool.find((s) => s.active) || pool[0] || null;
  }

  /**
   * Frequency to report to the amp over CAT: the live TX slice, or the last
   * one we knew while the radio link is down / rebinding. Never 0 Hz - that
   * throws the amp off band, which is the bug this bridge exists to stop.
   */
  catFreq() {
    const s = this.txSlice();
    if (s && s.freq) return s.freq;
    return this.lastTxFreq || 0;
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
  tune(on, cb) { this.send(`transmit tune ${on ? 'on' : 'off'}`, cb); }

  snapshot() {
    const bound = this._boundClient();
    const tx = this.txSlice();
    if (tx && tx.freq) this.lastTxFreq = tx.freq;
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
      slices: [...this.slices.values()].map((s) => ({
        index: s.index, freq: s.freq, mode: s.mode, tx: !!s.tx,
        owner: (this.guiClients.get(s.handle) || {}).program || null,
        mine: !!bound && s.handle === bound.handle,
      })),
    };
  }

  _publish() { bus.emit('flex', this.snapshot()); }
}

module.exports = { FlexClient };
