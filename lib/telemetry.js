'use strict';
const { SerialPort } = require('serialport');
const { log, bus } = require('./log');

/**
 * ACOM S-series REMOTE RS-232 port driver (the second serial port on the
 * amp - NOT the CAT/AUX port the CatEmulator uses). Two jobs:
 *
 *   1. Telemetry: ask the amp to stream its measurement telegram and parse
 *      it into gauges (power, SWR, PA temp, status, band, errors).
 *   2. Control: OPERATE / STANDBY / power OFF commands.
 *
 * Frame format (official ACOM 600S Serial Port Communication Protocol,
 * shared by the whole S-series; telegrams and field layout cross-checked
 * against SM7IUN's ACOM-Controller, which drives the same amps):
 *   Byte 0: start tag 0x55
 *   Byte 1: address (message type)
 *   Byte 2: length (total frame bytes)
 *   ...payload...
 *   Byte N: checksum, chosen so SUM(Byte0..ByteN) & 0xFF == 0
 *
 * Known telegrams:
 *   0x55 0x92 0x04 0x15                      telemetry stream ON
 *   0x55 0x91 0x04 0x16                      telemetry stream OFF
 *   0x55 0x81 0x08 0x02 0x00 <st> 0x00 <ck>  request PA state:
 *        st=0x06 OPERATE   st=0x05 STANDBY   st=0x0A power OFF
 *   0x55 0x2F <len> ...                      measurement telegram
 *     (72 bytes, streamed several times per second while enabled)
 *
 * Measurement telegram fields (offsets from frame start, u16 = 16-bit LE):
 *   [3]  hi nibble = PA status (1 RESET, 2 INIT, 5 STANDBY, 6 OPERATE/RX,
 *        7 TRANSMIT, 10 powering OFF)
 *   [8]  u16/10  = DC input power, W
 *   [16] u16 - tempOffset = PA temperature, deg C (offset is per-model)
 *   [20] u16/10  = drive power, W
 *   [22] u16     = forward power, W
 *   [24] u16     = reflected power, W
 *   [26] u16/100 = SWR
 *   [66] error code (0xFF = none)
 *   [69] lo nibble = band code, hi nibble = fan speed
 *
 * Remote power-ON is NOT possible with the recommended pins-2/3/5 cable:
 * the amp powers on via the RS-232 handshake lines, which stay unwired on
 * purpose (see HOOKUP.md) so a stuck line can never power-cycle the amp.
 */

const MEASUREMENT_ADDR = 0x2F;

const PA_STATUS = {
  1: 'RESET', 2: 'INIT', 5: 'STANDBY', 6: 'OPERATE', 7: 'TRANSMIT', 10: 'POWERING OFF',
};

