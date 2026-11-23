// NC Viewer: wires the editor, parser, verifier, stock simulation and 3D view.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { parseGcode, MM_PER_INCH, RAPID, FEED, ARC, DRILL, FM_PER_REV, FM_INVERSE, fmt, describeG } from './gcode.js';
import { toolFromHints, TOOL_TYPES, TYPE_FIELDS, FIELD_LABELS, defaultTool } from './tools.js';
import { computeTimes, computeStats, verify, lineIndex, formatTime, boxValid } from './analyze.js';
import { StockSim } from './sim.js';
import { Viewer, MATERIALS, PATH_COLORS, toolColor } from './viewer.js';
import { CodeEditor } from './editor.js';
import { SAMPLE, SAMPLE_STOCK } from './sample.js';
import { buildToolMesh } from './toolmesh.js';

const $ = (id) => document.getElementById(id);
const STORE = 'ncviewer:v1';
const SEV_RANK = { error: 3, warning: 2, info: 1 };

const state = {
  stock: { units: 'mm', x: 100, y: 80, z: 12, originXY: 'll', originZ: 'top', ox: 0, oy: 0, oz: -12, material: 'aluminum', show: true, sim: true, res: 300 },
  machine: { units: 'mm', rapid: 5000, maxFeed: 10000, maxRpm: 24000, defUnits: 'mm' },
  display: { colorBy: 'type', rapids: true, path: true, tool: true, holder: true, grid: true, follow: true },
  toolEdits: {},
  fileName: 'program.nc',
  speed: 25,
  // runtime
  prog: null, tools: new Map(), toolKeys: new Map(), toolIssues: [], times: null, stats: null, lineIdx: null, issues: [],
  t: 0, playing: false, sim: null, simDone: 0, simT: 0, shownTool: null, sevFilter: new Set(['error', 'warning', 'info']),
};

// ------------------------------------------------------------- helpers
const progScale = () => (state.prog?.units === 'in' ? MM_PER_INCH : 1);
const progUnit = () => (state.prog?.units === 'in' ? 'in' : 'mm');
const num = (mm, s = progScale()) => fmt(mm / s, s === 1 ? 3 : 4);
const show = (mm) => `${num(mm)} ${progUnit()}`;
const machScale = () => (state.machine.units === 'in' ? MM_PER_INCH : 1);

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('on'), ms);
}

function stockBox() {
  const s = state.stock;
  const u = s.units === 'in' ? MM_PER_INCH : 1;
  const X = Math.max(+s.x || 0, 0.001) * u, Y = Math.max(+s.y || 0, 0.001) * u, Z = Math.max(+s.z || 0, 0.001) * u;
  let x0 = 0, y0 = 0, z0 = -Z;
  switch (s.originXY) {
    case 'lr': x0 = -X; break;
    case 'ul': y0 = -Y; break;
    case 'ur': x0 = -X; y0 = -Y; break;
    case 'c': x0 = -X / 2; y0 = -Y / 2; break;
    case 'custom': x0 = (+s.ox || 0) * u; y0 = (+s.oy || 0) * u; break;
  }
  if (s.originZ === 'bottom') z0 = 0;
  else if (s.originZ === 'custom') z0 = (+s.oz || 0) * u;
  return { x0, x1: x0 + X, y0, y1: y0 + Y, z0, z1: z0 + Z };
}

// --------------------------------------------------------------- persist
function load() {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return null;
    const d = JSON.parse(raw);
    Object.assign(state.stock, d.stock || {});
    Object.assign(state.machine, d.machine || {});
    Object.assign(state.display, d.display || {});
    state.toolEdits = d.toolEdits || {};
    state.speed = d.speed || state.speed;
    state.fileName = d.fileName || state.fileName;
    return typeof d.text === 'string' ? d.text : null;
  } catch {
    return null;
  }
}

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const text = editor.value;
      localStorage.setItem(STORE, JSON.stringify({
        text: text.length < 2e6 ? text : '', stock: state.stock, machine: state.machine, display: state.display,
        toolEdits: state.toolEdits, speed: state.speed, fileName: state.fileName,
      }));
    } catch { /* storage full or blocked: fine */ }
  }, 400);
}

// ------------------------------------------------------------------ setup
const viewer = new Viewer($('viewport'));
const editor = new CodeEditor($('editor'), {
  onChange: (text) => { reparse(text); save(); },
  onCaretLine: (line) => selectLine(line, false),
});

