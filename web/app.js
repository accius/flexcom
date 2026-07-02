'use strict';
/* ACOM ⇄ Flex Station dashboard. Zero build step, no dependencies.
   Talks to the bridge over the same WebSocket that streams state:
   incoming {type, data}, outgoing {cmd, args}. */

const $ = (id) => document.getElementById(id);

/* ---------- band plan (mirrors lib/bands.js) ---------- */
const BANDS = [
  { name: '160m', lowHz: 1800000, highHz: 2000000, defaultHz: 1840000 },
  { name: '80m', lowHz: 3500000, highHz: 4000000, defaultHz: 3750000 },
  { name: '60m', lowHz: 5250000, highHz: 5450000, defaultHz: 5357000 },
  { name: '40m', lowHz: 7000000, highHz: 7300000, defaultHz: 7150000 },
  { name: '30m', lowHz: 10100000, highHz: 10150000, defaultHz: 10125000 },
  { name: '20m', lowHz: 14000000, highHz: 14350000, defaultHz: 14225000 },
  { name: '17m', lowHz: 18068000, highHz: 18168000, defaultHz: 18120000 },
  { name: '15m', lowHz: 21000000, highHz: 21450000, defaultHz: 21300000 },
  { name: '12m', lowHz: 24890000, highHz: 24990000, defaultHz: 24940000 },
  { name: '10m', lowHz: 28000000, highHz: 29700000, defaultHz: 28400000 },
  { name: '6m', lowHz: 50000000, highHz: 54000000, defaultHz: 50125000 },
];
const MODES = ['LSB', 'USB', 'CW', 'AM', 'SAM', 'FM', 'NFM', 'DIGL', 'DIGU', 'RTTY'];
const bandOf = (hz) => { const b = BANDS.find((x) => hz >= x.lowHz && hz <= x.highHz); return b ? b.name : null; };

/* ---------- client state ---------- */
let ws = null;
const st = {
  flex: null, amp: null, tune: null,
  telemetry: [],           // {t, fwd, refl, swr, temp, drive, dc}
  chartWin: 300,           // seconds
  evFilter: 'all', evPaused: false,
  draggingRf: false, draggingTp: false,
};
const cmd = (c, args) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ cmd: c, args: args || {} })); };

