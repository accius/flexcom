'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { SerialPort } = require('serialport');
const { log, bus } = require('./log');

/**
 * Web dashboard + settings UI + live WebSocket stream + control channel.
 * Endpoints:
 *   GET  /                    dashboard SPA (plus /app.js, /style.css)
 *   GET  /api/state           full state snapshot
 *   GET  /api/config          current config (JSON)
 *   POST /api/config          save config.json (restart required to apply)
 *   GET  /api/ports           available serial ports
 *   GET  /api/radios          Flex radios discovered on the LAN
 *   GET  /api/telemetry       rolling amp-telemetry samples (for charts)
 *   GET  /api/tunehistory.csv tune history export
 *   POST /api/restart         exit(0); the launcher loop restarts the bridge
 *
 * WebSocket: server pushes {type: full|flex|amp|tune|event|telemetry},
 * client sends {cmd: "...", ...args} - dispatched to deps.commands.
 *
 * Remote access: see README "Remote access". Optional password protection
 * via dashboard.password (HTTP Basic Auth on all routes and the WebSocket).
 */

const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html' },
  '/index.html': { file: 'index.html', type: 'text/html' },
  '/app.js': { file: 'app.js', type: 'text/javascript' },
  '/style.css': { file: 'style.css', type: 'text/css' },
  '/manifest.json': { file: 'manifest.json', type: 'application/json' },
  '/icon.svg': { file: 'icon.svg', type: 'image/svg+xml' },
};