// ------------------------------------------------------------- pipeline
function reparse(text, { fitView = false } = {}) {
  const prog = parseGcode(text, { defaultUnits: state.machine.defUnits });
  state.prog = prog;
  buildTools();
  state.times = computeTimes(prog.segs, state.machine.rapid * machScale());
  state.stats = computeStats(prog.segs, state.times);
  state.lineIdx = lineIndex(prog.segs, prog.lineCount);
  viewer.setPath(prog.segs, { colorBy: state.display.colorBy, showRapids: state.display.rapids });
  viewer.highlight(-1, -1);
  state.shownTool = null;
  updateScene();
  rebuildStock();
  reverify();
  renderTools();
  renderStats();
  renderLegend();
  state.playing = false;
  updatePlayButton();
  state.t = state.times.cum[prog.segs.n] || 0;
  applyPlayhead(false);
  const n = prog.segs.n;
  $('progMeta').textContent = n ? `${prog.lineCount.toLocaleString()} lines · ${prog.units} · ${formatTime(state.stats.total)}` : '';
  if (fitView) viewer.fit('iso');
}

function buildTools() {
  const prog = state.prog;
  const ids = new Set(prog.toolOrder);
  for (let i = 0; i < prog.segs.n; i++) ids.add(prog.segs.tool[i]);
  const tools = new Map();
  const keys = new Map();
  const issues = [];
  for (const t of [...ids].sort((a, b) => a - b)) {
    const hints = prog.toolHints.get(t);
    const detected = toolFromHints(hints, prog.units);
    const key = `${t}|${detected.source}`;
    keys.set(t, key);
    const edit = state.toolEdits[key];
    tools.set(t, edit ? { ...detected, ...edit, edited: true } : detected);
    const used = prog.segs.tool.includes(t);
    if (!edit && detected.guessed && used) {
      const line = hints?.[0]?.line ?? firstLineOfTool(t);
      issues.push({ line, sev: 'info', msg: `T${t} has no ${hints ? 'diameter' : 'description'} in the program; assuming a ${num(detected.dia)} ${progUnit()} ${TOOL_TYPES[detected.type].label.toLowerCase()} — set it in Tools` });
    }
  }
  state.tools = tools;
  state.toolKeys = keys;
  state.toolIssues = issues;
  $('nTools').textContent = tools.size ? tools.size : '';
}

function firstLineOfTool(t) {
  const s = state.prog.segs;
  for (let i = 0; i < s.n; i++) if (s.tool[i] === t) return s.line[i];
  return -1;
}

function reverify() {
  const prog = state.prog;
  const machine = { maxRpm: +state.machine.maxRpm || 0, maxFeed: (+state.machine.maxFeed || 0) * machScale() };
  const geo = verify(prog.segs, stockBox(), state.tools, machine, show);
  const issues = [...prog.issues, ...state.toolIssues, ...geo];
  issues.sort((a, b) => a.line - b.line || SEV_RANK[b.sev] - SEV_RANK[a.sev]);
  state.issues = issues;
  const marks = new Map();
  for (const is of issues) {
    if (is.line < 0) continue;
    const cur = marks.get(is.line);
    if (!cur || SEV_RANK[is.sev] > SEV_RANK[cur]) marks.set(is.line, is.sev);
  }
  editor.setMarks(marks);
  renderIssues();
}

function renderIssues() {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const is of state.issues) counts[is.sev]++;
  $('nErr').textContent = counts.error;
  $('nWarn').textContent = counts.warning;
  $('nInfo').textContent = counts.info;
  const list = $('issueList');
  const shown = state.issues.filter((i) => state.sevFilter.has(i.sev));
  const MAX = 500;
  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const is of shown.slice(0, MAX)) {
    const li = document.createElement('li');
    li.className = is.sev;
    li.innerHTML = `<span class="ln">${is.line >= 0 ? 'Line ' + (is.line + 1) : 'Program'}</span><span class="msg"></span>`;
    li.querySelector('.msg').textContent = is.msg;
    if (is.line >= 0) {
      li.tabIndex = 0;
      li.addEventListener('click', () => { editor.goToLine(is.line); selectLine(is.line, true); });
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') li.click(); });
    }
    frag.appendChild(li);
  }
  if (shown.length > MAX) {
    const li = document.createElement('li');
    li.className = 'info';
    li.textContent = `…${shown.length - MAX} more not shown`;
    frag.appendChild(li);
  }
  if (!state.issues.length && state.prog?.segs.n) {
    const li = document.createElement('li');
    li.className = 'ok';
    li.textContent = 'No problems found.';
    frag.appendChild(li);
  }
  list.appendChild(frag);

  const v = $('verdict');
  v.className = 'verdict';
  if (!state.prog?.segs.n && !counts.error) {
    v.textContent = editor.value.trim() ? 'No moves found' : 'Paste a program';
  } else if (counts.error) {
    v.classList.add('bad');
    v.textContent = `✕ ${counts.error} error${counts.error > 1 ? 's' : ''}${counts.warning ? ` · ${counts.warning} warning${counts.warning > 1 ? 's' : ''}` : ''}`;
  } else if (counts.warning) {
    v.classList.add('warn');
    v.textContent = `! ${counts.warning} warning${counts.warning > 1 ? 's' : ''}`;
  } else {
    v.classList.add('good');
    v.textContent = '✓ Verified — no problems';
  }
}

