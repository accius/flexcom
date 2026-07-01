'use strict';
const { SerialPort } = require('serialport');
const { log, bus } = require('./log');

/**
 * Listener for the ACOM S-series REMOTE RS-232 port (the second serial
 * port on the amp - NOT the CAT/AUX port the CatEmulator uses).
 *
 * Protocol (per the official ACOM 600S Serial Port Communication Protocol
 * document, shared by the whole S-series):
 *   Byte 0: start tag 0x55
 *   Byte 1: address (message type)
 *   Byte 2: length
 *   ...payload...
 *   Byte N: checksum, chosen so SUM(Byte0..ByteN) & 0xFF == 0
 *   Messages the amp initiates must be ACKed with an address-0x86 message
 *   or the amp retransmits. Max message length 72 bytes.
 *
 * The measurement telegram payload (documented field layout, 16-bit LE):
 *   temp1[K] temp2[K] inputPwr[0.1W] fwdPwr[W] reflPwr[W] swr[x100]
 *   pam1Diss[0.1W] pam2Diss[0.1W] bdata[mV] disbalance[mV] vcc5[mV]
 *   vcc26[mV] hv1[0.1V] hv2[0.1V] id1[mA] id2[mA]
 *
 * The exact address byte of the measurement telegram and the offset of its
 * first field vary with model/firmware, so both are in config
 * (telemetry.measurementAddress / measurementFieldOffset). Until they are
 * confirmed from a live capture, the module hex-logs every distinct
 * address it sees - run one session, look at the log, set the config.
 */

const BANDS = { /* band code -> label; confirm codes from capture */
  0: '160m', 1: '80m', 2: '60m', 3: '40m', 4: '30m', 5: '20m',
  6: '17m', 7: '15m', 8: '12m', 9: '10m', 10: '6m',
};

class AcomTelemetry {
  constructor(cfg) {
    this.cfg = cfg.telemetry;
    this.enabled = !!(this.cfg && this.cfg.enabled);
    this.port = null;
    this.buf = Buffer.alloc(0);
    this.seenAddresses = new Map(); // addr -> count
    this.state = {
      connected: false,
      lastFrameAt: null,
      band: null,
      fwdPower: null, reflPower: null, swr: null,
      inputPower: null,
      temp1C: null, temp2C: null,
      hv1: null, hv2: null, id1: null, id2: null,
      raw: {},
    };
    this.onSwr = () => {};
  }

  open() {
    if (!this.enabled) {
      log('info', 'AMP', 'Telemetry disabled in config (telemetry.enabled=false).');
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
      // CRITICAL: the 700S uses the RS-232 handshake lines for remote
      // power on/off. Hold DTR and RTS LOW so we don't block the front
      // panel power button or power-cycle the amp.
      this.port.set({ dtr: false, rts: false }, (e) => {
        if (e) log('warn', 'AMP', `Could not clear DTR/RTS: ${e.message}`);
      });
      this.state.connected = true;
      log('info', 'AMP', `Telemetry port open on ${this.cfg.port} @ ${this.cfg.baudRate || 9600} (DTR/RTS held low).`);
      this._publish();
    });

    this.port.on('data', (b) => this._onData(b));
    this.port.on('close', () => {
      this.state.connected = false;
      this._publish();
      log('warn', 'AMP', 'Telemetry serial closed; reopening in 5s.');
      setTimeout(() => this.open(), 5000);
    });
    this.port.on('error', (e) => log('error', 'AMP', `Telemetry serial error: ${e.message}`));
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
        if (total < 4 || total > 72) continue;
        if (this.buf.length < total) continue;
        const frame = this.buf.subarray(0, total);
        let sum = 0;
        for (const b of frame) sum = (sum + b) & 0xFF;
        if (sum === 0) {
          this._onFrame(frame);
          this.buf = this.buf.subarray(total);
          progressed = true;
          break;
        }
      }
      if (!progressed) {
        // No valid frame at this 0x55; skip it and rescan.
        if (this.buf.length >= 72 + 3 || this.buf.indexOf(0x55, 1) >= 0) {
          this.buf = this.buf.subarray(1);
          progressed = true;
        } else {
          return; // wait for more bytes
        }
      }
    }
  }

  _onFrame(frame) {
    const addr = frame[1];
    this.state.lastFrameAt = new Date().toISOString();
    const n = (this.seenAddresses.get(addr) || 0) + 1;
    this.seenAddresses.set(addr, n);
    if (n <= 3 || this.cfg.logAllFrames) {
      log('info', 'AMP', `Frame addr=0x${addr.toString(16).padStart(2, '0')} len=${frame.length} hex=${frame.toString('hex')}`);
    } else {
      log('debug', 'AMP', `Frame addr=0x${addr.toString(16).padStart(2, '0')} hex=${frame.toString('hex')}`);
    }

    this._ack();

    if (this.cfg.measurementAddress != null && addr === Number(this.cfg.measurementAddress)) {
      this._parseMeasurement(frame);
    }
    if (addr === 0x27 && frame.length >= 7) {
      // Antenna/band message: byte3 antNum, byte4 antType, byte5 band, byte6 segmCnt
      const band = frame[5];
      this.state.band = BANDS[band] !== undefined ? BANDS[band] : `band#${band}`;
      this.state.antenna = frame[3];
      this._publish();
    }
  }

  _ack() {
    if (this.cfg.sendAck === false || !this.port) return;
    // Minimal 0x86 confirmation: 55 86 04 <checksum>
    const msg = Buffer.from([0x55, 0x86, 0x04, 0]);
    let sum = 0;
    for (let i = 0; i < 3; i++) sum = (sum + msg[i]) & 0xFF;
    msg[3] = (256 - sum) & 0xFF;
    this.port.write(msg);
  }

  _parseMeasurement(frame) {
    const off = this.cfg.measurementFieldOffset != null ? this.cfg.measurementFieldOffset : 8;
    const need = off + 32;
    if (frame.length < need + 1) {
      log('warn', 'AMP', `Measurement frame shorter than expected (${frame.length} < ${need + 1}); adjust measurementFieldOffset.`);
      return;
    }
    const u16 = (o) => frame.readUInt16LE(off + o);
    const kToC = (k) => Math.round((k - 273.15) * 10) / 10;
    const raw = {
      temp1K: u16(0), temp2K: u16(2),
      inputPower: u16(4) / 10, fwdPower: u16(6),
      reflPower: u16(8), swr: u16(10) / 100,
      pam1Diss: u16(12) / 10, pam2Diss: u16(14) / 10,
      bdata: u16(16), disbalance: u16(18),
      vcc5: u16(20) / 1000, vcc26: u16(22) / 1000,
      hv1: u16(24) / 10, hv2: u16(26) / 10,
      id1: u16(28) / 1000, id2: u16(30) / 1000,
    };
    Object.assign(this.state, {
      temp1C: kToC(raw.temp1K), temp2C: kToC(raw.temp2K),
      inputPower: raw.inputPower, fwdPower: raw.fwdPower,
      reflPower: raw.reflPower, swr: raw.swr,
      hv1: raw.hv1, hv2: raw.hv2, id1: raw.id1, id2: raw.id2,
      raw,
    });
    if (raw.swr > 0) this.onSwr(raw.swr);
    this._publish();
  }

  snapshot() {
    return { enabled: this.enabled, ...this.state, seenAddresses: [...this.seenAddresses.keys()].map((a) => '0x' + a.toString(16)) };
  }

  _publish() { bus.emit('amp', this.snapshot()); }
}

module.exports = { AcomTelemetry };