/* ---------- formatting ---------- */
function fmtFreq(hz) {
  if (!hz) return '—';
  const s = String(Math.round(hz)).padStart(7, '0');
  const mhz = s.slice(0, -6), khz = s.slice(-6, -3), rest = s.slice(-3);
  return `${Number(mhz)}.${khz}.${rest}`;
}
function ago(ts) {
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function parseFreqInput(text) {
  const t = text.trim().replace(/[, _]/g, '');
  if (!t) return null;
  const dots = (t.match(/\./g) || []).length;
  let hz = null;
  if (dots >= 2) hz = parseInt(t.replace(/\./g, ''), 10);               // 14.225.000
  else {
    const v = parseFloat(t);
    if (!Number.isFinite(v)) return null;
    if (v < 1000) hz = Math.round(v * 1e6);                             // 14.225 MHz
    else if (v < 100000) hz = Math.round(v * 1e3);                      // 14225 kHz
    else hz = Math.round(v);                                            // Hz
  }
  return Number.isFinite(hz) && hz >= 30000 && hz <= 54000000 ? hz : null;
}

function setDot(id, on) { $(id).classList.toggle('on', !!on); }
function setMeter(id, pct, warnAt, badAt) {
  const el = $(id);
  el.firstElementChild.style.width = Math.max(0, Math.min(100, pct)) + '%';
  el.className = 'meter' + (pct >= badAt ? ' bad' : pct >= warnAt ? ' warn' : '');
}

/* ---------- radio card ---------- */
function renderBands() {
  const cur = st.flex && st.flex.txSlice ? bandOf(st.flex.txSlice.freq) : null;
  const mem = (st.tune && st.tune.bandMemory) || {};
  const row = $('bandRow');
  row.textContent = '';
  for (const b of BANDS) {
    const btn = document.createElement('button');
    btn.textContent = b.name;
    if (b.name === cur) btn.classList.add('cur');
    if (mem[b.name]) btn.classList.add('tuned');
    btn.title = mem[b.name]
      ? `QSY to last tuned ${fmtFreq(mem[b.name].freqHz)} (SWR ${mem[b.name].swr ? mem[b.name].swr.toFixed(2) : '?'})`
      : `QSY to ${fmtFreq(b.defaultHz)}`;
    btn.onclick = () => cmd('radio.qsy', { hz: mem[b.name] ? mem[b.name].freqHz : b.defaultHz });
    row.appendChild(btn);
  }
}

function renderModes() {
  const cur = st.flex && st.flex.txSlice ? st.flex.txSlice.mode : null;
  const row = $('modeRow');
  row.textContent = '';
  for (const m of MODES) {
    const btn = document.createElement('button');
    btn.textContent = m;
    if (m === cur) btn.classList.add('cur');
    btn.onclick = () => cmd('radio.mode', { mode: m });
    row.appendChild(btn);
  }
}

function onFlex(d) {
  st.flex = d;
  setDot('flexDot', d.connected);
  $('radioName').textContent = d.radioInfo && d.radioInfo.nickname ? d.radioInfo.nickname : (d.host || '');
  $('boundTo').textContent = d.boundTo || 'none';
  $('interlock').textContent = d.interlock || '—';
  const tx = d.interlock && /TRANSMIT|PTT/i.test(d.interlock);
  $('txBadge').classList.toggle('on', !!tx);
  const atu = d.atuStatus || '—';
  $('atuPill').textContent = 'ATU ' + atu;
  $('atuPill').style.color = /BYPASS|NONE/i.test(atu) ? 'var(--good)' : 'var(--critical)';
  if (d.txSlice) {
    $('freq').textContent = '';
    $('freq').append(fmtFreq(d.txSlice.freq));
    const small = document.createElement('small');
    small.textContent = 'MHz ' + (d.txSlice.mode || '');
    $('freq').appendChild(small);
  } else {
    $('freq').textContent = d.connected ? 'no slice' : '—';
  }
  $('slices').textContent = d.slices && d.slices.length
    ? d.slices.map((s) => `${(s.freq / 1e6).toFixed(3)}${s.tx ? ' TX' : ''}`).join('  ·  ') : 'none';

  // Client picker: auto + every GUI client.
  const sel = $('clientSel');
  const want = d.pinnedClientId || '';
  sel.textContent = '';
  const auto = document.createElement('option');
  auto.value = ''; auto.textContent = 'client: auto';
  sel.appendChild(auto);
  for (const c of d.clients || []) {
    const o = document.createElement('option');
    o.value = c.client_id;
    o.textContent = 'client: ' + c.program + (c.station ? ' / ' + c.station : '');
    sel.appendChild(o);
  }
  sel.value = [...sel.options].some((o) => o.value === want) ? want : '';

  if (!st.draggingRf && d.transmit && d.transmit.rfpower != null) {
    $('rfSlider').value = d.transmit.rfpower;
    $('rfVal').textContent = d.transmit.rfpower;
  }
  if (!st.draggingTp && d.transmit && d.transmit.tunepower != null) {
    $('tpSlider').value = d.transmit.tunepower;
    $('tpVal').textContent = d.transmit.tunepower;
  }
  renderBands();
  renderModes();
  updateTuneBtn();
}

/* ---------- amplifier card ---------- */
function onAmp(d) {
  st.amp = d;
  setDot('ampDot', d.connected && d.lastFrameAt && Date.now() - new Date(d.lastFrameAt) < 10000);
  $('ampConn').textContent = !d.enabled ? 'disabled' : !d.configured ? 'port not set'
    : d.connected ? 'connected' : 'DISCONNECTED';
  $('ampConn').className = d.connected ? 'ok' : (d.enabled && d.configured ? 'bad' : '');
  $('ampLast').textContent = d.lastFrameAt ? new Date(d.lastFrameAt).toLocaleTimeString() : '—';

  const pa = $('paStatus');
  pa.textContent = d.paStatus || 'no data';
  pa.className = d.paStatus === 'STANDBY' ? 'standby'
    : d.paStatus === 'OPERATE' ? 'operate'
    : d.paStatus === 'TRANSMIT' ? 'transmit'
    : d.paStatus === 'POWERING OFF' ? 'off' : '';

  const err = $('ampErr');
  if (d.errorText) { err.textContent = '⚠ ' + d.errorText; err.classList.add('show'); }
  else { err.classList.remove('show'); }

  const canCtl = d.connected;
  $('ampStandby').disabled = !canCtl;
  $('ampOperate').disabled = !canCtl;
  $('ampOff').disabled = !canCtl || !d.allowPowerControl;

  if (d.band && d.band !== '?') { $('ampBand').textContent = d.band; $('ampBand').style.display = 'inline-block'; }
  if (d.fanSpeed != null) { $('fanPill').textContent = 'fan ' + d.fanSpeed; $('fanPill').style.display = d.fanSpeed > 0 ? 'inline-block' : 'none'; }

  if (d.fwdPower != null) { $('fwd').textContent = Math.round(d.fwdPower); setMeter('fwdBar', d.fwdPower / 700 * 100, 95, 101); }
  if (d.reflPower != null) { $('refl').textContent = Math.round(d.reflPower); setMeter('reflBar', d.reflPower / 70 * 100, 50, 80); }
  if (d.swr != null) { $('swr').textContent = d.swr ? d.swr.toFixed(2) : '—'; setMeter('swrBar', (d.swr - 1) / 2 * 100, 50, 75); }
  if (d.tempC != null) { $('temp').textContent = Math.round(d.tempC); setMeter('tempBar', d.tempC / 90 * 100, 70, 85); }
  if (d.drivePower != null) $('drive').textContent = d.drivePower.toFixed(1);
  if (d.dcPower != null) $('dc').textContent = Math.round(d.dcPower);
}

let offConfirmTimer = null;
$('ampStandby').onclick = () => cmd('amp.standby');
$('ampOperate').onclick = () => cmd('amp.operate');
$('ampOff').onclick = () => {
  const b = $('ampOff');
  if (b.classList.contains('confirm')) {
    b.classList.remove('confirm'); b.textContent = 'Power off';
    clearTimeout(offConfirmTimer);
    cmd('amp.off');
  } else {
    b.classList.add('confirm'); b.textContent = 'Confirm off?';
    offConfirmTimer = setTimeout(() => { b.classList.remove('confirm'); b.textContent = 'Power off'; }, 4000);
  }
};

/* ---------- tuner card ---------- */
function updateTuneBtn() {
  const btn = $('tuneBtn');
  const tuning = st.tune && st.tune.tuning;
  btn.classList.toggle('active', !!tuning);
  btn.textContent = tuning ? 'TUNING — press to stop' : 'TUNE';
  btn.disabled = !tuning && !(st.flex && st.flex.connected);
}
$('tuneBtn').onclick = () => {
  if (st.tune && st.tune.tuning) cmd('tune.stop');
  else cmd('tune.start', {});
};

function onTune(d) {
  st.tune = d.state;
  updateTuneBtn();
  renderBands();

  const mem = d.state.bandMemory || {};
  const grid = $('memGrid');
  grid.textContent = '';
  for (const b of BANDS) {
    const m = mem[b.name];
    const div = document.createElement('div');
    div.className = 'mem' + (m ? (Date.now() - new Date(m.ts) > 7 * 86400e3 ? ' stale' : '') : ' empty');
    const name = document.createElement('b'); name.textContent = b.name; div.appendChild(name);
    if (m) {
      const swr = document.createElement('span'); swr.className = 'swr';
      swr.textContent = 'SWR ' + (m.swr ? m.swr.toFixed(2) : '?');
      const age = document.createElement('div'); age.className = 'age'; age.textContent = ago(m.ts);
      div.append(swr, age);
      div.title = `QSY to ${fmtFreq(m.freqHz)} MHz`;
      div.onclick = () => cmd('radio.qsy', { hz: m.freqHz });
    } else {
      const no = document.createElement('span'); no.textContent = 'not tuned';
      div.appendChild(no);
    }
    grid.appendChild(div);
  }

  const tb = $('tuneHistory').tBodies[0];
  tb.textContent = '';
  for (const h of (d.state.history || []).slice(0, 12)) {
    const tr = document.createElement('tr');
    const cells = [
      new Date(h.ts).toLocaleTimeString(),
      h.band || '?',
      h.freqHz ? (h.freqHz / 1e6).toFixed(3) : '?',
      h.ok ? 'complete' : h.reason,
      (h.durationMs / 1000).toFixed(1) + 's',
      h.finalSwr ? h.finalSwr.toFixed(2) : '—',
      h.source === 'dashboard' ? 'dash' : 'amp',
    ];
    cells.forEach((c, i) => {
      const td = document.createElement('td');
      td.textContent = c;
      if (i === 3) td.className = h.ok ? 'ok' : 'bad';
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  }
}

/* ---------- charts ---------- */
class Chart {
  constructor(canvasId, tipId, series, opts) {
    this.canvas = $(canvasId);
    this.tip = $(tipId);
    this.series = series;        // [{key, label, color}]
    this.opts = opts || {};      // {yMin, yMaxFloor, yFmt, capY}
    this.hoverPx = null;         // persists across periodic re-renders
    this.ctx = this.canvas.getContext('2d');
    this.canvas.addEventListener('pointermove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.hoverPx = e.clientX - r.left;
      this.render();
    });
    this.canvas.addEventListener('pointerleave', () => { this.hoverPx = null; this.tip.style.display = 'none'; this.render(); });
  }

  _cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  _window() {
    const now = Date.now();
    const from = now - st.chartWin * 1000;
    return { now, from, data: st.telemetry.filter((s) => s.t >= from) };
  }

  render() {
    const c = this.canvas, ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (!W) return;
    if (c.width !== W * dpr || c.height !== H * dpr) { c.width = W * dpr; c.height = H * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const { now, from, data } = this._window();
    const padL = 34, padR = 6, padT = 4, padB = 14;
    const pw = W - padL - padR, ph = H - padT - padB;

    // y-domain from visible data, with a floor so an idle chart still has scale
    let max = this.opts.yMaxFloor || 1;
    for (const s of data) for (const ser of this.series) {
      const v = s[ser.key];
      if (v != null && v > max) max = v;
    }
    if (this.opts.capY && max > this.opts.capY) max = this.opts.capY;
    const min = this.opts.yMin || 0;
    max = niceCeil(max);
    const x = (t) => padL + ((t - from) / (now - from)) * pw;
    const y = (v) => padT + ph - ((Math.min(v, max) - min) / (max - min)) * ph;

    // gridlines: solid hairlines, one shade off the surface + y ticks
    ctx.strokeStyle = this._cssVar('--edge');
    ctx.fillStyle = this._cssVar('--muted');
    ctx.font = '10px system-ui, sans-serif';
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    const ticks = 3;
    for (let i = 0; i <= ticks; i++) {
      const v = min + ((max - min) / ticks) * i;
      const yy = Math.round(y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
      ctx.fillText(this._fmtY(v), padL - 5, yy + 3);
    }
    // x labels: window edges
    ctx.textAlign = 'left';
    ctx.fillText(new Date(from).toLocaleTimeString(), padL, H - 3);
    ctx.textAlign = 'right';
    ctx.fillText('now', W - padR, H - 3);

    if (data.length > 1) {
      // downsample to <= one point per pixel
      const stride = Math.max(1, Math.ceil(data.length / pw));
      for (const ser of this.series) {
        const col = ser.color.startsWith('--') ? this._cssVar(ser.color) : ser.color;
        // area wash ~10%
        ctx.beginPath();
        let started = false, lastT = null, baseStart = null;
        const flushArea = (endT) => {
          if (!started) return;
          ctx.lineTo(x(endT), y(min));
          ctx.lineTo(x(baseStart), y(min));
          ctx.closePath();
          ctx.globalAlpha = 0.1; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;
          ctx.beginPath(); started = false;
        };
        for (let i = 0; i < data.length; i += stride) {
          const s = data[i], v = s[ser.key];
          if (v == null) continue;
          if (started && lastT != null && s.t - lastT > 5000) flushArea(lastT); // gap: break the fill
          if (!started) { ctx.moveTo(x(s.t), y(v)); started = true; baseStart = s.t; }
          else ctx.lineTo(x(s.t), y(v));
          lastT = s.t;
        }
        flushArea(lastT || now);
        // line 2px, gaps broken
        ctx.beginPath();
        started = false; lastT = null;
        for (let i = 0; i < data.length; i += stride) {
          const s = data[i], v = s[ser.key];
          if (v == null) continue;
          if (started && lastT != null && s.t - lastT > 5000) started = false;
          if (!started) { ctx.moveTo(x(s.t), y(v)); started = true; }
          else ctx.lineTo(x(s.t), y(v));
          lastT = s.t;
        }
        ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.stroke();
      }
    }

    // crosshair + tooltip
    const hoverPx = this.hoverPx;
    if (hoverPx != null && data.length) {
      const tt = from + ((hoverPx - padL) / pw) * (now - from);
      let best = null;
      for (const s of data) if (!best || Math.abs(s.t - tt) < Math.abs(best.t - tt)) best = s;
      if (best) {
        const xx = Math.round(x(best.t)) + 0.5;
        ctx.strokeStyle = this._cssVar('--muted');
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(xx, padT); ctx.lineTo(xx, padT + ph); ctx.stroke();
        // markers with surface ring
        for (const ser of this.series) {
          const v = best[ser.key];
          if (v == null) continue;
          const col = ser.color.startsWith('--') ? this._cssVar(ser.color) : ser.color;
          ctx.beginPath(); ctx.arc(x(best.t), y(v), 4, 0, Math.PI * 2);
          ctx.fillStyle = col; ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = this._cssVar('--card'); ctx.stroke();
        }
        this._tooltip(best, hoverPx);
        return;
      }
    }
    this.tip.style.display = 'none';
  }

  _fmtY(v) { return this.opts.yFmt ? this.opts.yFmt(v) : String(Math.round(v)); }

  _tooltip(sample, px) {
    const tip = this.tip;
    tip.textContent = '';
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = new Date(sample.t).toLocaleTimeString();
    tip.appendChild(t);
    for (const ser of this.series) {
      const v = sample[ser.key];
      if (v == null) continue;
      const row = document.createElement('div'); row.className = 'r';
      const key = document.createElement('i');
      key.style.background = ser.color.startsWith('--') ? this._cssVar(ser.color) : ser.color;
      const val = document.createElement('b');
      val.textContent = this.opts.tipFmt ? this.opts.tipFmt(v) : (Math.round(v * 100) / 100);
      const lab = document.createElement('span'); lab.textContent = ser.label;
      row.append(key, val, lab);
      tip.appendChild(row);
    }
    tip.style.display = 'block';
    const wrapW = this.canvas.clientWidth;
    const left = px + 12 + tip.offsetWidth > wrapW ? px - tip.offsetWidth - 12 : px + 12;
    tip.style.left = Math.max(0, left) + 'px';
    tip.style.top = '18px';
  }
}

function niceCeil(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

const charts = [
  new Chart('chPower', 'tipPower', [
    { key: 'fwd', label: 'forward W', color: '--s-blue' },
    { key: 'refl', label: 'reflected W', color: '--s-red' },
  ], { yMaxFloor: 50, tipFmt: (v) => Math.round(v) + ' W' }),
  new Chart('chSwr', 'tipSwr', [
    { key: 'swr', label: 'SWR', color: '--s-aqua' },
  ], { yMin: 1, yMaxFloor: 3, capY: 5, yFmt: (v) => v.toFixed(1), tipFmt: (v) => v.toFixed(2) }),
  new Chart('chTemp', 'tipTemp', [
    { key: 'temp', label: '°C', color: '--s-yellow' },
  ], { yMaxFloor: 80, tipFmt: (v) => Math.round(v) + ' °C' }),
];
setInterval(() => charts.forEach((c) => c.render()), 1000);
window.addEventListener('resize', () => charts.forEach((c) => c.render()));

$('chartFilters').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  st.chartWin = parseInt(b.dataset.win, 10);
  [...$('chartFilters').children].forEach((x) => x.classList.toggle('cur', x === b));
  charts.forEach((c) => c.render());
});

/* ---------- events log ---------- */
const evBuffer = [];
function evVisible(e) {
  if (st.evFilter === 'tune') return e.tag === 'TUNE';
  if (st.evFilter === 'warn') return e.kind === 'warn' || e.kind === 'error';
  return true;
}
function renderEvents() {
  const logEl = $('log');
  logEl.textContent = '';
  for (let i = evBuffer.length - 1; i >= 0; i--) {
    const e = evBuffer[i];
    if (!evVisible(e)) continue;
    const div = document.createElement('div');
    div.className = e.kind;
    div.textContent = `${new Date(e.ts).toLocaleTimeString()} [${e.tag}] ${e.text}`;
    logEl.appendChild(div);
    if (logEl.children.length >= 200) break;
  }
}
function onEvent(e, initial) {
  evBuffer.push(e);
  if (evBuffer.length > 400) evBuffer.shift();
  if (!st.evPaused) renderEvents();
  if (!initial && e.tag === 'TUNE' && (e.kind === 'success' || e.kind === 'warn') &&
      'Notification' in window && Notification.permission === 'granted') {
    new Notification('ACOM ⇄ Flex Station', { body: e.text });
  }
}
document.querySelector('.evFilters').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.f === 'pause') {
    st.evPaused = !st.evPaused;
    b.classList.toggle('cur', st.evPaused);
    b.textContent = st.evPaused ? '▶ resume' : '⏸ pause';
    if (!st.evPaused) renderEvents();
    return;
  }
  st.evFilter = b.dataset.f;
  [...document.querySelectorAll('.evFilters button')].forEach((x) => {
    if (x.dataset.f !== 'pause') x.classList.toggle('cur', x === b);
  });
  renderEvents();
});