function startDashboard(cfg, getFullState, deps) {
  const webRoot = path.join(__dirname, '..', 'web');
  const configPath = path.join(__dirname, '..', 'config.json');
  const events = [];
  const commands = (deps && deps.commands) || {};

  // Rolling telemetry buffer for the dashboard charts: sampled from the
  // amp event stream at most every SAMPLE_MS, ~30 minutes retained.
  const SAMPLE_MS = 500;
  const MAX_SAMPLES = 3600;
  const telemetryRing = [];
  let lastSampleAt = 0;
  bus.on('amp', (d) => {
    const now = Date.now();
    if (now - lastSampleAt < SAMPLE_MS || d.fwdPower == null) return;
    lastSampleAt = now;
    const sample = { t: now, fwd: d.fwdPower, refl: d.reflPower, swr: d.swr, temp: d.tempC, drive: d.drivePower, dc: d.dcPower };
    telemetryRing.push(sample);
    if (telemetryRing.length > MAX_SAMPLES) telemetryRing.shift();
    broadcast('telemetry', sample);
  });

  const password = (cfg.dashboard && cfg.dashboard.password) || '';
  const username = (cfg.dashboard && cfg.dashboard.user) || 'admin';
  const sessionToken = password ? crypto.createHash('sha256').update(`afb:${username}:${password}`).digest('hex') : '';

  // Brute-force throttle: 5 failed attempts per IP -> 5 minute lockout.
  const fails = new Map(); // ip -> {count, until}
  function locked(ip) {
    const f = fails.get(ip);
    return f && f.until > Date.now();
  }
  function recordFail(ip) {
    const f = fails.get(ip) || { count: 0, until: 0 };
    f.count++;
    if (f.count >= 5) { f.until = Date.now() + 5 * 60 * 1000; f.count = 0; log('warn', 'DASH', `Too many failed logins from ${ip} - locked out 5 minutes.`); }
    fails.set(ip, f);
  }

  function authorized(req) {
    if (!password) return true;
    const ip = req.socket.remoteAddress || '?';
    if (locked(ip)) return false;
    // 1) Session cookie (set after a successful login; lets the browser's
    //    WebSocket upgrade through, since WS can't send Basic headers).
    const cookies = req.headers.cookie || '';
    if (cookies.split(/;\s*/).some((c) => c === 'afb=' + sessionToken)) return true;
    // 2) HTTP Basic Auth: username AND password must match.
    const h = req.headers.authorization || '';
    if (!h.startsWith('Basic ')) return false;
    const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    const okUser = decoded.slice(0, i) === username;
    const okPass = i >= 0 && timingSafeEq(decoded.slice(i + 1), password);
    if (!(okUser && okPass)) { recordFail(ip); return false; }
    fails.delete(ip);
    return true;
  }

  function timingSafeEq(a, b) {
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
  }
  function deny(res) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="acom-flex-bridge"' });
    res.end('Authentication required');
  }

  const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!authorized(req)) return deny(res);
      const url = req.url.split('?')[0];

      if (url === '/api/state') return json(res, 200, getFullState());

      if (url === '/api/config' && req.method === 'GET') {
        return json(res, 200, JSON.parse(fs.readFileSync(configPath, 'utf8')));
      }

      if (url === '/api/config' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
        req.on('end', () => {
          try {
            const incoming = JSON.parse(body);
            // Merge onto current file so unknown/comment keys survive.
            const current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const merged = deepMerge(current, incoming);
            fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
            log('info', 'DASH', 'Configuration saved from web UI (restart to apply).');
            json(res, 200, { ok: true, restartRequired: true });
          } catch (e) {
            json(res, 400, { ok: false, error: e.message });
          }
        });
        return;
      }

      if (url === '/api/ports') {
        let ports = [];
        try { ports = await SerialPort.list(); }
        catch (e) { log('warn', 'DASH', `Serial port listing failed: ${e.message}`); }
        return json(res, 200, ports.map((p) => ({
          path: p.path, manufacturer: p.manufacturer || '', serial: p.serialNumber || '',
        })));
      }

      if (url === '/api/radios') {
        return json(res, 200, deps && deps.discovery ? deps.discovery.list() : []);
      }

      if (url === '/api/telemetry') return json(res, 200, telemetryRing);

      if (url === '/api/tunehistory.csv') {
        if (!deps || !deps.tuner) return json(res, 404, { ok: false });
        res.writeHead(200, {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="tune-history.csv"',
        });
        return res.end(deps.tuner.historyCsv());
      }

      if (url === '/api/restart' && req.method === 'POST') {
        json(res, 200, { ok: true });
        log('info', 'DASH', 'Restart requested from web UI.');
        setTimeout(() => process.exit(0), 400); // launcher loop brings us back
        return;
      }

      const asset = STATIC_FILES[url];
      if (!asset) { res.writeHead(404); return res.end('not found'); }
      fs.readFile(path.join(webRoot, asset.file), (err, data) => {
        if (err) { res.writeHead(500); res.end('dashboard missing'); return; }
        const headers = { 'Content-Type': asset.type };
        if (password && asset.file === 'index.html') {
          headers['Set-Cookie'] = `afb=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`;
        }
        res.writeHead(200, headers);
        res.end(data);
      });
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!authorized(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  function broadcast(type, data) {
    const msg = JSON.stringify({ type, data });
    for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
  }

  wss.on('connection', (ws, req) => {
    ws.send(JSON.stringify({ type: 'full', data: { ...getFullState(), events, telemetry: telemetryRing } }));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg.cmd !== 'string') return;
      const fn = commands[msg.cmd];
      if (!fn) { log('warn', 'DASH', `Unknown dashboard command: ${msg.cmd}`); return; }
      log('info', 'DASH', `Command from ${req.socket.remoteAddress}: ${msg.cmd} ${JSON.stringify(msg.args || {})}`);
      try { fn(msg.args || {}); } catch (e) { log('error', 'DASH', `Command ${msg.cmd} failed: ${e.message}`); }
    });
  });

  bus.on('flex', (d) => broadcast('flex', d));
  bus.on('cat', (d) => broadcast('cat', d));
  bus.on('amp', (d) => broadcast('amp', d));
  bus.on('tune', (d) => broadcast('tune', d));
  bus.on('event', (e) => {
    events.push(e);
    if (events.length > 200) events.shift();
    broadcast('event', e);
  });

  const port = cfg.dashboard.port || 8990;
  const host = cfg.dashboard.host || '0.0.0.0';
  server.listen(port, host, () => {
    log('info', 'DASH', `Dashboard on port ${port} - open http://localhost:${port}${password ? ' (password protected)' : ' (no password set)'}.`);
  });

  return { broadcast };
}

function deepMerge(target, src) {
  for (const k of Object.keys(src)) {
    if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) &&
        target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepMerge(target[k], src[k]);
    } else {
      target[k] = src[k];
    }
  }
  return target;
}

module.exports = { startDashboard };
