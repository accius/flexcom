'use strict';
/**
 * Desktop shell for acom-flex-bridge.
 *
 * Runs bridge.js as a background child (so the dashboard's Restart button,
 * which exits the bridge process, just brings it back), shows the dashboard
 * in its own window, and lives in the system tray / menu bar. No console
 * window, no browser tab. Config, logs and tune memory live in the per-user
 * app data folder (ACOM_BRIDGE_HOME) - see lib/paths.js.
 */
const { app, BrowserWindow, Menu, Tray, nativeImage, shell, utilityProcess, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const APP_NAME = 'ACOM Flex Bridge';
const ROOT = path.join(__dirname, '..');            // package root (inside app.asar when packaged)
const HOME = path.join(app.getPath('userData'), 'bridge');
const RESTART_DELAY_MS = 1500;

let win = null;
let tray = null;
let child = null;
let quitting = false;
let restartTimer = null;
const logTail = [];                                  // last bridge console lines, for the error dialog

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => showWindow());

function readConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')); } catch { return {}; }
}
function dashboardPort() {
  const c = readConfig();
  return (c.dashboard && c.dashboard.port) || 8990;
}
function dashboardUrl() { return `http://127.0.0.1:${dashboardPort()}/`; }

// ---- bridge child process ------------------------------------------------

function startBridge() {
  clearTimeout(restartTimer);
  if (child || quitting) return;
  child = utilityProcess.fork(path.join(ROOT, 'bridge.js'), [], {
    env: { ...process.env, ACOM_BRIDGE_HOME: HOME },
    stdio: 'pipe',
    serviceName: 'acom-flex-bridge',
  });
  const tap = (stream) => stream && stream.on('data', (b) => {
    for (const line of b.toString().split('\n')) {
      if (!line.trim()) continue;
      logTail.push(line);
      if (logTail.length > 200) logTail.shift();
    }
  });
  tap(child.stdout); tap(child.stderr);            // must drain, or the pipe fills and blocks the bridge
  child.on('exit', (code) => {
    child = null;
    if (quitting) return;
    // Settings -> Restart exits with 0. A crash is anything else: keep the
    // app alive and bring the bridge back, but tell the user once.
    if (code !== 0) notifyCrash(code);
    restartTimer = setTimeout(startBridge, RESTART_DELAY_MS);
  });
  updateTray();
}

function stopBridge() {
  clearTimeout(restartTimer);
  if (child) { try { child.kill(); } catch {} child = null; }
}

function restartBridge() {
  stopBridge();
  startBridge();
  if (win) win.loadURL(waitingPage());
  waitForDashboard().then(() => win && win.loadURL(dashboardUrl()));
}

let crashShown = false;
function notifyCrash(code) {
  if (crashShown) return;
  crashShown = true;
  const tail = logTail.slice(-15).join('\n');
  dialog.showMessageBox({
    type: 'warning', title: APP_NAME,
    message: `The bridge stopped unexpectedly (exit code ${code}) and is being restarted.`,
    detail: tail || 'No output captured.',
    buttons: ['OK', 'Open logs folder'],
  }).then((r) => { if (r.response === 1) shell.openPath(path.join(HOME, 'logs')); });
}

// ---- dashboard readiness -------------------------------------------------

function probe() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: dashboardPort(), path: '/', timeout: 800 }, (res) => {
      res.resume(); resolve(res.statusCode === 200 || res.statusCode === 401);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
async function waitForDashboard(maxMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (await probe()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function waitingPage() {
  const html = `<!doctype html><meta charset="utf-8"><title>${APP_NAME}</title>
  <body style="margin:0;height:100vh;display:grid;place-items:center;background:#0e1116;color:#c8d0dc;font:15px system-ui">
  <div style="text-align:center"><div style="font-size:22px;font-weight:600;margin-bottom:8px">${APP_NAME}</div>
  <div>Starting the bridge&hellip;</div></div></body>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

// ---- window & tray -------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1380, height: 900, minWidth: 900, minHeight: 600,
    title: APP_NAME,
    backgroundColor: '#0e1116',
    icon: path.join(ROOT, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(waitingPage());
  waitForDashboard().then((ok) => {
    if (!win) return;
    if (ok) win.loadURL(dashboardUrl());
    else dialog.showMessageBox(win, {
      type: 'error', title: APP_NAME,
      message: 'The dashboard did not come up.',
      detail: logTail.slice(-15).join('\n') || 'Check the logs folder (tray menu).',
    });
  });
  // Links the dashboard opens (docs, webhook targets) go to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // Close = hide to tray; the bridge keeps running. Quit is in the tray menu.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (process.platform !== 'darwin' && tray && !createWindow.hinted) {
      createWindow.hinted = true;
      tray.displayBalloon && tray.displayBalloon({ title: APP_NAME, content: 'Still running in the tray. Right-click the icon to quit.' });
    }
  });
  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win) createWindow();
  else { win.show(); win.focus(); }
}

function updateTray() {
  if (!tray) return;
  const login = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open dashboard', click: showWindow },
    { label: 'Open in browser', click: () => shell.openExternal(dashboardUrl()) },
    { type: 'separator' },
    { label: child ? 'Restart bridge' : 'Start bridge', click: restartBridge },
    { label: 'Open logs folder', click: () => shell.openPath(path.join(HOME, 'logs')) },
    { label: 'Open settings folder', click: () => shell.openPath(HOME) },
    { type: 'separator' },
    { label: 'Start at login', type: 'checkbox', checked: login,
      click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true }); } },
    { type: 'separator' },
    { label: `Quit ${APP_NAME}`, click: () => { quitting = true; app.quit(); } },
  ]));
  tray.setToolTip(`${APP_NAME} - ${child ? 'bridge running' : 'bridge stopped'}`);
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
  tray = new Tray(process.platform === 'darwin' ? img.resize({ width: 18, height: 18 }) : img);
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  updateTray();
}

// Basic-auth for the dashboard when a password is set in config.
app.on('login', (event, webContents, request, authInfo, callback) => {
  const c = readConfig().dashboard || {};
  if (c.password) { event.preventDefault(); callback(c.user || 'admin', c.password); }
});

app.whenReady().then(() => {
  app.setName(APP_NAME);
  fs.mkdirSync(HOME, { recursive: true });
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: APP_NAME, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { type: 'separator' },
        { label: 'Quit', accelerator: 'Cmd+Q', click: () => { quitting = true; app.quit(); } }] },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }
  createTray();
  startBridge();
  // Start hidden when launched at login, otherwise show the dashboard.
  const hidden = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAsHidden;
  if (!hidden) createWindow();
});

app.on('activate', showWindow);                      // macOS dock click
app.on('window-all-closed', () => { /* keep running in the tray */ });
app.on('before-quit', () => { quitting = true; stopBridge(); });
