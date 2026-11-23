// NC Viewer: wires the editor, parser, verifier, stock simulation and 3D view.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { parseGcode, MM_PER_INCH, RAPID, FEED, ARC, DRILL, FM_PER_REV, FM_INVERSE, fmt, describeG } from './gcode.js';
import { toolFromHints, TOOL_TYPES, TYPE_FIELDS, FIELD_LABELS, defaultTool } from './tools.js';
import { computeTimes, computeStats, verify, lineIndex, formatTime, boxValid } from './analyze.js';
import { StockSim } from './sim.js';
import { Viewer, MATERIALS, PATH_COLORS, toolColor, depthColor } from './viewer.js';
import { CodeEditor } from './editor.js';
import { DEMOS } from './demos.js';
import { buildToolMesh } from './toolmesh.js';

const $ = (id) => document.getElementById(id);
const STORE = 'ncviewer:v2';
const SEV_RANK = { error: 3, warning: 2, info: 1 };
const MACHINE_DEFAULTS = {
  units: 'mm', rapidXY: 5000, rapidZ: 2000, accXY: 250, accZ: 100, toolChange: 5,
  maxFeed: 10000, maxRpm: 24000, defUnits: 'mm', homeX: 0, homeY: 0, homeZ: 50,
};

const state = {
  stock: { units: 'mm', x: 100, y: 80, z: 12, originXY: 'll', originZ: 'top', ox: 0, oy: 0, oz: -12, material: 'aluminum', show: true, sim: true, res: 300 },
  machine: { ...MACHINE_DEFAULTS },
  display: { byTool: false, depth: false, feeds: true, rapids: true, grid: true, axes: true, tool: true, holder: false, fx: true, followTool: false, followCode: true },
  ui: { code: true, railL: true, railR: true, dyn: false },
  toolEdits: {},
  fileName: '',
  speed: 10,
  // runtime
  prog: null, tools: new Map(), toolKeys: new Map(), toolIssues: [], times: null, stats: null, lineIdx: null, issues: [],
  t: 0, playing: false, sim: null, simDone: 0, simT: 0, shownTool: null, lastToolPos: null, undoText: null,
  sevFilter: new Set(['error', 'warning', 'info']),
};

// ------------------------------------------------------------- helpers
const progScale = () => (state.prog?.units === 'in' ? MM_PER_INCH : 1);
const progUnit = () => (state.prog?.units === 'in' ? 'in' : 'mm');
const num = (mm, s = progScale()) => fmt(mm / s, s === 1 ? 3 : 4);
const show = (mm) => `${num(mm)} ${progUnit()}`;
const machScale = () => (state.machine.units === 'in' ? MM_PER_INCH : 1);
const fixed = (mm, s = progScale()) => (mm / s).toFixed(s === 1 ? 3 : 4);

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

function machineMM() {
  const m = state.machine, u = machScale();
  return {
    rapidXY: m.rapidXY * u, rapidZ: m.rapidZ * u, accXY: m.accXY * u, accZ: m.accZ * u, toolChange: +m.toolChange || 0,
    maxFeed: (+m.maxFeed || 0) * u, maxRpm: +m.maxRpm || 0, home: [m.homeX * u, m.homeY * u, m.homeZ * u],
  };
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
    Object.assign(state.ui, d.ui || {});
    state.toolEdits = d.toolEdits || {};
    state.speed = d.speed || state.speed;
    state.fileName = d.fileName || '';
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
        text: text.length < 2e6 ? text : '', stock: state.stock, machine: state.machine, display: state.display, ui: state.ui,
        toolEdits: state.toolEdits, speed: state.speed, fileName: state.fileName,
      }));
    } catch { /* storage full or blocked: fine */ }
  }, 400);
}

// ------------------------------------------------------------------ setup
const viewer = new Viewer($('viewport'));
const editor = new CodeEditor($('editor'), {
  onChange: (text) => { state.undoText = null; $('cvUndo').hidden = true; reparse(text); save(); },
  onCaretLine: (line) => selectLine(line, false),
});