/* ---------- controls wiring ---------- */
$('clientSel').onchange = () => cmd('radio.bind', { clientId: $('clientSel').value || null });

$('rfSlider').addEventListener('input', () => { st.draggingRf = true; $('rfVal').textContent = $('rfSlider').value; });
$('rfSlider').addEventListener('change', () => { st.draggingRf = false; cmd('radio.rfpower', { watts: parseInt($('rfSlider').value, 10) }); });
$('tpSlider').addEventListener('input', () => { st.draggingTp = true; $('tpVal').textContent = $('tpSlider').value; });
$('tpSlider').addEventListener('change', () => { st.draggingTp = false; cmd('radio.tunepower', { watts: parseInt($('tpSlider').value, 10) }); });

$('freqWrap').addEventListener('click', () => {
  const cur = st.flex && st.flex.txSlice ? st.flex.txSlice.freq : null;
  $('freq').style.display = 'none';
  const inp = $('freqEdit');
  inp.style.display = 'block';
  inp.value = cur ? (cur / 1e6).toFixed(6) : '';
  inp.focus(); inp.select();
});
$('freqEdit').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const hz = parseFreqInput($('freqEdit').value);
    if (hz) cmd('radio.qsy', { hz });
    closeFreqEdit();
  }
  if (e.key === 'Escape') closeFreqEdit();
});
$('freqEdit').addEventListener('blur', closeFreqEdit);
function closeFreqEdit() {
  $('freqEdit').style.display = 'none';
  $('freq').style.display = 'block';
}