// ----------------------------------------------------------------- stock
function rebuildStock() {
  const s = state.stock;
  const box = stockBox();
  state.sim = null;
  if (!s.show) viewer.clearStock();
  else if (s.sim) {
    state.sim = new StockSim(box, +s.res || 300);
    state.simDone = 0;
    state.simT = 0;
    viewer.setStockSim(state.sim, s.material);
  } else viewer.setStockBox(box, s.material);
  $('stCustom').classList.toggle('on', s.originXY === 'custom' || s.originZ === 'custom');
  renderStockNote(box);
}

function renderStockNote(box) {
  const su = state.stock.units === 'in' ? MM_PER_INCH : 1;
  const u = state.stock.units;
  const f = (v) => fmt(v / su, su === 1 ? 2 : 4);
  let txt = `Stock spans X ${f(box.x0)} → ${f(box.x1)}, Y ${f(box.y0)} → ${f(box.y1)}, Z ${f(box.z0)} → ${f(box.z1)} ${u}.`;
  const st = state.stats;
  if (st && boxValid(st.cut)) {
    txt += ` Cutting moves span X ${f(st.cut.min[0])} → ${f(st.cut.max[0])}, Y ${f(st.cut.min[1])} → ${f(st.cut.max[1])}, Z down to ${f(st.cut.min[2])} ${u}.`;
  }
  $('stNote').textContent = txt;
}

function onStockChanged() {
  updateScene();
  rebuildStock();
  reverify();
  applyPlayhead(false);
  save();
}

function fitStock() {
  const st = state.stats;
  if (!st || !boxValid(st.cut)) { toast('No cutting moves to fit to'); return; }
  let maxR = 0;
  for (const [t, tl] of state.tools) if (st.perTool.get(t)?.cutDist > 0) maxR = Math.max(maxR, tl.dia / 2);
  const s = state.stock;
  const su = s.units === 'in' ? MM_PER_INCH : 1;
  const r = (v) => (s.units === 'in' ? Math.ceil(v * 20) / 20 : Math.ceil(v));
  const rd = (v) => (s.units === 'in' ? Math.floor(v * 20) / 20 : Math.floor(v));
  const x0 = rd((st.cut.min[0] - maxR) / su), y0 = rd((st.cut.min[1] - maxR) / su);
  s.x = r((st.cut.max[0] + maxR) / su - x0);
  s.y = r((st.cut.max[1] + maxR) / su - y0);
  s.ox = x0;
  s.oy = y0;
  s.originXY = x0 === 0 && y0 === 0 ? 'll' : 'custom';
  if (s.originZ === 'top') {
    const need = -st.cut.min[2] / su;
    if (need > s.z) s.z = r(need);
  }
  syncStockInputs();
  onStockChanged();
  toast('Stock sized to the toolpath');
}

function stockFromComments(text) {
  const head = text.slice(0, 20000);
  const m = /\(([^)]*?\bSTOCK\b[^)]*)\)/i.exec(head) || /;(.*\bSTOCK\b.*)$/im.exec(head);
  if (!m) return false;
  const d = /(\d*\.?\d+)\s*(?:mm|in|")?\s*[X×*]\s*(\d*\.?\d+)\s*(?:mm|in|")?\s*[X×*]\s*(\d*\.?\d+)/i.exec(m[1]);
  if (!d) return false;
  const s = state.stock;
  s.units = state.prog?.units || 'mm';
  s.x = +d[1]; s.y = +d[2]; s.z = +d[3];
  if (/lower\s*left/i.test(m[1] + text.slice(0, 3000))) s.originXY = 'll';
  else if (/cent(er|re)/i.test(m[1])) s.originXY = 'c';
  if (/z0\s*(?:=|at|is)?\s*(?:the\s*)?bottom/i.test(text.slice(0, 3000))) s.originZ = 'bottom';
  else if (/z0\s*(?:=|at|is)?\s*(?:the\s*)?top/i.test(text.slice(0, 3000))) s.originZ = 'top';
  return true;
}

// ------------------------------------------------------------ playback
function segAt(t) {
  const cum = state.times.cum;
  const n = state.prog.segs.n;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] < t) lo = mid; // at a boundary, report the move that just finished
    else hi = mid - 1;
  }
  return lo;
}

