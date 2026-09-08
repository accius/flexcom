'use strict';
/**
 * Station diagnostics - run this when the dashboard shows nothing and you
 * want to know why. Prints one report you can paste into a bug report:
 *
 *   node diag.js          (or: npm run diag / Diagnose.bat)
 *
 * It checks, in order: config, serial ports present vs configured, whether
 * the radio answers on TCP 4992, radio discovery broadcasts, the running
 * bridge's live state via its own API, and the tail of today's log.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const dgram = require('dgram');
const http = require('http');

const ROOT = __dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const out = [];
const P = (s = '') => { out.push(s); console.log(s); };
const OK = (s) => P(`  [ OK ] ${s}`);
const BAD = (s) => P(`  [FAIL] ${s}`);
const WARN = (s) => P(`  [WARN] ${s}`);
const INFO = (s) => P(`         ${s}`);

function readConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); }
  catch (e) { BAD(`config.json unreadable: ${e.message}`); return null; }
}

async function checkSerial(cfg) {
  P('\n== Serial ports ==');
  let ports = [];
  try {
    const { SerialPort } = require('serialport');
    ports = await SerialPort.list();
  } catch (e) {
    BAD(`Cannot list serial ports: ${e.message}${/Cannot find module/.test(e.message) ? ' - dependencies missing, run Install.bat / npm install' : ''}`);
    return;
  }
  if (!ports.length) WARN('No serial ports found at all - are the USB-serial adapters plugged in?');
  for (const p of ports) {
    INFO(`${p.path}  ${p.manufacturer || ''} ${p.serialNumber ? '(' + p.serialNumber + ')' : ''}${p.pnpId ? '  ' + p.pnpId : ''}`);
  }
  const check = (label, want) => {
    if (!want) { WARN(`${label} port not set - pick it in dashboard Settings.`); return; }
    const p = ports.find((x) => x.path.toLowerCase() === want.toLowerCase());
    if (!p) { BAD(`${label} port ${want} is configured but not present (COM numbers change when adapters move USB sockets).`); return; }
    if (/flex|smartsdr/i.test(`${p.manufacturer} ${p.pnpId}`)) {
      BAD(`${label} port ${want} is a SmartSDR CAT *virtual* port, not the USB adapter to the amp. Pick the FTDI/Prolific adapter instead.`);
      return;
    }
    OK(`${label} port ${want} present (${p.manufacturer || 'unknown make'}).`);
  };
  check('Amp CAT', cfg.serial && cfg.serial.port);
  if (cfg.telemetry && cfg.telemetry.enabled === false) INFO('Telemetry disabled in config.');
  else check('Amp telemetry', cfg.telemetry && cfg.telemetry.port);
  if (cfg.serial && cfg.telemetry && cfg.serial.port && cfg.serial.port === cfg.telemetry.port) {
    BAD('CAT and telemetry are set to the SAME port - they must be two different adapters.');
  }
}

function checkRadioTcp(host, port) {
  P('\n== Radio TCP API ==');
  return new Promise((resolve) => {
    if (!host) { BAD('flex.host is empty - set the radio IP in dashboard Settings.'); return resolve(); }
    const sock = net.createConnection({ host, port, timeout: 3000 });
    let got = '';
    const done = (fn) => { try { sock.destroy(); } catch {} fn(); resolve(); };
    sock.on('connect', () => INFO(`TCP connect to ${host}:${port} succeeded, waiting for banner...`));
    sock.on('data', (b) => {
      got += b.toString();
      if (got.includes('\n')) {
        done(() => OK(`Radio answered: ${got.split('\n')[0].trim()}  (the bridge can reach this radio)`));
      }
    });
    sock.on('timeout', () => done(() => BAD(`No response from ${host}:${port} within 3s - wrong IP, radio off, or different network/VLAN.`)));
    sock.on('error', (e) => done(() => BAD(`Cannot connect to ${host}:${port}: ${e.message}`)));
  });
}

function checkDiscovery() {
  P('\n== Radio discovery (UDP 4992, 4s listen) ==');
  return new Promise((resolve) => {
    const seen = new Map();
    let sock;
    try {
      sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch (e) { WARN(`Discovery socket failed: ${e.message}`); return resolve(); }
    sock.on('error', (e) => {
      WARN(`Cannot listen on UDP 4992 (${e.message}) - normal when SmartSDR runs on this PC; the radio IP must be entered manually.`);
      try { sock.close(); } catch {}
      resolve();
    });
    sock.on('message', (msg, rinfo) => {
      const t = msg.toString('latin1');
      if (!/discovery_protocol_version|model=/.test(t)) return;
      const kv = {};
      for (const m of t.matchAll(/([a-z_]+)=([^\s\x00]+)/g)) kv[m[1]] = m[2];
      seen.set(kv.ip || rinfo.address, kv);
    });
    sock.bind(4992, () => {
      setTimeout(() => {
        try { sock.close(); } catch {}
        if (!seen.size) WARN('No discovery broadcasts heard in 4s (SmartSDR may hold the port, or radio is on another subnet).');
        for (const [ip, kv] of seen) OK(`Radio on LAN: ${kv.model || 'FLEX'} "${kv.nickname || ''}" at ${ip}  version=${kv.version || '?'}  status=${kv.status || '?'}`);
        resolve();
      }, 4000);
    });
  });
}

function checkBridge(cfg) {
  P('\n== Running bridge (dashboard API) ==');
  const port = (cfg.dashboard && cfg.dashboard.port) || 8990;
  const auth = cfg.dashboard && cfg.dashboard.password
    ? { Authorization: 'Basic ' + Buffer.from(`${cfg.dashboard.user || 'admin'}:${cfg.dashboard.password}`).toString('base64') } : {};
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/state', headers: auth, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) { BAD(`Bridge answered HTTP ${res.statusCode} on port ${port}.`); return resolve(); }
        let s;
        try { s = JSON.parse(body); } catch { BAD('Bridge state is not JSON.'); return resolve(); }
        OK(`Bridge v${s.version} is running on http://localhost:${port}`);
        const f = s.flex || {};
        (f.connected ? OK : BAD)(`Radio link: ${f.connected ? 'connected' : 'NOT connected'} (${f.host})${f.radioInfo && f.radioInfo.nickname ? ' - ' + f.radioInfo.nickname : ''}`);
        INFO(`GUI clients seen: ${(f.clients || []).map((c) => `${c.program}${c.station ? '/' + c.station : ''}`).join(', ') || 'none'}`);
        (f.boundTo ? OK : WARN)(`Bound to: ${f.boundTo || 'nothing (no GUI client to follow - is SmartSDR connected to this radio?)'}`);
        (f.txSlice ? OK : WARN)(`TX slice: ${f.txSlice ? (f.txSlice.freq / 1e6).toFixed(6) + ' MHz ' + f.txSlice.mode : 'none (open a slice in SmartSDR)'}`);
        INFO(`ATU: ${f.atuStatus || '?'}   interlock: ${f.interlock || '?'}`);
        const c = s.cat || {};
        const catFresh = c.lastRxAt && Date.now() - new Date(c.lastRxAt) < 15000;
        if (!c.configured) WARN('Amp CAT: port not configured.');
        else if (!c.open) BAD('Amp CAT: port configured but NOT open (in use by another program, or wrong COM number).');
        else if (c.lastGarbageAt && Date.now() - new Date(c.lastGarbageAt) < 60000) BAD('Amp CAT: receiving garbage - baud/protocol mismatch with the amp CAT menu.');
        else (catFresh ? OK : WARN)(`Amp CAT: port open, ${catFresh ? 'amp is polling' : 'no polls from amp in the last 15s (amp off? cable TX/RX swapped? amp CAT menu not KENWOOD/RS232?)'}`);
        const a = s.amp || {};
        const ampFresh = a.lastFrameAt && Date.now() - new Date(a.lastFrameAt) < 10000;
        if (!a.enabled) INFO('Amp telemetry: disabled.');
        else if (!a.configured) WARN('Amp telemetry: port not configured.');
        else if (!a.connected) BAD('Amp telemetry: port NOT open.');
        else (ampFresh ? OK : WARN)(`Amp telemetry: ${ampFresh ? `live - ${a.paStatus}, ${a.band}, ${a.tempC != null ? Math.round(a.tempC) + ' C' : ''}` : 'port open but no frames in 10s (amp off, cable swapped with CAT, or DTR/RTS wired?)'}`);
        resolve();
      });
    });
    req.on('timeout', () => { req.destroy(); BAD(`Nothing listening on port ${port} - the bridge is not running (Start Bridge.bat / ./start.sh).`); resolve(); });
    req.on('error', (e) => { BAD(`Bridge not reachable on port ${port}: ${e.message} - is it running?`); resolve(); });
  });
}

function tailLog(cfg) {
  P('\n== Log tail ==');
  const dir = path.join(ROOT, (cfg.logging && cfg.logging.dir) || 'logs');
  try {
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('bridge-')).sort();
    if (!files.length) { WARN('No log files yet.'); return; }
    const lines = fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8').trim().split('\n');
    INFO(`${files[files.length - 1]} (last ${Math.min(40, lines.length)} of ${lines.length} lines):`);
    for (const l of lines.slice(-40)) P('    ' + l);
  } catch (e) { WARN(`Cannot read logs: ${e.message}`); }
}

(async () => {
  P(`acom-flex-bridge diagnostics  v${pkg.version}  ${new Date().toISOString()}`);
  P(`node ${process.version}  ${os.platform()} ${os.release()}  host=${os.hostname()}`);
  const cfg = readConfig();
  if (!cfg) return;
  P('\n== Config ==');
  INFO(`radio: ${cfg.flex.host || '(not set)'}:${cfg.flex.port}   preferredClient: ${cfg.flex.preferredClient || '(auto)'}`);
  INFO(`CAT port: ${cfg.serial.port || '(not set)'} @ ${cfg.serial.baudRate}   telemetry port: ${cfg.telemetry.port || '(not set)'} @ ${cfg.telemetry.baudRate} (${cfg.telemetry.enabled === false ? 'disabled' : 'enabled'})`);
  INFO(`dashboard: ${cfg.dashboard.host}:${cfg.dashboard.port}  login: ${cfg.dashboard.password ? 'on' : 'off'}`);
  await checkSerial(cfg);
  await checkRadioTcp(cfg.flex.host, cfg.flex.port || 4992);
  await checkDiscovery();
  await checkBridge(cfg);
  tailLog(cfg);
  const file = path.join(ROOT, 'diagnostics.txt');
  fs.writeFileSync(file, out.join('\n') + '\n');
  P(`\nReport saved to ${file} - paste it when asking for help.`);
})();