/* ---------- websocket ---------- */
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onopen = () => setDot('wsDot', true);
  ws.onclose = () => { setDot('wsDot', false); setTimeout(connect, 2000); };
  ws.onmessage = (m) => {
    const { type, data } = JSON.parse(m.data);
    if (type === 'full') {
      st.telemetry = data.telemetry || [];
      evBuffer.length = 0;
      (data.events || []).forEach((e) => onEvent(e, true));
      if (data.flex) onFlex(data.flex);
      if (data.amp) onAmp(data.amp);
      if (data.tune) onTune({ state: data.tune });
      if (data.cat) onCat(data.cat);
      charts.forEach((c) => c.render());
    }
    if (type === 'flex') onFlex(data);
    if (type === 'cat') onCat(data);
    if (type === 'amp') onAmp(data);
    if (type === 'tune') onTune(data);
    if (type === 'event') onEvent(data);
    if (type === 'telemetry') {
      st.telemetry.push(data);
      if (st.telemetry.length > 3600) st.telemetry.shift();
    }
  };
}

/* ---------- CAT link indicator ---------- */
// Green = serial port open AND the amp is actually polling us (traffic in
// the last 15 s) - so an amp that is powered off shows as down.
let catState = null;
function onCat(d) { catState = d; refreshCatDot(); }
function refreshCatDot() {
  const d = catState;
  const fresh = d && d.open && d.lastRxAt && Date.now() - new Date(d.lastRxAt) < 15000;
  setDot('catDot', !!fresh);
  document.querySelector('#catDot').parentElement.title = !d || !d.configured
    ? 'CAT serial port not configured'
    : !d.open ? 'CAT serial port not open'
    : fresh ? 'Amp CAT link live' : 'Port open, no CAT traffic from amp';
}
setInterval(refreshCatDot, 5000);

