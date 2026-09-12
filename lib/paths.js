'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Where the bridge keeps its mutable files: config.json, logs/, data/.
 *
 * Plain install (npm start, the .bat / .sh launchers): the repo folder, as
 * always. Desktop app: the packaged code lives in a read-only archive, so
 * the app sets ACOM_BRIDGE_HOME to a per-user folder and the default
 * config.json is copied there on first run.
 */
const ROOT = path.join(__dirname, '..');
const HOME = process.env.ACOM_BRIDGE_HOME ? path.resolve(process.env.ACOM_BRIDGE_HOME) : ROOT;
const CONFIG = path.join(HOME, 'config.json');

function ensureHome() {
  if (HOME === ROOT) return;
  fs.mkdirSync(HOME, { recursive: true });
  if (!fs.existsSync(CONFIG)) fs.copyFileSync(path.join(ROOT, 'config.json'), CONFIG);
}

module.exports = { ROOT, HOME, CONFIG, ensureHome };