// ------------------------------------------------------------- pipeline
function reparse(text, { fitView = false } = {}) {
  const mm = machineMM();
  const prog = parseGcode(text, { defaultUnits: state.machine.defUnits, home: mm.home });
  state.prog = prog;
  buildTools();
  state.times = computeTimes(prog.segs, mm);
  state.stats = computeStats(prog.segs, state.times);
  state.lineIdx = lineIndex(prog.segs, prog.lineCount);
  drawPath();
  viewer.highlight(-1, -1);
  state.shownTool = null;
  state.lastToolPos = null;
  updateScene();
  rebuildStock();
  reverify();
  renderTools();
  renderStats();
  state.playing = false;
  updatePlayButton();
  state.t = state.times.cum[prog.segs.n] || 0;
  applyPlayhead(false);
  updateFileBar(text);
  document.querySelectorAll('.uLen').forEach((e) => { e.textContent = progUnit(); });
  $('welcome').hidden = !!text.trim();
  if (fitView) viewer.fit('iso');
}

function drawPath() {
  const d = state.display;
  viewer.setPath(state.prog.segs, { colorBy: d.depth ? 'depth' : d.byTool ? 'tool' : 'type', showRapids: d.rapids, showFeeds: d.feeds });
  renderLegend();
}

function updateFileBar(text) {
  const has = !!text.trim();
  $('fileDot').classList.toggle('on', has);
  $('fileName').textContent = has ? state.fileName || 'Untitled.nc' : 'No file open';
  const kb = new Blob([text]).size / 1024;
  $('fileMeta').textContent = has ? `${kb < 1 ? '<1' : Math.round(kb).toLocaleString()} KB · ${state.prog.segs.n.toLocaleString()} seg` : '';
  $('progMeta').textContent = has ? `${state.prog.lineCount.toLocaleString()} lines · ${state.prog.units}` : '';
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
    if (!edit && detected.guessed && prog.segs.tool.includes(t)) {
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
  const mm = machineMM();
  const geo = verify(prog.segs, stockBox(), state.tools, { maxRpm: mm.maxRpm, maxFeed: mm.maxFeed }, show);
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
    v.textContent = editor.value.trim() ? 'No moves found' : 'Not checked';
  } else if (counts.error) {
    v.classList.add('bad');
    v.textContent = `✕ ${counts.error} error${counts.error > 1 ? 's' : ''}${counts.warning ? ` · ${counts.warning} warning${counts.warning > 1 ? 's' : ''}` : ''}`;
  } else if (counts.warning) {
    v.classList.add('warn');
    v.textContent = `! ${counts.warning} warning${counts.warning > 1 ? 's' : ''}`;
  } else {
    v.classList.add('good');
    v.textContent = '✓ Verified';
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
  viewer.chips.setColor((MATERIALS[s.material] || MATERIALS.aluminum).cut);
  $('stCustom').classList.toggle('on', s.originXY === 'custom' || s.originZ === 'custom');
  renderStockNote(box);
}

function renderStockNote(box) {
  const su = state.stock.units === 'in' ? MM_PER_INCH : 1;
  const f = (v) => fmt(v / su, su === 1 ? 2 : 4);
  let txt = `Stock: X ${f(box.x0)}…${f(box.x1)}, Y ${f(box.y0)}…${f(box.y1)}, Z ${f(box.z0)}…${f(box.z1)} ${state.stock.units}.`;
  const st = state.stats;
  if (st && boxValid(st.cut)) txt += ` Cuts: X ${f(st.cut.min[0])}…${f(st.cut.max[0])}, Y ${f(st.cut.min[1])}…${f(st.cut.max[1])}, Z to ${f(st.cut.min[2])}.`;
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
  const head3 = text.slice(0, 3000);
  if (/lower\s*left/i.test(head3)) s.originXY = 'll';
  else if (/origin\s*(?:at\s*)?(?:the\s*)?cent(er|re)/i.test(head3)) s.originXY = 'c';
  if (/z0\s*(?:=|at|is)?\s*(?:the\s*)?bottom/i.test(head3)) s.originZ = 'bottom';
  else if (/z0\s*(?:=|at|is)?\s*(?:the\s*)?top/i.test(head3)) s.originZ = 'top';
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
  const segs = state.prog.segs;
  const n = segs.n;
  const total = n ? state.times.cum[n] : 0;
  $('pbSlider').value = total > 0 ? Math.round((state.t / total) * 10000) : 10000;
  $('pbTime').textContent = `${formatTime(state.t)} / ${formatTime(total)}`;
  if (!n) {
    viewer.setToolVisible(false);
    viewer.setProgress(0, 0, null);
    renderDro(null, -1);
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
  const tl = state.tools.get(T);
  if (state.shownTool !== T) {
    viewer.setTool(tl, { holder: state.display.holder });
    state.shownTool = T;
  }
  viewer.setToolPos(pos);
  if (state.display.followTool && state.lastToolPos) {
    viewer.follow(new THREE.Vector3(pos[0] - state.lastToolPos[0], pos[1] - state.lastToolPos[1], pos[2] - state.lastToolPos[2]));
  }
  state.lastToolPos = pos;
  const rpm = segs.rpm[i];
  viewer.toolSpin = state.playing && rpm ? -Math.sign(rpm) * Math.min((Math.abs(rpm) / 60) * Math.PI * 2, 45) : 0;

  // material removal
  let removed = 0;
  const sim = state.sim;
  if (sim) {
    if (doneCount < state.simDone || state.t < state.simT - 1e-9) {
      sim.reset();
      state.simDone = 0;
    }
    for (let k = state.simDone; k < doneCount; k++) removed = Math.max(removed, cutSeg(sim, k, 1));
    state.simDone = doneCount;
    if (doneCount === i) removed = Math.max(removed, cutSeg(sim, i, frac));
    state.simT = state.t;
    viewer.updateStockSim();
  } else if (segs.type[i] !== RAPID) {
    const b = stockBox();
    if (pos[2] < b.z1 && pos[0] > b.x0 && pos[0] < b.x1 && pos[1] > b.y0 && pos[1] < b.y1) removed = 1;
  }
  if (state.playing && state.display.fx && removed > 0 && rpm && tl) {
    const R = tl.dia / 2;
    viewer.chips.emit(pos, R, Math.min(12, 3 + Math.round(R)), Math.max(40, R * 25), 1500);
  }

  editor.setActive(segs.line[i], scrollEditor && state.display.followCode);
  renderDro(pos, i);
}

function cutSeg(sim, k, frac) {
  const segs = state.prog.segs;
  const tl = state.tools.get(segs.tool[k]);
  if (!tl || !(tl.dia > 0)) return 0;
  const o = k * 6, p = segs.p;
  return sim.cutSeg(p[o], p[o + 1], p[o + 2], p[o] + (p[o + 3] - p[o]) * frac, p[o + 1] + (p[o + 4] - p[o + 1]) * frac, p[o + 2] + (p[o + 5] - p[o + 2]) * frac, sim.kernel(tl));
}

function renderDro(pos, i) {
  $('droUnits').textContent = progUnit().toUpperCase();
  const set = (id, v) => { $(id).textContent = pos ? fixed(v) : (0).toFixed(progScale() === 1 ? 3 : 4); };
  set('droX', pos?.[0]); set('droY', pos?.[1]); set('droZ', pos?.[2]);
  const segs = state.prog?.segs;
  const T = i >= 0 ? segs.tool[i] : null;
  const tl = T !== null ? state.tools.get(T) : null;
  $('curT').textContent = T !== null ? `T${T}` : 'T—';
  $('curTool').textContent = tl ? `Ø${num(tl.dia)}${progUnit()} · ${TOOL_TYPES[tl.type].label.toLowerCase()}` : 'tool';
  if (i < 0) { $('droInfo').innerHTML = ''; return; }
  const ty = segs.type[i], fm = segs.fmode[i], rpm = segs.rpm[i], code = segs.code[i];
  const feed = ty === RAPID ? 'Rapid' : fm === FM_INVERSE ? `F${fmt(segs.feed[i])} inv` : fm === FM_PER_REV ? `F${num(segs.feed[i])}/rev` : `F${fmt(segs.feed[i] / progScale(), 1)}`;
  $('droInfo').innerHTML = `<span>Line ${segs.line[i] + 1}</span><span>G${code} ${describeG(code)}</span><span>${feed}</span><span>${rpm ? `S${Math.abs(rpm)} ${rpm > 0 ? 'CW' : 'CCW'}` : 'Spindle off'}</span>`;
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
  let cur = -1; // last move that has (partly) run
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
  viewer.setGridVisible(state.display.grid);
  viewer.setAxesVisible(state.display.axes);
}

function renderLegend() {
  const el = $('legend');
  const d = state.display;
  const c = (t) => '#' + PATH_COLORS[t].getHexString();
  if (d.depth && viewer.depthRange) {
    const [lo, hi] = viewer.depthRange;
    const g = [0, 0.25, 0.5, 0.75, 1].map((f) => '#' + depthColor(f).getHexString()).join(',');
    el.innerHTML = `<span>Z ${num(hi)}</span><span><i style="width:80px;background:linear-gradient(90deg,${g})"></i></span><span>Z ${num(lo)}</span>`;
  } else if (d.byTool) {
    el.innerHTML = [...state.tools.keys()].filter((t) => state.prog.segs.tool.includes(t))
      .map((t) => `<span><i style="background:${toolColor(t)}"></i>T${t}</span>`).join('');
  } else {
    el.innerHTML = `<span><i style="background:${c(FEED)}"></i>Feed</span><span><i style="background:${c(ARC)}"></i>Arc</span><span><i style="background:${c(DRILL)}"></i>Drill cycle</span><span><i style="background:${c(RAPID)}"></i>Rapid</span>`;
  }
}

// ----------------------------------------------------------------- stats
function renderStats() {
  const prog = state.prog, st = state.stats;
  const u = progUnit();
  const has = prog && prog.segs.n;
  const range = (b, k) => (has && boxValid(b) ? `${fmt(b.min[k] / progScale(), 3)} … ${fmt(b.max[k] / progScale(), 3)}` : '—');
  let arcs = 0;
  if (has) {
    const s = prog.segs;
    for (let i = 0; i < s.n; i++) if (s.type[i] === ARC && (i === 0 || s.type[i - 1] !== ARC || s.line[i - 1] !== s.line[i])) arcs++;
  }
  const rows = [
    ['x', 'X', range(st?.all, 0)], ['y', 'Y', range(st?.all, 1)], ['z', 'Z', range(st?.all, 2)],
    ['feed', 'Cut dist', has ? `${fmt(st.cutDist / progScale(), 1)} ${u}` : '—'],
    ['rapid', 'Rapid dist', has ? `${fmt(st.rapidDist / progScale(), 1)} ${u}` : '—'],
    ['', 'Moves', has ? prog.segs.n.toLocaleString() : '—'],
    ['', 'Arcs', has ? arcs.toLocaleString() : '—'],
    ['', 'Tools', has ? `${state.tools.size} · ${prog.toolChanges} change${prog.toolChanges === 1 ? '' : 's'}` : '—'],
    ['', 'Est run time', has ? formatTime(st.total) + (state.times.incomplete ? '*' : '') : '—'],
    ['', 'Cutting', has ? formatTime(st.cutTime) : '—'],
    ['', 'Units', u],
  ];
  $('stats').innerHTML = rows.map(([cls, k, v]) => `<tr><th class="${cls}">${k}</th><td class="${cls === 'feed' || cls === 'rapid' ? cls : ''}">${v}</td></tr>`).join('');
  $('stats').title = state.times?.incomplete ? '* some moves have no feed rate; they are timed at 1000 mm/min' : 'Uses program feeds plus the rapid rates, acceleration and tool-change time in Machine dynamics';
  const m = state.machine;
  $('dynSummary').textContent = `${m.rapidXY}/${m.rapidZ} · ${m.accXY}/${m.accZ} · ${m.toolChange}s`;
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
    const pt = state.stats?.perTool.get(t);
    card.innerHTML = `
      <img class="thumb" alt="">
      <div class="tc-body">
        <div class="tc-head">
          <span class="tchip" style="--c:${toolColor(t)}">T${t}</span>
          <select class="tc-type" aria-label="T${t} type">${Object.entries(TOOL_TYPES).map(([k, v]) => `<option value="${k}" ${k === tool.type ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
        </div>
        <div class="tc-fields"></div>
        <div class="hint" style="margin:6px 0 0">${pt ? `Runs ${formatTime(pt.time)}${Number.isFinite(pt.minZ) ? ` · deepest Z ${num(pt.minZ)}` : ''}` : 'Not used'}</div>
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
      updateTool(t, { ...defaultTool(e.target.value, cur.dia), source: cur.source });
      draw();
    });
    list.appendChild(card);
    draw();
  }
}