/* ---------- settings ---------- */
$('gear').onclick = openSettings;
$('cancelBtn').onclick = closeSettings;
$('saveBtn').onclick = saveSettings;
$('restartBtn').onclick = restartBridge;

async function openSettings() {
  $('overlay').classList.add('open');
  $('saveMsg').textContent = '';
  $('restartBtn').style.display = 'none';
  let [cfg, ports, radios] = await Promise.all([
    fetch('/api/config').then((r) => r.json()),
    fetch('/api/ports').then((r) => r.json()).catch(() => []),
    fetch('/api/radios').then((r) => r.json()).catch(() => []),
  ]);
  if (!Array.isArray(ports)) ports = [];
  if (!Array.isArray(radios)) radios = [];
  const fill = (sel, current) => {
    const el = $(sel);
    el.textContent = '';
    const none = document.createElement('option');
    none.value = ''; none.textContent = '— not set —';
    el.appendChild(none);
    for (const p of ports) {
      const o = document.createElement('option');
      o.value = p.path;
      o.textContent = p.path + (p.manufacturer ? ' — ' + p.manufacturer : '');
      el.appendChild(o);
    }
    if (current && ![...el.options].some((o) => o.value === current)) {
      const o = document.createElement('option');
      o.value = current; o.textContent = current + ' (not present)';
      el.appendChild(o);
    }
    el.value = current || '';
  };
  fill('cfgCatPort', cfg.serial.port);
  fill('cfgTelPort', cfg.telemetry.port);
  $('cfgHost').value = cfg.flex.host || '';
  $('cfgPreferred').value = cfg.flex.preferredClient || '';
  $('cfgTelEnabled').checked = cfg.telemetry.enabled !== false;
  $('cfgPowerCtl').checked = cfg.telemetry.allowPowerControl !== false;
  $('cfgModel').value = cfg.telemetry.model || '700S';
  $('cfgTunePower').value = cfg.tune.tunePowerDefault;
  $('cfgNotify').value = (cfg.notify && cfg.notify.url) || '';
  $('cfgUser').value = cfg.dashboard.user || 'admin';
  $('cfgPass').value = cfg.dashboard.password || '';
  $('cfgAtu').checked = cfg.flex.enforceAtuBypass !== false;

  const list = $('radioList');
  list.textContent = '';
  if (radios.length) {
    list.append('Found on network: ');
    for (const r of radios) {
      const b = document.createElement('button');
      b.textContent = `${r.model}${r.nickname ? ' “' + r.nickname + '”' : ''} — ${r.ip}`;
      b.onclick = () => { $('cfgHost').value = r.ip; };
      list.appendChild(b);
    }
  } else {
    const s = document.createElement('span');
    s.style.cssText = 'color:var(--dim);font-size:12px';
    s.textContent = 'No radios auto-discovered (enter IP manually — SmartSDR shows it in the radio chooser).';
    list.appendChild(s);
  }
}