function applyPlayhead(scrollEditor) {
  const prog = state.prog;
  const segs = prog.segs;
  const n = segs.n;
  const total = n ? state.times.cum[n] : 0;
  $('pbSlider').value = total > 0 ? Math.round((state.t / total) * 10000) : 10000;
  $('pbTime').textContent = `${formatTime(state.t)} / ${formatTime(total)}`;
  if (!n) {
    viewer.setToolVisible(false);
    $('hud').innerHTML = '';
    return;
  }
  viewer.setToolVisible(state.display.tool);
  const i = segAt(state.t);
  const dt = state.times.time[i];
  let frac = dt > 0 ? (state.t - state.times.cum[i]) / dt : 1;
  frac = Math.min(1, Math.max(0, frac));
  const o = i * 6, p = segs.p;
  const pos = [p[o] + (p[o + 3] - p[o]) * frac, p[o + 1] + (p[o + 4] - p[o + 1]) * frac, p[o + 2] + (p[o + 5] - p[o + 2]) * frac];
  const doneCount = frac >= 1 - 1e-9 ? i + 1 : i;
  viewer.setProgress(doneCount, frac, frac < 1 ? pos : null);

  const T = segs.tool[i];
  if (state.shownTool !== T) {
    viewer.setTool(state.tools.get(T), { holder: state.display.holder });
    state.shownTool = T;
  }
  viewer.setToolPos(pos);
  const rpm = segs.rpm[i];
  viewer.toolSpin = state.playing && rpm ? -Math.sign(rpm) * Math.min((Math.abs(rpm) / 60) * Math.PI * 2, 45) : 0;

  // material removal
  const sim = state.sim;
  if (sim) {
    if (doneCount < state.simDone || state.t < state.simT - 1e-9) {
      sim.reset();
      state.simDone = 0;
    }
    for (let k = state.simDone; k < doneCount; k++) cutSeg(sim, k, 1);
    state.simDone = doneCount;
    if (doneCount === i) cutSeg(sim, i, frac);
    state.simT = state.t;
    viewer.updateStockSim();
  }

  const line = segs.line[i];
  editor.setActive(line, scrollEditor && state.display.follow);
  renderHud(i, pos);
}

function cutSeg(sim, k, frac) {
  const segs = state.prog.segs;
  const tl = state.tools.get(segs.tool[k]);
  if (!tl || !(tl.dia > 0)) return;
  const o = k * 6, p = segs.p;
  sim.cutSeg(p[o], p[o + 1], p[o + 2], p[o] + (p[o + 3] - p[o]) * frac, p[o + 1] + (p[o + 4] - p[o + 1]) * frac, p[o + 2] + (p[o + 5] - p[o + 2]) * frac, sim.kernel(tl));
}

function renderHud(i, pos) {
  const segs = state.prog.segs;
  const s = progScale();
  const T = segs.tool[i];
  const tl = state.tools.get(T);
  const ty = segs.type[i];
  const rpm = segs.rpm[i];
  const fm = segs.fmode[i];
  const feed = ty === RAPID ? '' : fm === FM_INVERSE ? `F${fmt(segs.feed[i])} (1/min)` : fm === FM_PER_REV ? `F${num(segs.feed[i])}/rev` : `F${fmt(segs.feed[i] / s, 1)}`;
  const code = segs.code[i];
  $('hud').innerHTML = `
    <div class="xyz"><span><i>X</i>${num(pos[0])}</span><span><i>Y</i>${num(pos[1])}</span><span><i>Z</i>${num(pos[2])}</span></div>
    <div class="row"><span>Line ${segs.line[i] + 1}</span><span>G${code} ${describeG(code)}</span><span>${feed}</span>
    <span>${rpm ? `S${Math.abs(rpm)} ${rpm > 0 ? 'CW' : 'CCW'}` : 'Spindle off'}</span></div>
    <div class="row"><span class="tchip" style="--c:${toolColor(T)}">T${T}</span><span>${tl ? `${TOOL_TYPES[tl.type].label} Ø${num(tl.dia)}` : ''}</span></div>`;
}

function setT(t) {
  state.t = Math.max(0, Math.min(t, state.times.cum[state.prog.segs.n] || 0));
}

function play(on) {
  const total = state.times?.cum[state.prog.segs.n] || 0;
  if (on && total <= 0) return;
  if (on && state.t >= total - 1e-9) setT(0);
  state.playing = on;
  updatePlayButton();
  if (!on) viewer.toolSpin = 0;
}

function updatePlayButton() {
  const b = $('pbPlay');
  b.textContent = state.playing ? '❚❚' : '▶';
  b.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
}

viewer.onFrame = (dt) => {
  if (!state.playing || !state.prog) return;
  const total = state.times.cum[state.prog.segs.n];
  setT(state.t + dt * state.speed);
  if (state.t >= total) { state.playing = false; updatePlayButton(); viewer.toolSpin = 0; }
  applyPlayhead(true);
};

function stepLine(dir) {
  const segs = state.prog?.segs;
  if (!segs?.n) return;
  play(false);
  const cum = state.times.cum;
  // last segment that has (partly) run: cum[cur] < t
  let cur = -1;
  if (state.t > 0) {
    let lo = 0, hi = segs.n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cum[mid] < state.t) lo = mid;
      else hi = mid - 1;
    }
    cur = lo;
  }
  let target;
  if (dir > 0) {
    let j = cur + 1;
    if (j >= segs.n) return;
    const L = segs.line[j];
    while (j + 1 < segs.n && segs.line[j + 1] === L) j++;
    target = j;
  } else {
    if (cur < 0) return;
    let j = cur;
    const L = segs.line[j];
    while (j >= 0 && segs.line[j] === L) j--;
    if (j < 0) { setT(0); applyPlayhead(true); highlightLineOf(-1); editor.setSelected(-1); return; }
    target = j;
  }
  setT(cum[target + 1]);
  applyPlayhead(true);
  highlightLineOf(segs.line[target]);
  editor.setSelected(segs.line[target]);
}