function updateTool(t, patch) {
  const key = state.toolKeys.get(t);
  const next = { ...state.tools.get(t), ...patch, edited: true, guessed: false };
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

// ------------------------------------------------- convert air moves to G0
function convertToRapids() {
  const prog = state.prog;
  if (!prog?.segs.n) return;
  let zMin = parseFloat($('cvZ').value);
  zMin = Number.isFinite(zMin) ? zMin * progScale() : stockBox().z1 + 0.5;
  const segs = prog.segs;
  const lineOk = new Map(); // line -> every move on it is a straight G1 at or above zMin
  for (let i = 0; i < segs.n; i++) {
    const L = segs.line[i];
    const ok = segs.type[i] === FEED && segs.code[i] === 1 && segs.p[i * 6 + 2] >= zMin - 1e-9 && segs.p[i * 6 + 5] >= zMin - 1e-9;
    lineOk.set(L, (lineOk.get(L) ?? true) && ok);
  }
  const lines = editor.value.split('\n');
  const codeOf = (s) => s.replace(/\(.*?\)|;.*$/g, '');
  const isMotion = (s) => /[XYZ]\s*[-+.\d]/i.test(codeOf(s));
  const motionG = (s) => /\bG\s*0*(?:0|1|2|3|8\d|7[346])(?![\d.])/i.test(codeOf(s));
  let count = 0;
  let pendingG1 = false;
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    if (lineOk.get(li)) {
      if (/\bG\s*0*1(?![\d.])/i.test(codeOf(raw))) lines[li] = raw.replace(/\bG(\s*)0*1(?![\d.])/i, 'G$10');
      else lines[li] = 'G0 ' + raw.replace(/^\s+/, '');
      count++;
      pendingG1 = true;
    } else if (pendingG1 && (isMotion(raw) || motionG(raw))) {
      if (!motionG(raw)) lines[li] = 'G1 ' + raw.replace(/^\s+/, ''); // restore the modal G1 the next move relied on
      pendingG1 = false;
    }
  }
  if (!count) { toast(`No feed moves stay above Z${num(zMin)} — nothing to convert`); return; }
  const before = state.stats.total;
  state.undoText = editor.value;
  const text = lines.join('\n');
  editor.setText(text);
  reparse(text);
  save();
  $('cvUndo').hidden = false;
  toast(`Converted ${count} air move${count > 1 ? 's' : ''} above Z${num(zMin)} to G0 — saves ${formatTime(before - state.stats.total)}`, 4000);
}

