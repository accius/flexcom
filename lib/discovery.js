'use strict';
const dgram = require('dgram');
const { log } = require('./log');

/**
 * FlexRadio LAN discovery. The radio broadcasts VITA-49 discovery packets
 * on UDP 4992 every second; the payload carries an ASCII key=value blob
 * including ip=, model=, nickname=. We listen passively and keep a list
 * of radios seen recently, so the settings UI can offer a pick-list
 * instead of making the user find the IP address by hand.
 */
class FlexDiscovery {
  constructor() {
    this.radios = new Map(); // ip -> {ip, model, nickname, lastSeen}
    this.sock = null;
  }

  start() {
    try {
      this.sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.sock.on('error', (e) => {
        // Port may be busy if SmartSDR runs on the same PC - not fatal,
        // discovery is a convenience only.
        log('info', 'DISC', `Discovery unavailable (${e.message}). Enter the radio IP manually in Settings.`);
        try { this.sock.close(); } catch {}
      });
      this.sock.on('message', (msg, rinfo) => this._onPacket(msg, rinfo));
      this.sock.bind(4992, () => {
        try { this.sock.setBroadcast(true); } catch {}
        log('info', 'DISC', 'Listening for FlexRadio discovery broadcasts on UDP 4992.');
      });
    } catch (e) {
      log('info', 'DISC', `Discovery not started: ${e.message}`);
    }
  }

  _onPacket(msg, rinfo) {
    const text = msg.toString('latin1');
    if (!/discovery_protocol_version|model=/.test(text)) return;
    const kv = {};
    for (const m of text.matchAll(/([a-z_]+)=([^\s\x00]+)/g)) kv[m[1]] = m[2];
    const ip = kv.ip || rinfo.address;
    this.radios.set(ip, {
      ip,
      model: kv.model || 'FLEX',
      nickname: kv.nickname || '',
      lastSeen: Date.now(),
    });
  }

  list() {
    const cutoff = Date.now() - 30000;
    return [...this.radios.values()].filter((r) => r.lastSeen > cutoff);
  }
}

module.exports = { FlexDiscovery };