const BAND_NAMES = ['?', '160m', '80m', '40/60m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '4m', '?', '?', '?', '?'];

// Per-model calibration of the raw temperature word (ACOM-Controller values).
const TEMP_OFFSET = { '500S': 282, '600S': 273, '700S': 282, '1200S': 281, '2020S': 282 };

const ERROR_TEXT = {
  0x00: 'Hot switching', 0x08: 'Hot switching',
  0x04: 'Reflected power warning', 0x05: 'Reflected power warning',
  0x06: 'Drive power too high', 0x07: 'Drive power too high',
  0x24: 'Excessive PAM current', 0x25: 'Excessive PAM current',
  0x39: 'Excessive PAM current', 0x44: 'Excessive PAM current',
  0x45: 'Excessive PAM current', 0x59: 'Excessive PAM current',
  // 0x70 is the documented CAT error; 0x71-0x73 observed on a live 700S
  // alongside a broken CAT link, so they are mapped to the same family.
  0x70: 'CAT error', 0x71: 'CAT error', 0x72: 'CAT error', 0x73: 'CAT error',
};

// SWR readings outside this window are relay-switching transients or
// no-carrier garbage - never a real match result.
const SWR_SANE_MAX = 25;

function frame(bytes) {
  const buf = Buffer.from([...bytes, 0]);
  let sum = 0;
  for (let i = 0; i < buf.length - 1; i++) sum = (sum + buf[i]) & 0xFF;
  buf[buf.length - 1] = (256 - sum) & 0xFF;
  return buf;
}

class AcomTelemetry {
  constructor(cfg) {
    this.cfg = cfg.telemetry || {};
    this.port = null;
    this.opened = false;
    this.buf = Buffer.alloc(0);
    this.keepaliveTimer = null;
    this.seenAddresses = new Map(); // addr -> count
    this._errEventAt = new Map();   // errorCode -> last event-feed emit ms
    this.state = {
      connected: false,
      lastFrameAt: null,
      paStatus: null, paStatusCode: null,
      band: null, fanSpeed: null,
      fwdPower: null, reflPower: null, swr: null,
      drivePower: null, dcPower: null,
      tempC: null,
      errorCode: null, errorText: null,
    };
    this.onSwr = () => {};
  }

  open() {
    if (this.cfg.enabled === false) {
      log('info', 'AMP', 'Telemetry disabled in config (telemetry.enabled=false).');
      return;
    }
    if (!this.cfg.port) {
      log('info', 'AMP', 'Telemetry serial port not configured yet - pick it in dashboard Settings.');
      return;
    }
    this.port = new SerialPort({
      path: this.cfg.port,
      baudRate: this.cfg.baudRate || 9600,
      dataBits: 8, stopBits: 1, parity: 'none',
      autoOpen: false,
    });

    this.port.open((err) => {
      if (err) {
        log('error', 'AMP', `Cannot open telemetry port ${this.cfg.port}: ${err.message}. Retrying in 5s.`);
        setTimeout(() => this.open(), 5000);
        return;
      }
      // CRITICAL: the S-series uses the RS-232 handshake lines for remote
      // power on/off. Hold DTR and RTS LOW so we don't block the front
      // panel power button or power-cycle the amp.
      this.port.set({ dtr: false, rts: false }, (e) => {
        if (e) log('warn', 'AMP', `Could not clear DTR/RTS: ${e.message}`);
      });
      this.opened = true;
      this.state.connected = true;
      log('info', 'AMP', `Telemetry port open on ${this.cfg.port} @ ${this.cfg.baudRate || 9600} (DTR/RTS held low).`);
      this._startKeepalive();
      this._publish();
    });

    this.port.on('data', (b) => this._onData(b));
    this.port.on('close', () => {
      this.opened = false;
      this.state.connected = false;
      this._stopKeepalive();
      this._publish();
      log('warn', 'AMP', 'Telemetry serial closed; reopening in 5s.');
      setTimeout(() => this.open(), 5000);
    });
    this.port.on('error', (e) => log('error', 'AMP', `Telemetry serial error: ${e.message}`));
  }

  /**
   * The amp only streams measurement telegrams while telemetry is enabled,
   * and it forgets that across a power cycle - so the enable telegram is
   * re-sent periodically as a keepalive (ACOM-Controller does the same).
   */
  _startKeepalive() {
    this._stopKeepalive();
    const send = () => { if (this.opened) this.port.write(frame([0x55, 0x92, 0x04])); };
    send();
    this.keepaliveTimer = setInterval(send, this.cfg.keepaliveMs || 1000);
  }

  _stopKeepalive() {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  _command(bytes, what, kind = 'info') {
    if (!this.opened) {
      log('warn', 'AMP', `Cannot send ${what}: telemetry port not open.`);
      return false;
    }
    const buf = frame(bytes);
    log('info', 'AMP', `>> ${what}: ${buf.toString('hex')}`);
    this.port.write(buf);
    bus.emit('event', { ts: new Date().toISOString(), kind, tag: 'AMP', text: what });
    return true;
  }

  operate() { this._command([0x55, 0x81, 0x08, 0x02, 0x00, 0x06, 0x00], 'OPERATE requested'); }
  standby() { this._command([0x55, 0x81, 0x08, 0x02, 0x00, 0x05, 0x00], 'STANDBY requested'); }

  powerOff() {
    if (this.cfg.allowPowerControl === false) {
      log('warn', 'AMP', 'Power-off blocked: telemetry.allowPowerControl=false.');
      return;
    }
    this._command([0x55, 0x81, 0x08, 0x02, 0x00, 0x0A, 0x00],
      'Power OFF requested (power back on at the front panel)', 'warn');
  }

  _onData(buf) {
    this.buf = Buffer.concat([this.buf, buf]);
    // Scan for frames: 0x55 <addr> <len> ... <checksum>, full sum == 0 mod 256.
    let progressed = true;
    while (progressed) {
      progressed = false;
      const start = this.buf.indexOf(0x55);
      if (start < 0) { this.buf = Buffer.alloc(0); return; }
      if (start > 0) this.buf = this.buf.subarray(start);
      if (this.buf.length < 4) return;

      const len = this.buf[2];
      // Length byte semantics differ across docs; try both interpretations.
      for (const total of [len, len + 1]) {
        if (total < 4 || total > 80) continue;
        if (this.buf.length < total) continue;
        const f = this.buf.subarray(0, total);
        let sum = 0;
        for (const b of f) sum = (sum + b) & 0xFF;
        if (sum === 0) {
          this._onFrame(f);
          this.buf = this.buf.subarray(total);
          progressed = true;
          break;
        }
      }
      if (!progressed) {
        // No valid frame at this 0x55; skip it and rescan.
        if (this.buf.length >= 80 + 3 || this.buf.indexOf(0x55, 1) >= 0) {
          this.buf = this.buf.subarray(1);
          progressed = true;
        } else {
          return; // wait for more bytes
        }
      }
    }
  }

  _onFrame(f) {
    const addr = f[1];
    this.state.lastFrameAt = new Date().toISOString();
    const n = (this.seenAddresses.get(addr) || 0) + 1;
    this.seenAddresses.set(addr, n);
    if ((n <= 3 && addr !== MEASUREMENT_ADDR) || this.cfg.logAllFrames) {
      log('info', 'AMP', `Frame addr=0x${addr.toString(16).padStart(2, '0')} len=${f.length} hex=${f.toString('hex')}`);
    } else {
      log('debug', 'AMP', `Frame addr=0x${addr.toString(16).padStart(2, '0')} hex=${f.toString('hex')}`);
    }

    // Optional 0x86 confirmation from the protocol doc. ACOM-Controller
    // never sends it and works fine, so it defaults off.
    if (this.cfg.sendAck) this.port.write(frame([0x55, 0x86, 0x04]));

    if (addr === MEASUREMENT_ADDR) this._parseMeasurement(f);
  }

  _parseMeasurement(f) {
    if (f.length < 70) {
      log('warn', 'AMP', `Measurement telegram shorter than expected (${f.length} bytes) - firmware variant? Frame: ${f.toString('hex')}`);
      return;
    }
    const u16 = (o) => f[o] + f[o + 1] * 256;
    const model = this.cfg.model || '700S';
    const tempOffset = this.cfg.tempOffset != null ? this.cfg.tempOffset
      : (TEMP_OFFSET[model] != null ? TEMP_OFFSET[model] : 282);

    const statusCode = (f[3] & 0xF0) >> 4;
    const errorCode = f[66];
    const hasError = errorCode !== 0xFF;

    const prevStatus = this.state.paStatusCode;
    const prevError = this.state.errorCode;
    Object.assign(this.state, {
      paStatusCode: statusCode,
      paStatus: PA_STATUS[statusCode] || `state ${statusCode}`,
      dcPower: u16(8) / 10,
      tempC: u16(16) - tempOffset,
      drivePower: u16(20) / 10,
      fwdPower: u16(22),
      reflPower: u16(24),
      swr: u16(26) / 100,
      errorCode: hasError ? errorCode : null,
      errorText: hasError ? (ERROR_TEXT[errorCode] || `Error 0x${errorCode.toString(16)}`) : null,
      band: BAND_NAMES[f[69] & 0x0F],
      fanSpeed: (f[69] & 0xF0) >> 4,
    });

    if (prevStatus !== null && prevStatus !== statusCode) {
      bus.emit('event', { ts: new Date().toISOString(), kind: 'info', tag: 'AMP', text: `Amp state: ${this.state.paStatus}` });
    }
    // The error byte can flip between related codes every telegram (e.g.
    // the CAT-error family while the CAT link is down) - throttle the
    // event feed to one entry per code per 5 minutes. The dashboard error
    // banner still tracks the live value continuously via _publish().
    if (this.state.errorCode !== null && this.state.errorCode !== prevError) {
      const last = this._errEventAt.get(errorCode) || 0;
      if (Date.now() - last > 5 * 60 * 1000) {
        this._errEventAt.set(errorCode, Date.now());
        bus.emit('event', { ts: new Date().toISOString(), kind: 'error', tag: 'AMP', text: `Amp error: ${this.state.errorText}` });
      } else {
        log('debug', 'AMP', `Amp error (repeat): ${this.state.errorText}`);
      }
    }
    // Only feed plausible readings into the tune-result tracker.
    if (this.state.swr >= 1 && this.state.swr <= SWR_SANE_MAX) this.onSwr(this.state.swr);
    this._publish();
  }

  snapshot() {
    return {
      enabled: this.cfg.enabled !== false,
      configured: !!this.cfg.port,
      allowPowerControl: this.cfg.allowPowerControl !== false,
      model: this.cfg.model || '700S',
      ...this.state,
      seenAddresses: [...this.seenAddresses.keys()].map((a) => '0x' + a.toString(16)),
    };
  }

  _publish() { bus.emit('amp', this.snapshot()); }
}

module.exports = { AcomTelemetry };