function highlightLineOf(line) {
  const segs = state.prog.segs;
  if (line < 0) { viewer.highlight(-1, -1); return; }
  const idx = state.lineIdx[line];
  if (idx < 0 || segs.line[idx] !== line) { viewer.highlight(-1, -1); return; }
  let i0 = idx;
  while (i0 > 0 && segs.line[i0 - 1] === line) i0--;
  viewer.highlight(i0, idx);
}

/** Move the playhead to the end of a program line. */
function selectLine(line, scroll) {
  if (!state.prog) return;
  play(false);
  const idx = line < state.lineIdx.length ? state.lineIdx[line] : state.prog.segs.n - 1;
  setT(idx < 0 ? 0 : state.times.cum[idx + 1]);
  highlightLineOf(line);
  editor.setSelected(line);
  applyPlayhead(scroll);
}

// --------------------------------------------------------------- scene
function updateScene() {
  const b = new THREE.Box3();
  const st = state.stats;
  if (st && boxValid(st.all)) {
    b.expandByPoint(new THREE.Vector3(...st.all.min));
    b.expandByPoint(new THREE.Vector3(...st.all.max));
  }
  const sb = stockBox();
  b.expandByPoint(new THREE.Vector3(sb.x0, sb.y0, sb.z0));
  b.expandByPoint(new THREE.Vector3(sb.x1, sb.y1, sb.z1));
  viewer.setScene(b, progScale());
}

function renderLegend() {
  const el = $('legend');
  if (state.display.colorBy === 'tool') {
    el.innerHTML = [...state.tools.keys()].filter((t) => state.prog.segs.tool.includes(t))
      .map((t) => `<span><i style="background:${toolColor(t)}"></i>T${t}</span>`).join('');
  } else {
    const c = (t) => '#' + PATH_COLORS[t].getHexString();
    el.innerHTML = `<span><i style="background:${c(RAPID)}"></i>Rapid</span><span><i style="background:${c(FEED)}"></i>Feed</span><span><i style="background:${c(ARC)}"></i>Arc</span><span><i style="background:${c(DRILL)}"></i>Drill cycle</span>`;
  }
}

// ----------------------------------------------------------------- stats
function renderStats() {
  const prog = state.prog, st = state.stats;
  if (!prog || !prog.segs.n) { $('stats').innerHTML = '<p class="hint">No moves yet.</p>'; return; }
  const u = progUnit();
  const range = (b, k) => (boxValid(b) ? `${num(b.min[k])} → ${num(b.max[k])}` : '—');
  const rows = [
    ['Units', prog.units === 'in' ? 'Inch (G20)' : 'Millimetre (G21)'],
    ['Lines', prog.lineCount.toLocaleString()],
    ['Moves drawn', prog.segs.n.toLocaleString()],
    ['Tool changes', prog.toolChanges],
    ['Estimated run time', formatTime(st.total) + (state.times.incomplete ? ' (some feeds missing)' : '')],
    ['Cutting time', formatTime(st.cutTime)],
    ['Rapid time', formatTime(st.rapidTime)],
    ['Dwell', prog.dwellTotal ? fmt(prog.dwellTotal, 1) + ' s' : '—'],
    ['Cutting distance', `${num(st.cutDist)} ${u}`],
    ['Rapid distance', `${num(st.rapidDist)} ${u}`],
    ['Cutting X', range(st.cut, 0)], ['Cutting Y', range(st.cut, 1)], ['Cutting Z', range(st.cut, 2)],
    ['All moves X', range(st.all, 0)], ['All moves Y', range(st.all, 1)], ['All moves Z', range(st.all, 2)],
  ];
  let html = `<table class="kv">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>`;
  html += `<h3>Per tool</h3><table class="grid"><tr><th>Tool</th><th>Type</th><th>Ø</th><th>Time</th><th>Min Z</th></tr>`;
  for (const [t, pt] of st.perTool) {
    const tl = state.tools.get(t);
    html += `<tr><td><span class="tchip" style="--c:${toolColor(t)}">T${t}</span></td><td>${tl ? TOOL_TYPES[tl.type].label : '?'}</td><td>${tl ? num(tl.dia) : ''}</td><td>${formatTime(pt.time)}</td><td>${Number.isFinite(pt.minZ) ? num(pt.minZ) : '—'}</td></tr>`;
  }
  html += '</table><p class="hint">Times use the feed rates in the program and the rapid rate in Settings; real machines add acceleration and tool-change time.</p>';
  $('stats').innerHTML = html;
}

