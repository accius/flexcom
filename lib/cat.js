'use strict';
const { SerialPort } = require('serialport');
const { log, printable, bus } = require('./log');

const FLEX_TO_KENWOOD_MODE = {
  LSB: '1', USB: '2', CW: '3', FM: '4', NFM: '4', DFM: '4',
  AM: '5', SAM: '5', DIGL: '6', RTTY: '6', DIGU: '9',
};

// Every Kenwood command the emulator understands - used to salvage
// RFI-garbled input (see the default case in _onCommand).
const KNOWN_COMMANDS = new Set(['ID', 'AI', 'PS', 'FA', 'FB', 'IF', 'MD', 'PC', 'TX', 'RX', 'FR', 'FT', 'VS', 'RM', 'SM']);

/**
 * Impersonates a Kenwood TS-2000 on the serial port the ACOM's CAT
 * interface is plugged into. Mode changes are swallowed into shadow
 * registers, TX/RX map to the Flex tune carrier, bogus frequency writes
 * are dropped.
 */
class CatEmulator {
  constructor(cfg, flex, tuner) {
    this.cfg = cfg;
    this.flex = flex;
    this.tuner = tuner;
    this.buf = '';
    this.port = null;
    this.isOpen = false;
    this.lastRxAt = null;
    this.lastGarbageAt = null;
    this.garbageCount = 0;
    this._lastRawChunk = null;
    this._garbageWarnAt = 0;
    this._lastPublish = 0;
    this.shadow = { mode: null, power: null, ai: '0' };
  }

  snapshot() {
    return {
      configured: !!this.cfg.serial.port,
      open: this.isOpen,
      lastRxAt: this.lastRxAt,
      lastGarbageAt: this.lastGarbageAt,
      garbageCount: this.garbageCount,
    };
  }

  _publish(force) {
    const now = Date.now();
    if (!force && now - this._lastPublish < 2000) return;
    this._lastPublish = now;
    bus.emit('cat', this.snapshot());
  }

  open() {
    if (!this.cfg.serial.port) {
      log('info', 'CAT', 'CAT serial port not configured yet - pick it in dashboard Settings.');
      return;
    }
    this.port = new SerialPort({
      path: this.cfg.serial.port,
      baudRate: this.cfg.serial.baudRate,
      dataBits: this.cfg.serial.dataBits || 8,
      stopBits: this.cfg.serial.stopBits || 1,
      parity: this.cfg.serial.parity || 'none',
      autoOpen: false,
    });

    this.port.open((err) => {
      if (err) {
        log('error', 'CAT', `Cannot open ${this.cfg.serial.port}: ${err.message}. Retrying in 5s.`);
        setTimeout(() => this.open(), 5000);
        return;
      }
      this.isOpen = true;
      this._publish(true);
      log('info', 'CAT', `Serial open on ${this.cfg.serial.port} @ ${this.cfg.serial.baudRate} - waiting for the ACOM CAT port.`);
    });

    this.port.on('data', (b) => this._onData(b));
    this.port.on('close', () => {
      this.isOpen = false;
      this._publish(true);
      log('warn', 'CAT', 'Serial closed; reopening in 5s.');
      setTimeout(() => this.open(), 5000);
    });
    this.port.on('error', (e) => log('error', 'CAT', `Serial error: ${e.message}`));
  }

  reply(s) {
    log('debug', 'CAT', `>> ${printable(s)}`);
    this.port.write(s);
  }

  _onData(buf) {
    this.lastRxAt = new Date().toISOString();
    this._lastRawChunk = buf;
    this._publish();
    this.buf += buf.toString('ascii');
    let i;
    while ((i = this.buf.indexOf(';')) >= 0) {
      const cmd = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (cmd) this._onCommand(cmd);
    }
    if (this.buf.length > 64) this._onGarbage();
  }

  /**
   * A steady stream of non-CAT bytes almost always means the amp and the
   * bridge disagree on baud rate (or protocol/level). Log a raw hex sample
   * so the mismatch is diagnosable, and surface a hint - throttled, since
   * a wrong baud produces this every few seconds forever.
   */
  _onGarbage() {
    this.garbageCount++;
    this.lastGarbageAt = new Date().toISOString();
    const now = Date.now();
    if (now - this._garbageWarnAt > 60000) {
      this._garbageWarnAt = now;
      const hex = this._lastRawChunk ? this._lastRawChunk.toString('hex') : '';
      log('warn', 'CAT', `Receiving garbage instead of CAT commands (raw sample hex=${hex}). ` +
        `This usually means a baud/protocol mismatch: set the amp CAT menu to KENWOOD / RS232 / ` +
        `${this.cfg.serial.baudRate} baud (or change the baud in dashboard Settings to match the amp), ` +
        `and verify the cable is a proper RS-232 level cable, not a TTL adapter.`);
    } else {
      log('debug', 'CAT', `Discarding unterminated garbage: ${printable(this.buf)}`);
    }
    this.buf = '';
    this._publish();
  }