// ------------------------------------------------------------ loading
function loadProgram(text, name, { fromFile = false } = {}) {
  state.fileName = name || '';
  state.undoText = null;
  $('cvUndo').hidden = true;
  editor.setText(text);
  state.prog = parseGcode(text, { defaultUnits: state.machine.defUnits });
  if (fromFile && stockFromComments(text)) {
    syncStockInputs();
    toast(`Stock size read from the program: ${state.stock.x} × ${state.stock.y} × ${state.stock.z} ${state.stock.units}`, 4000);
  }
  reparse(text, { fitView: true });
  save();
}

function loadDemo(id) {
  const d = DEMOS.find((x) => x.id === id);
  if (!d) return;
  Object.assign(state.stock, d.stock);
  syncStockInputs();
  loadProgram(d.text, d.file);
  toast(`Demo: ${d.name}`);
}

async function openFile(file) {
  if (!file) return;
  if (file.size > 60e6) { toast('That file is too large (over 60 MB)'); return; }
  const text = await file.text();
  loadProgram(text, file.name, { fromFile: true });
  toast(`Opened ${file.name}`);
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) { toast('The clipboard is empty'); return; }
    loadProgram(text, 'pasted.nc', { fromFile: true });
    toast('Pasted from the clipboard');
  } catch {
    setCodePane(true);
    $('welcome').hidden = true;
    editor.ta.focus();
    editor.ta.select();
    toast('Press Ctrl+V (⌘V) to paste into the editor', 3500);
  }
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