// ----------------------------------------------------------------- tools
let thumbR = null;
function thumbnail(tool) {
  try {
    if (!thumbR) {
      const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      r.setSize(72, 120, false);
      r.outputColorSpace = THREE.SRGBColorSpace;
      const scene = new THREE.Scene();
      scene.environment = new THREE.PMREMGenerator(r).fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environmentIntensity = 0.6;
      scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.2));
      const d = new THREE.DirectionalLight(0xffffff, 1.5);
      d.position.set(1, -2, 1);
      scene.add(d);
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
      cam.up.set(0, 0, 1);
      thumbR = { r, scene, cam };
    }
    const { r, scene, cam } = thumbR;
    const m = buildToolMesh(tool, { holder: false });
    scene.add(m);
    const b = new THREE.Box3().setFromObject(m);
    const c = b.getCenter(new THREE.Vector3());
    const size = b.getSize(new THREE.Vector3());
    const h = Math.max(size.z, (Math.max(size.x, size.y) * 120) / 72) * 0.56;
    cam.left = (-h * 72) / 120; cam.right = (h * 72) / 120; cam.top = h; cam.bottom = -h;
    cam.position.set(c.x + 10, c.y - 40, c.z + 8);
    cam.lookAt(c);
    cam.updateProjectionMatrix();
    r.render(scene, cam);
    scene.remove(m);
    return r.domElement.toDataURL();
  } catch {
    return '';
  }
}