  _onCommand(cmd) {
    log('debug', 'CAT', `<< ${printable(cmd + ';')}`);
    const name = cmd.slice(0, 2).toUpperCase();
    const arg = cmd.slice(2);

    switch (name) {
      case 'ID': return this.reply(`ID${this.cfg.cat.identity};`);
      case 'AI':
        if (arg === '') return this.reply(`AI${this.shadow.ai};`);
        this.shadow.ai = arg;
        return;
      case 'PS': return arg === '' ? this.reply('PS1;') : undefined;

      case 'FA':
      case 'FB': {
        if (arg === '') {
          // catFreq() falls back to the last known frequency while the radio
          // link is down - never 0 Hz, which throws the amp off band.
          return this.reply(`${name}${String(this.flex.catFreq()).padStart(11, '0')};`);
        }
        return this._freqWrite(name, arg);
      }
      case 'IF': return this.reply(this._buildIF());

      case 'MD': {
        if (arg === '') {
          if (this.shadow.mode !== null) return this.reply(`MD${this.shadow.mode};`);
          const s = this.flex.txSlice();
          return this.reply(`MD${(s && FLEX_TO_KENWOOD_MODE[s.mode]) || '2'};`);
        }
        log('info', 'CAT', `Amp set mode MD${arg} -> swallowed (radio mode untouched).`);
        this.shadow.mode = arg;
        return;
      }

      case 'PC': {
        if (arg === '') {
          const w = this.shadow.power != null ? this.shadow.power : this.cfg.tune.tunePowerDefault;
          return this.reply(`PC${String(w).padStart(3, '0')};`);
        }
        const watts = parseInt(arg, 10);
        this.shadow.power = watts;
        if (this.tuner.tuning) this.tuner.updatePower(watts);
        else if (this.cfg.cat.forwardPowerOutsideTune) this.flex.setRfPower(watts);
        else log('info', 'CAT', `Amp set PC${arg} outside tune -> shadowed only.`);
        return;
      }

      case 'TX':
        log('info', 'CAT', 'Amp requested TX -> starting tune carrier.');
        this.tuner.start(this.shadow.power);
        return;
      case 'RX':
        log('info', 'CAT', 'Amp requested RX -> ending tune carrier.');
        this.tuner.stop('amp RX');
        this.shadow.mode = null;
        return;

      case 'FR': return arg === '' ? this.reply('FR0;') : undefined;
      case 'FT': return arg === '' ? this.reply('FT0;') : undefined;
      case 'VS': return arg === '' ? this.reply('VS0;') : undefined;
      case 'RM': return arg === '' ? this.reply('RM00000;') : undefined;
      case 'SM': return this.reply('SM00000;');

      default: {
        // RF getting into the serial line during/after TX can corrupt or
        // prepend bytes to a poll (seen live: 'FFAFA;' = mangled FA polls).
        // If the tail of the junk is a valid command, salvage and answer it
        // so the amp's band-following never skips a beat.
        const m = cmd.match(/([A-Za-z]{2}[0-9]*)$/);
        if (m && m[1] !== cmd && KNOWN_COMMANDS.has(m[1].slice(0, 2).toUpperCase())) {
          log('warn', 'CAT', `Garbled command '${printable(cmd + ';')}' -> salvaged '${m[1]};' (RFI on the CAT cable? Add clamp-on ferrites at both ends).`);
          return this._onCommand(m[1]);
        }
        log('warn', 'CAT', `Unhandled command from amp: '${printable(cmd + ';')}' -> '?;' (CAPTURE THIS).`);
        return this.reply('?;');
      }
    }
  }

  _freqWrite(which, arg) {
    const hz = parseInt(arg, 10);
    if (!Number.isFinite(hz) || hz < (this.cfg.cat.minValidFreqHz || 1800000)) {
      log('warn', 'CAT', `BLOCKED bogus ${which} write from amp: '${arg}' (freq-jump bug).`);
      return;
    }
    if (!this.cfg.cat.allowFreqWritesFromAmp) {
      log('info', 'CAT', `Dropped ${which}${arg}; (freq writes from amp disabled).`);
      return;
    }
    const s = this.flex.txSlice();
    if (s) this.flex.send(`slice tune ${s.index} ${(hz / 1e6).toFixed(6)}`);
  }

  _buildIF() {
    const s = this.flex.txSlice();
    const f = String(this.flex.catFreq()).padStart(11, '0');
    const tx = this.tuner.tuning ? '1' : '0';
    const md = this.shadow.mode !== null
      ? this.shadow.mode
      : (s && FLEX_TO_KENWOOD_MODE[s.mode]) || '2';
    return 'IF' + f + '     ' + '+0000' + '0' + '0' + '0' + '00' + tx + md + '0' + '0' + '0' + '0' + '00' + '0' + ';';
  }
}

module.exports = { CatEmulator };