function syncMachine() {
  const m = state.machine;
  const ids = { mUnits: 'units', mRapidXY: 'rapidXY', mRapidZ: 'rapidZ', mAccXY: 'accXY', mAccZ: 'accZ', mToolChange: 'toolChange', mMaxRpm: 'maxRpm', mMaxFeed: 'maxFeed', mDefUnits: 'defUnits', mHomeX: 'homeX', mHomeY: 'homeY', mHomeZ: 'homeZ' };
  for (const [id, k] of Object.entries(ids)) $(id).value = m[k];
}

function setCodePane(on) {
  state.ui.code = on;
  $('layout').classList.toggle('no-code', !on);
  $('btnCode').classList.toggle('on', on);
  $('btnCode').setAttribute('aria-pressed', on);
  save();
}

function setRail(id, open) {
  state.ui[id] = open;
  $(id).classList.toggle('closed', !open);
  const tab = document.querySelector(`.rail-tab[data-rail=${id}]`);
  tab.classList.toggle('shut', !open);
  const left = id === 'railL';
  tab.textContent = open === left ? '‹' : '›';
}

function initInputs() {
  $('stMaterial').innerHTML = Object.entries(MATERIALS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  syncStockInputs();
  const bindStock = (id, key, kind = 'str') => $(id).addEventListener('change', (e) => {
    const el = e.target;
    const v = kind === 'bool' ? el.checked : kind === 'num' ? parseFloat(el.value) : el.value;
    if (kind === 'num' && !Number.isFinite(v)) return;
    const su = state.stock.units === 'in' ? MM_PER_INCH : 1;
    if (key === 'originXY' && v === 'custom') {
      const b = stockBox();
      state.stock.ox = +fmt(b.x0 / su); state.stock.oy = +fmt(b.y0 / su);
    }
    if (key === 'originZ' && v === 'custom') state.stock.oz = +fmt(stockBox().z0 / su);
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

  // machine dynamics
  const m = state.machine;
  syncMachine();
  $('mUnits').addEventListener('change', (e) => {
    const next = e.target.value;
    if (next !== m.units) {
      const f = next === 'in' ? 1 / MM_PER_INCH : MM_PER_INCH;
      for (const k of ['rapidXY', 'rapidZ', 'accXY', 'accZ', 'maxFeed', 'homeX', 'homeY', 'homeZ']) m[k] = +fmt(m[k] * f, 3);
    }
    m.units = next;
    syncMachine();
    save();
    reparse(editor.value);
  });
  for (const [id, key, min] of [['mRapidXY', 'rapidXY', 1], ['mRapidZ', 'rapidZ', 1], ['mAccXY', 'accXY', 0], ['mAccZ', 'accZ', 0], ['mToolChange', 'toolChange', 0], ['mMaxFeed', 'maxFeed', 0], ['mMaxRpm', 'maxRpm', 0], ['mHomeX', 'homeX', -Infinity], ['mHomeY', 'homeY', -Infinity], ['mHomeZ', 'homeZ', -Infinity]]) {
    $(id).addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      if (!Number.isFinite(v) || v < min) { syncMachine(); return; }
      m[key] = v;
      save();
      reparse(editor.value);
    });
  }
  $('mDefUnits').addEventListener('change', (e) => { m.defUnits = e.target.value; save(); reparse(editor.value); });
  $('mReset').addEventListener('click', () => { Object.assign(m, MACHINE_DEFAULTS); syncMachine(); save(); reparse(editor.value); });
  const dyn = (open) => {
    state.ui.dyn = open;
    $('dynCard').classList.toggle('open', open);
    $('dynHead').setAttribute('aria-expanded', open);
  };
  dyn(state.ui.dyn);
  $('dynHead').addEventListener('click', () => { dyn(!state.ui.dyn); save(); });

  // display toggles
  const d = state.display;
  const bind = (id, key, fn) => {
    const el = $(id);
    el.checked = d[key];
    el.addEventListener('change', () => { d[key] = el.checked; save(); fn(); });
  };
  const redraw = () => { drawPath(); applyPlayhead(false); };
  bind('dFeeds', 'feeds', redraw);
  bind('dRapids', 'rapids', redraw);
  bind('dDepth', 'depth', () => { if (d.depth) { d.byTool = false; $('dByTool').checked = false; } redraw(); });
  bind('dByTool', 'byTool', () => { if (d.byTool) { d.depth = false; $('dDepth').checked = false; } redraw(); });
  bind('dGrid', 'grid', () => viewer.setGridVisible(d.grid));
  bind('dAxes', 'axes', () => viewer.setAxesVisible(d.axes));
  bind('dTool', 'tool', () => viewer.setToolVisible(d.tool));
  bind('dHolder', 'holder', () => { state.shownTool = null; applyPlayhead(false); });
  bind('dFx', 'fx', () => {});
  bind('dFollow', 'followTool', () => { state.lastToolPos = null; });
  bind('dFollowCode', 'followCode', () => {});

  // panels
  for (const b of document.querySelectorAll('.code-pane .tabs button')) {
    b.addEventListener('click', () => {
      for (const x of document.querySelectorAll('.code-pane .tabs button, .code-pane > .tab')) x.classList.toggle('on', x.dataset.tab === b.dataset.tab);
    });
  }
  $('btnCode').addEventListener('click', () => { setCodePane(!state.ui.code); setTimeout(() => viewer.resize(), 0); });
  for (const tab of document.querySelectorAll('.rail-tab')) {
    tab.addEventListener('click', () => { setRail(tab.dataset.rail, !state.ui[tab.dataset.rail]); save(); });
  }
  const narrow = matchMedia('(max-width: 760px)').matches;
  setRail('railL', narrow ? false : state.ui.railL);
  setRail('railR', narrow ? false : state.ui.railR);
  setCodePane(state.ui.code);

  for (const cb of document.querySelectorAll('.filters input')) {
    cb.addEventListener('change', () => {
      if (cb.checked) state.sevFilter.add(cb.dataset.sev);
      else state.sevFilter.delete(cb.dataset.sev);
      renderIssues();
    });
  }
  $('verdict').addEventListener('click', () => {
    setCodePane(true);
    const pane = $('issuesPane');
    pane.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    pane.classList.remove('flash');
    void pane.offsetWidth;
    pane.classList.add('flash');
  });

  // views
  for (const b of document.querySelectorAll('[data-view]')) {
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
  const speedBtns = document.querySelectorAll('#pbSpeed button');
  const setSpeed = (v) => {
    state.speed = v;
    speedBtns.forEach((b) => b.classList.toggle('on', +b.dataset.speed === v));
  };
  if (![1, 10, 100, 1000].includes(state.speed)) state.speed = 10;
  setSpeed(state.speed);
  speedBtns.forEach((b) => b.addEventListener('click', () => { setSpeed(+b.dataset.speed); save(); }));

  // files and demos
  const demoOpts = DEMOS.map((dm) => `<option value="${dm.id}">${dm.name}</option>`).join('');
  for (const id of ['demoSelect', 'wDemo']) {
    $(id).insertAdjacentHTML('beforeend', demoOpts);
    $(id).addEventListener('change', (e) => { if (e.target.value) loadDemo(e.target.value); e.target.value = ''; });
  }
  $('btnOpen').addEventListener('click', () => $('fileInput').click());
  $('wOpen').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
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
  $('btnPaste').addEventListener('click', pasteFromClipboard);
  $('wPaste').addEventListener('click', pasteFromClipboard);
  $('cvGo').addEventListener('click', convertToRapids);
  $('cvUndo').addEventListener('click', () => {
    if (state.undoText === null) return;
    const t = state.undoText;
    state.undoText = null;
    editor.setText(t);
    reparse(t);
    save();
    $('cvUndo').hidden = true;
    toast('Conversion undone');
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
else loadProgram('', ''); // first visit: show the welcome card
window.ncviewer = { state, viewer, editor }; // handy from the browser console