function renderTools() {
  const list = $('toolList');
  list.innerHTML = '';
  if (!state.tools.size) { list.innerHTML = '<p class="hint">No tools yet.</p>'; return; }
  const s = progScale();
  for (const [t, tool] of state.tools) {
    const card = document.createElement('div');
    card.className = 'tool-card';
    const used = state.prog.segs.tool.includes(t);
    card.innerHTML = `
      <img class="thumb" alt="">
      <div class="tc-body">
        <div class="tc-head">
          <span class="tchip" style="--c:${toolColor(t)}">T${t}</span>
          <select class="tc-type" aria-label="T${t} type">${Object.entries(TOOL_TYPES).map(([k, v]) => `<option value="${k}" ${k === tool.type ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
          ${used ? '' : '<span class="muted">not used</span>'}
        </div>
        <div class="tc-fields"></div>
        <div class="tc-src"></div>
      </div>`;
    const img = card.querySelector('.thumb');
    const fields = card.querySelector('.tc-fields');
    const src = card.querySelector('.tc-src');
    const draw = () => {
      const cur = state.tools.get(t);
      fields.innerHTML = '';
      for (const f of TYPE_FIELDS[cur.type]) {
        const lab = document.createElement('label');
        const isLen = !['angle', 'flutes'].includes(f);
        lab.textContent = FIELD_LABELS[f] + (isLen ? ` (${progUnit()})` : '');
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.step = 'any';
        inp.min = '0';
        inp.value = isLen ? fmt(cur[f] / s, s === 1 ? 3 : 4) : cur[f];
        inp.addEventListener('change', () => {
          const v = parseFloat(inp.value);
          if (!Number.isFinite(v) || v < 0) return;
          updateTool(t, { [f]: isLen ? v * s : f === 'flutes' ? Math.round(v) : v });
          img.src = thumbnail(state.tools.get(t));
        });
        lab.appendChild(inp);
        fields.appendChild(lab);
      }
      src.innerHTML = '';
      const p = document.createElement('span');
      p.textContent = cur.source ? `From program: “${cur.source}”` : 'No description in the program — defaults shown.';
      src.appendChild(p);
      if (cur.edited) {
        const b = document.createElement('button');
        b.className = 'link';
        b.textContent = 'Reset';
        b.addEventListener('click', () => {
          delete state.toolEdits[state.toolKeys.get(t)];
          save();
          buildTools();
          afterToolsChanged();
          renderTools();
        });
        src.appendChild(b);
      }
      img.src = thumbnail(cur);
    };
    card.querySelector('.tc-type').addEventListener('change', (e) => {
      const cur = state.tools.get(t);
      const next = defaultTool(e.target.value, cur.dia);
      updateTool(t, { ...next, source: cur.source });
      draw();
    });
    list.appendChild(card);
    draw();
  }
}

function updateTool(t, patch) {
  const key = state.toolKeys.get(t);
  const cur = state.tools.get(t);
  const next = { ...cur, ...patch, edited: true, guessed: false };
  state.tools.set(t, next);
  const { source, edited, guessed, ...stored } = next;
  state.toolEdits[key] = stored;
  state.toolIssues = state.toolIssues.filter((i) => !i.msg.startsWith(`T${t} `));
  save();
  afterToolsChanged();
}

let toolTimer = 0;
function afterToolsChanged() {
  clearTimeout(toolTimer);
  toolTimer = setTimeout(() => {
    state.shownTool = null;
    rebuildStock();
    reverify();
    renderStats();
    applyPlayhead(false);
  }, 120);
}

// ------------------------------------------------------------ loading
function loadProgram(text, name, { fromFile = false } = {}) {
  if (name) state.fileName = name;
  editor.setText(text);
  // parse once to learn units, then read any stock size comment
  state.prog = parseGcode(text, { defaultUnits: state.machine.defUnits });
  if (fromFile && stockFromComments(text)) {
    syncStockInputs();
    toast(`Stock size read from the program: ${state.stock.x} × ${state.stock.y} × ${state.stock.z} ${state.stock.units}`, 4000);
  }
  reparse(text, { fitView: true });
  save();
}

async function openFile(file) {
  if (!file) return;
  if (file.size > 60e6) { toast('That file is too large (over 60 MB)'); return; }
  const text = await file.text();
  loadProgram(text, file.name, { fromFile: true });
  toast(`Opened ${file.name}`);
}

// --------------------------------------------------------------- inputs
function syncStockInputs() {
  const s = state.stock;
  $('stUnits').value = s.units;
  $('stMaterial').value = s.material;
  $('stX').value = s.x; $('stY').value = s.y; $('stZ').value = s.z;
  $('stOriginXY').value = s.originXY;
  $('stOriginZ').value = s.originZ;
  $('stOX').value = s.ox; $('stOY').value = s.oy; $('stOZ').value = s.oz;
  $('stShow').checked = s.show;
  $('stSim').checked = s.sim;
  $('stRes').value = String(s.res);
}

function initInputs() {
  $('stMaterial').innerHTML = Object.entries(MATERIALS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  syncStockInputs();
  const bindStock = (id, key, kind = 'str') => $(id).addEventListener('change', (e) => {
    const el = e.target;
    let v = kind === 'bool' ? el.checked : kind === 'num' ? parseFloat(el.value) : el.value;
    if (kind === 'num' && !Number.isFinite(v)) return;
    if (key === 'originXY' && v === 'custom') {
      const b = stockBox();
      const su = state.stock.units === 'in' ? MM_PER_INCH : 1;
      state.stock.ox = +fmt(b.x0 / su); state.stock.oy = +fmt(b.y0 / su);
    }
    if (key === 'originZ' && v === 'custom') {
      const b = stockBox();
      state.stock.oz = +fmt(b.z0 / (state.stock.units === 'in' ? MM_PER_INCH : 1));
    }
    if (key === 'units' && v !== state.stock.units) {
      const f = v === 'in' ? 1 / MM_PER_INCH : MM_PER_INCH;
      for (const k of ['x', 'y', 'z', 'ox', 'oy', 'oz']) state.stock[k] = +fmt(state.stock[k] * f, 4);
    }
    state.stock[key] = key === 'res' ? +v : v;
    syncStockInputs();
    onStockChanged();
  });
  bindStock('stUnits', 'units');
  bindStock('stMaterial', 'material');
  bindStock('stX', 'x', 'num'); bindStock('stY', 'y', 'num'); bindStock('stZ', 'z', 'num');
  bindStock('stOriginXY', 'originXY');
  bindStock('stOriginZ', 'originZ');
  bindStock('stOX', 'ox', 'num'); bindStock('stOY', 'oy', 'num'); bindStock('stOZ', 'oz', 'num');
  bindStock('stShow', 'show', 'bool');
  bindStock('stSim', 'sim', 'bool');
  bindStock('stRes', 'res');
  $('stFit').addEventListener('click', fitStock);

  const m = state.machine;
  const syncMachine = () => {
    $('mUnits').value = m.units; $('mRapid').value = m.rapid; $('mMaxFeed').value = m.maxFeed; $('mMaxRpm').value = m.maxRpm; $('mDefUnits').value = m.defUnits;
  };
  syncMachine();
  $('mUnits').addEventListener('change', (e) => {
    const f = e.target.value === 'in' ? 1 / MM_PER_INCH : MM_PER_INCH;
    if (e.target.value !== m.units) { m.rapid = +fmt(m.rapid * f, 2); m.maxFeed = +fmt(m.maxFeed * f, 2); }
    m.units = e.target.value;
    syncMachine();
    save();
  });
  for (const [id, key] of [['mRapid', 'rapid'], ['mMaxFeed', 'maxFeed'], ['mMaxRpm', 'maxRpm']]) {
    $(id).addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      if (!Number.isFinite(v) || v < 0 || (key === 'rapid' && v <= 0)) { syncMachine(); return; }
      m[key] = v;
      save();
      reparse(editor.value);
    });
  }
  $('mDefUnits').addEventListener('change', (e) => { m.defUnits = e.target.value; save(); reparse(editor.value); });

  const d = state.display;
  const bindDisp = (id, key, fn) => {
    const el = $(id);
    if (el.type === 'checkbox') el.checked = d[key];
    else el.value = d[key];
    el.addEventListener('change', () => { d[key] = el.type === 'checkbox' ? el.checked : el.value; save(); fn(); });
  };
  const redrawPath = () => { viewer.setPath(state.prog.segs, { colorBy: d.colorBy, showRapids: d.rapids }); renderLegend(); applyPlayhead(false); };
  bindDisp('dColor', 'colorBy', redrawPath);
  bindDisp('dRapids', 'rapids', redrawPath);
  bindDisp('dPath', 'path', () => viewer.setPathVisible(d.path));
  bindDisp('dTool', 'tool', () => viewer.setToolVisible(d.tool));
  bindDisp('dHolder', 'holder', () => { state.shownTool = null; applyPlayhead(false); });
  bindDisp('dGrid', 'grid', () => viewer.setGridVisible(d.grid));
  bindDisp('dFollow', 'follow', () => {});
  viewer.setPathVisible(d.path);
  viewer.setGridVisible(d.grid);

  // tabs
  for (const b of document.querySelectorAll('.tabs button')) {
    b.addEventListener('click', () => {
      for (const x of document.querySelectorAll('.tabs button, .tab')) x.classList.toggle('on', x.dataset.tab === b.dataset.tab);
    });
  }
  // issue filters
  for (const cb of document.querySelectorAll('.filters input')) {
    cb.addEventListener('change', () => {
      if (cb.checked) state.sevFilter.add(cb.dataset.sev);
      else state.sevFilter.delete(cb.dataset.sev);
      renderIssues();
    });
  }
  $('verdict').addEventListener('click', () => {
    const pane = $('issuesPane');
    pane.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    pane.classList.remove('flash');
    void pane.offsetWidth;
    pane.classList.add('flash');
  });

  // views
  for (const b of document.querySelectorAll('.view-tools [data-view]')) {
    b.addEventListener('click', () => viewer.fit(b.dataset.view === 'fit' ? null : b.dataset.view));
  }
  $('btnProj').addEventListener('click', (e) => {
    const ortho = viewer.camera !== viewer.ortho;
    viewer.setProjection(ortho);
    e.target.textContent = ortho ? 'Ortho' : 'Persp';
  });

  // playback
  $('pbPlay').addEventListener('click', () => play(!state.playing));
  $('pbStart').addEventListener('click', () => { play(false); setT(0); applyPlayhead(true); });
  $('pbEnd').addEventListener('click', () => { play(false); setT(Infinity); applyPlayhead(true); });
  $('pbBack').addEventListener('click', () => stepLine(-1));
  $('pbFwd').addEventListener('click', () => stepLine(1));
  $('pbSlider').addEventListener('input', (e) => {
    play(false);
    const total = state.times?.cum[state.prog.segs.n] || 0;
    setT((+e.target.value / 10000) * total);
    applyPlayhead(true);
  });
  $('pbSpeed').value = String(state.speed);
  $('pbSpeed').addEventListener('change', (e) => { state.speed = +e.target.value; save(); });

  // file actions
  $('btnOpen').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
  $('btnSample').addEventListener('click', () => {
    Object.assign(state.stock, SAMPLE_STOCK);
    syncStockInputs();
    loadProgram(SAMPLE, 'sample.nc');
    toast('Sample loaded: 100 × 80 × 12 mm aluminum plate');
  });
  $('btnClear').addEventListener('click', () => {
    if (editor.value.trim() && !confirm('Clear the program?')) return;
    loadProgram('', 'program.nc');
    editor.ta.focus();
  });
  $('btnSave').addEventListener('click', () => {
    const blob = new Blob([editor.value], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = state.fileName || 'program.nc';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('btnPaste').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) { toast('The clipboard is empty'); return; }
      loadProgram(text, 'pasted.nc', { fromFile: true });
      toast('Pasted from the clipboard');
    } catch {
      editor.ta.focus();
      editor.ta.select();
      toast('Press Ctrl+V (⌘V) to paste into the editor', 3500);
    }
  });

  // drag & drop
  const overlay = $('dropOverlay');
  let depth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { depth++; overlay.classList.add('on'); e.preventDefault(); } });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) overlay.classList.remove('on'); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    overlay.classList.remove('on');
    const f = e.dataTransfer?.files?.[0];
    if (f) openFile(f);
  });

  // pick toolpath in 3D
  const canvas = viewer.renderer.domElement;
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
    const i = viewer.pick(e.clientX, e.clientY);
    if (i < 0) return;
    const line = state.prog.segs.line[i];
    editor.goToLine(line);
    selectLine(line, false);
  });

  // keyboard
  window.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ' ') { e.preventDefault(); play(!state.playing); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stepLine(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); stepLine(-1); }
    else if (e.key === 'Home') { play(false); setT(0); applyPlayhead(true); }
    else if (e.key === 'End') { play(false); setT(Infinity); applyPlayhead(true); }
  });
}

// ------------------------------------------------------------------- go
const saved = load();
initInputs();
if (saved && saved.trim()) loadProgram(saved, state.fileName);
else {
  Object.assign(state.stock, SAMPLE_STOCK);
  syncStockInputs();
  loadProgram(SAMPLE, 'sample.nc');
}
window.ncviewer = { state, viewer, editor }; // handy from the browser console
