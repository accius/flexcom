'use strict';
const { SerialPort } = require('serialport');
const { log, printable } = require('./log');

const FLEX_TO_KENWOOD_MODE = {
  LSB: '1', USB: '2', CW: '3', FM: '4', NFM: '4', DFM: '4',
  AM: '5', SAM: '5', DIGL: '6', RTTY: '6', DIGU: '9',
};

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
    this.shadow = { mode: null, power: null, ai: '0' };
  }

  open() {
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
      log('info', 'CAT', `Serial open on ${this.cfg.serial.port} @ ${this.cfg.serial.baudRate} - waiting for the ACOM CAT port.`);
    });

    this.port.on('data', (b) => this._onData(b));
    this.port.on('close', () => { log('warn', 'CAT', 'Serial closed; reopening in 5s.'); setTimeout(() => this.open(), 5000); });
    this.port.on('error', (e) => log('error', 'CAT', `Serial error: ${e.message}`));
  }

  reply(s) {
    log('debug', 'CAT', `>> ${printable(s)}`);
    this.port.write(s);
  }

  _onData(buf) {
    this.buf += buf.toString('ascii');
    let i;
    while ((i = this.buf.indexOf(';')) >= 0) {
      const cmd = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (cmd) this._onCommand(cmd);
    }
    if (this.buf.length > 64) {
      log('warn', 'CAT', `Discarding unterminated garbage: ${printable(this.buf)}`);
      this.buf = '';
    }
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
          const s = this.flex.txSlice();
          return this.reply(`${name}${String(s ? s.freq : 0).padStart(11, '0')};`);
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

      default:
        log('warn', 'CAT', `Unhandled command from amp: '${printable(cmd + ';')}' -> '?;' (CAPTURE THIS).`);
        return this.reply('?;');
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
    const f = String(s ? s.freq : 0).padStart(11, '0');
    const tx = this.tuner.tuning ? '1' : '0';
    const md = this.shadow.mode !== null
      ? this.shadow.mode
      : (s && FLEX_TO_KENWOOD_MODE[s.mode]) || '2';
    return 'IF' + f + '     ' + '+0000' + '0' + '0' + '0' + '00' + tx + md + '0' + '0' + '0' + '0' + '00' + '0' + ';';
  }
}

module.exports = { CatEmulator };