function closeSettings() { $('overlay').classList.remove('open'); }

async function saveSettings() {
  const patch = {
    serial: { port: $('cfgCatPort').value },
    telemetry: {
      port: $('cfgTelPort').value,
      enabled: $('cfgTelEnabled').checked,
      allowPowerControl: $('cfgPowerCtl').checked,
      model: $('cfgModel').value,
    },
    flex: {
      host: $('cfgHost').value.trim(),
      enforceAtuBypass: $('cfgAtu').checked,
      preferredClient: $('cfgPreferred').value.trim(),
    },
    tune: { tunePowerDefault: parseInt($('cfgTunePower').value, 10) || 25 },
    notify: { url: $('cfgNotify').value.trim() },
    dashboard: { user: $('cfgUser').value.trim() || 'admin', password: $('cfgPass').value },
  };
  const r = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).then((x) => x.json());
  if (r.ok) {
    $('saveMsg').textContent = 'Saved. Restart the bridge to apply.';
    $('restartBtn').style.display = 'block';
  } else {
    $('saveMsg').textContent = 'Save failed: ' + r.error;
  }
}

async function restartBridge() {
  $('saveMsg').textContent = 'Restarting… the page will reconnect automatically.';
  await fetch('/api/restart', { method: 'POST' }).catch(() => {});
  setTimeout(() => location.reload(), 4000);
}

/* ---------- boot ---------- */
if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
connect();
