'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let cfg = { level: 'info', dir: 'logs', logToConsole: true, baseDir: __dirname };

/** Global event bus: modules publish, dashboard subscribes. */
const bus = new EventEmitter();
bus.setMaxListeners(50);

function init(loggingCfg, baseDir) {
  cfg = { ...cfg, ...loggingCfg, baseDir };
  fs.mkdirSync(path.join(baseDir, cfg.dir), { recursive: true });
}

function logFile() {
  const d = new Date().toISOString().slice(0, 10);
  return path.join(cfg.baseDir, cfg.dir, `bridge-${d}.log`);
}

function log(level, tag, msg) {
  if (LEVELS[level] < LEVELS[cfg.level]) return;
  const ts = new Date().toISOString();
  const line = `${ts} [${level.toUpperCase().padEnd(5)}] [${tag.padEnd(6)}] ${msg}`;
  if (cfg.logToConsole !== false) console.log(line);
  fs.appendFile(logFile(), line + '\n', () => {});
  // Mirror warn+ into the dashboard event feed.
  if (LEVELS[level] >= LEVELS.warn) bus.emit('event', { ts, kind: level, tag, text: msg });
}

const printable = (s) =>
  String(s).replace(/\r/g, '<CR>').replace(/\n/g, '<LF>')
    .replace(/[^\x20-\x7E<>]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

module.exports = { init, log, printable, bus };
