// NC Viewer: wires the editor, interpreter, verifier, stock simulation and 3D view.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { detectMachine, MM_PER_INCH, RAPID, FEED, ARC, DRILL, TRAVEL, FM_PER_REV, FM_INVERSE, MACHINES, fmt, describeG } from './gcode.js';
import { TOOL_TYPES, TYPE_FIELDS, FIELD_LABELS, TYPE_LABELS, MACHINE_TOOLS, defaultTool } from './tools.js';
import { formatTime, boxValid, latheKind } from './analyze.js';
import { analyzeText, verifyProgram, stockBox as stockBoxOf, latheStock as latheStockOf } from './pipeline.js';
import { StockSim, LatheSim } from './sim.js';
import { Viewer, MATERIALS, PATH_COLORS, toolColor, depthColor } from './viewer.js';
import { CodeEditor } from './editor.js';
import { buildToolMesh, registerSpecialTools } from './toolmesh.js';
import { initTips, explainIssue, showTip, hideTip, setTip, STOCK_TIPS, STAT_TIPS, FIELD_TIPS } from './tips.js';

// Demo programs are loaded only when one is opened.
const DEMO_LIST = [
  ['bracket', 'mill', 'Bracket plate — 7 tools'], ['peck', 'mill', 'Peck drilling — G83 / G73'], ['pocket', 'mill', 'Circular pocket — helical ramp & arcs'],
  ['macro', 'mill', 'Fanuc macro B — WHILE loop, G65, cutter comp'], ['subs', 'mill', 'Subprograms — 4 parts (M98 / M99)'], ['oword', 'mill', 'LinuxCNC o-word subroutines'],
  ['sign', 'mill', 'Router sign — inch, V-bit'], ['rotary', 'mill', '4th axis — helix wrap & flats (A axis)'],
  ['lathe', 'lathe', 'Lathe shaft — G71/G70, groove, G76 thread, drill'], ['laser', 'laser', 'Laser — engrave & cut (Grbl M4)'], ['printer', 'printer', '3D print — 20 mm cube walls'],
];
export const APP_VERSION = '1.0.0';

const $ = (id) => document.getElementById(id);
const STORE = 'ncviewer:v3';
const SEV_RANK = { error: 3, warning: 2, info: 1 };
const MACHINE_DEFAULTS = {
  kind: 'auto', units: 'mm', rapidXY: 5000, rapidZ: 2000, accXY: 250, accZ: 100, toolChange: 5,
  maxFeed: 10000, maxRpm: 24000, defUnits: 'mm', homeX: 0, homeY: 0, homeZ: 50,
};
const STOCK_DEFAULTS = {
  mill: { shape: 'block', units: 'mm', x: 100, y: 80, z: 12, originXY: 'll', originZ: 'top', ox: 0, oy: 0, oz: -12, material: 'aluminum' },
  lathe: { units: 'mm', x: 50, y: 0, z: 100, originZ: 'top', ox: 0, oy: 0, oz: -100, material: 'steel' },
  laser: { units: 'mm', x: 400, y: 300, z: 3, originXY: 'll', originZ: 'top', ox: 0, oy: 0, oz: -3, material: 'wood' },
  printer: { units: 'mm', x: 220, y: 220, z: 250, originXY: 'll', originZ: 'bottom', ox: 0, oy: 0, oz: 0, material: 'plastic' },
};

const state = {
  stocks: structuredClone(STOCK_DEFAULTS),
  stockView: { show: true, sim: true, res: 300 },
  machine: { ...MACHINE_DEFAULTS },
  display: { colorBy: 'type', feeds: true, rapids: true, tool: true, holder: false, grid: true, axes: true, fx: true, followTool: false, follow: true },
  toolEdits: {},
  fileName: 'program.nc',
  speed: 25,
  // runtime
  mk: 'mill', prog: null, tools: new Map(), toolKeys: new Map(), toolIssues: [], times: null, stats: null, lineIdx: null, issues: [],
  t: 0, playing: false, sim: null, simDone: 0, simT: 0, shownTool: null, lastToolPos: null, undoText: null,
  sevFilter: new Set(['error', 'warning', 'info']),
};
const stock = () => state.stocks[state.mk];

// ------------------------------------------------------------- helpers
const progScale = () => (state.prog?.units === 'in' ? MM_PER_INCH : 1);
const progUnit = () => (state.prog?.units === 'in' ? 'in' : 'mm');
const num = (mm, s = progScale()) => fmt(mm / s, s === 1 ? 3 : 4);
const show = (mm) => `${num(mm)} ${progUnit()}`;
const machScale = () => (state.machine.units === 'in' ? MM_PER_INCH : 1);
const isLathe = () => state.mk === 'lathe';
const isRound = () => state.mk === 'mill' && stock().shape === 'round';

/** Short message at the bottom; optional action button (e.g. Undo). */
function toast(msg, ms = 2600, action = null) {
  const t = $('toast');
  $('toastMsg').textContent = msg;
  const b = $('toastAction');
  b.hidden = !action;
  if (action) {
    b.textContent = action.label;
    b.onclick = () => { t.classList.remove('on'); action.run(); };
  }
  t.classList.add('on');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('on'), action ? Math.max(ms, 8000) : ms);
}

const stockBox = () => stockBoxOf(stock(), state.mk);
const latheStock = () => latheStockOf(state.stocks.lathe);

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
    for (const k of Object.keys(STOCK_DEFAULTS)) Object.assign(state.stocks[k], d.stocks?.[k] || {});
    Object.assign(state.stockView, d.stockView || {});
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
        text: text.length < 2e6 ? text : '', stocks: state.stocks, stockView: state.stockView, machine: state.machine, display: state.display,
        toolEdits: state.toolEdits, speed: state.speed, fileName: state.fileName,
      }));
    } catch { /* storage full or blocked: fine */ }
  }, 400);
}

// ------------------------------------------------------------------ setup
const viewer = new Viewer($('viewport'));
const editor = new CodeEditor($('editor'), {
  onChange: (text) => { state.undoText = null; reparse(text); save(); },
  onCaretLine: (line) => selectLine(line, false),
  onHover: (w, x, y) => hoverWord(w, x, y),
  onHelp: (w) => openReference(w),
});

// ---------------------------------------------------- learning helpers
let refData = null;
const loadRef = () => (refData ??= import('./refdata.js'));
let hoverSeq = 0;
async function hoverWord(w, x, y) {
  const seq = ++hoverSeq;
  if (!w) { hideTip(); return; }
  const ref = await loadRef();
  if (seq !== hoverSeq) return;
  let tip = null;
  if (w.kind === 'comment') tip = { title: 'Comment', text: 'Text in ( ) or after ; is a note for people — the machine ignores it. CAM software puts tool descriptions and operation names here.' };
  else if (w.kind === 'var') tip = { title: w.text, text: w.text.includes('<') ? 'Named variable (LinuxCNC). Names starting with _ are global.' : variableText(+w.text.slice(1)) };
  else if (w.kind === 'keyword') {
    const e = ref.MACRO.find((m) => m[0].split(/[\s/…]+/).includes(w.word));
    tip = { title: w.word, text: e ? `${e[1]}: ${e[2]}` : 'Macro keyword.' };
  } else if (w.kind === 'word') tip = ref.lookupWord(w.letter, w.value ?? NaN, state.mk);
  if (!tip) { hideTip(); return; }
  showTip({ ...tip, foot: 'F1 — open in the G-code reference' }, x, y);
}

function variableText(n) {
  if (n >= 1 && n <= 33) return 'Local variable: belongs to the current macro call (G65 arguments arrive here).';
  if (n >= 100 && n <= 199) return 'Common variable: shared by all programs, cleared at power-off.';
  if (n >= 500 && n <= 999) return 'Permanent variable: kept when the machine is turned off.';
  if (n === 3000) return 'Alarm variable: setting it stops the machine with a message.';
  if (n >= 5001 && n <= 5003) return 'Current position (X, Y, Z).';
  if (n >= 5221 && n <= 5346) return 'Work offset values (G54…).';
  if (n >= 4000 && n < 5000) return 'Modal information (current G codes, F, S, T).';
  return 'Macro variable.';
}

function openReference(w) {
  let hash = '';
  if (w?.kind === 'word' && (w.letter === 'G' || w.letter === 'M') && w.value !== null) hash = `#${w.letter}${+w.value.toFixed(1)}`;
  else if (w?.kind === 'word') hash = `#word-${w.letter}`;
  else if (w?.kind === 'keyword' || w?.kind === 'var') hash = '#macros';
  window.open(`reference.html?m=${state.mk}${hash}`, '_blank', 'noopener');
}

// ------------------------------------------------------------- pipeline
function analysisConfig() {
  const mm = machineMM();
  return {
    defaultUnits: state.machine.defUnits, machineKind: state.machine.kind, home: mm.home, dynamics: mm,
    limits: { maxRpm: mm.maxRpm, maxFeed: mm.maxFeed }, stocks: state.stocks, toolEdits: state.toolEdits,
  };
}

let worker = null;
let jobId = 0;
const jobs = new Map();
function getWorker() {
  if (worker === null) {
    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        const job = jobs.get(e.data.id);
        jobs.delete(e.data.id);
        if (!job) return;
        if (e.data.id !== jobId) { job.resolve(); return; } // a newer edit replaced this one
        if (e.data.error) { console.warn(e.data.error); job.resolve(analyseHere(job.text, job.opts, e.data.id)); return; }
        job.resolve(applyResult(e.data.result, job.text, job.opts, e.data.id));
      };
      worker.onerror = (e) => {
        // the worker could not start (old browser, file:// page…): analyse on the page instead
        e.preventDefault?.();
        worker = false;
        for (const [id, job] of jobs) job.resolve(id === jobId ? analyseHere(job.text, job.opts, id) : undefined);
        jobs.clear();
      };
    } catch { worker = false; }
  }
  return worker || null;
}

/** Analyse the program in a background thread (so the page never freezes) and redraw. */
function reparse(text, opts = {}) {
  const id = ++jobId;
  const w = getWorker();
  if (w) {
    setBusy(true);
    return new Promise((resolve) => {
      jobs.set(id, { text, opts, resolve });
      w.postMessage({ id, text, cfg: analysisConfig() });
    });
  }
  return analyseHere(text, opts, id);
}

function analyseHere(text, opts, id) {
  try {
    return applyResult(analyzeText(text, analysisConfig()), text, opts, id);
  } catch (err) {
    reportError(err);
    setBusy(false);
    return undefined;
  }
}

let busyTimer = 0;
function setBusy(on) {
  clearTimeout(busyTimer);
  if (!on) { document.body.classList.remove('busy'); return; }
  // only show "working" if it takes a moment, to avoid flicker
  busyTimer = setTimeout(() => {
    document.body.classList.add('busy');
    $('progMeta').textContent = 'Working…';
  }, 250);
}

/** Something went wrong: tell the user once, keep the app usable. */
function reportError(err) {
  console.error(err);
  toast('Something went wrong showing this program. The rest of the app still works — try editing or reloading.', 6000);
}

let extrasLoaded = null;
function loadToolExtras() {
  extrasLoaded ??= import('./toolmesh-extra.js').then((m) => registerSpecialTools(m.buildSpecial));
  return extrasLoaded;
}

async function applyResult(r, text, { fitView = false } = {}, id = jobId) {
  if (r.prog.machine !== 'mill') await loadToolExtras(); // lathe / laser / printer tool models
  if (id !== jobId) return; // a newer edit is on its way
  setBusy(false);
  document.title = text.trim() ? `${state.fileName || 'Program'} — NC Viewer` : 'NC Viewer';
  const prog = r.prog;
  state.prog = prog;
  const prevMk = state.mk;
  state.mk = prog.machine;
  state.tools = r.tools;
  state.toolKeys = r.toolKeys;
  state.toolIssues = r.toolIssues;
  state.times = r.times;
  state.stats = r.stats;
  state.lineIdx = r.lineIdx;
  $('nTools').textContent = r.tools.size ? r.tools.size : '';
  if (prevMk !== state.mk) { syncStockInputs(); fitView = true; }
  applyMachineLabels();
  editor.setMachine(prog.machine);
  drawPath();
  viewer.highlight(-1, -1);
  state.shownTool = null;
  state.lastToolPos = null;
  updateScene();
  rebuildStock();
  showIssues(r.geo);
  renderTools();
  renderStats();
  state.playing = false;
  updatePlayButton();
  state.t = state.times.cum[prog.segs.n] || 0;
  applyPlayhead(false);
  const n = prog.segs.n;
  const mkLabel = MACHINES[prog.machine] + (state.machine.kind === 'auto' ? ' (auto)' : '');
  $('progMeta').textContent = n ? `${prog.lineCount.toLocaleString()} lines · ${prog.units} · ${mkLabel} · ${formatTime(state.stats.total)}` : '';
  document.querySelectorAll('.uLen').forEach((e) => { e.textContent = progUnit(); });
  if (fitView) viewer.fit('iso');
}

function drawPath() {
  const d = state.display;
  viewer.setPath(state.prog.segs, { colorBy: d.colorBy, showRapids: d.rapids, showFeeds: d.feeds });
  renderLegend();
}

function reverify() {
  if (!state.prog) return;
  showIssues(verifyProgram(state.prog, state.tools, analysisConfig(), show));
}

function showIssues(geo) {
  const issues = [...state.prog.issues, ...state.toolIssues, ...geo];
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
    const why = explainIssue(is.msg);
    if (why) li.dataset.tip = why;
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
  const s = stock(), sv = state.stockView;
  state.sim = null;
  const prog = state.prog;
  const mat = s.material;
  viewer.chips.setColor(state.mk === 'laser' ? '#ffb347' : (MATERIALS[mat] || MATERIALS.aluminum).cut);
  if (!sv.show) { viewer.clearStock(); renderStockNote(); return; }
  if (isLathe()) {
    const ls = latheStock();
    state.sim = new LatheSim(ls, Math.min(1200, Math.max(200, (+sv.res || 300) * 2)));
    state.sim.lathe = true;
    state.simDone = 0;
    state.simT = 0;
    viewer.setLatheSim(state.sim, mat);
    viewer.addChuck(ls.z0, ls.r);
  } else if (state.mk === 'printer') {
    const b = stockBox();
    viewer.setStockBox({ ...b, z1: b.z0, z0: b.z0 - 2 }, 'plastic');
  } else if (isRound()) {
    viewer.setStockCylinder(stockBox(), mat);
  } else if (sv.sim && !prog?.rotary) {
    state.sim = new StockSim(stockBox(), +sv.res || 300);
    state.simDone = 0;
    state.simT = 0;
    viewer.setStockSim(state.sim, mat);
  } else viewer.setStockBox(stockBox(), mat);
  $('stCustom').classList.toggle('on', s.originXY === 'custom' || s.originZ === 'custom');
  renderStockNote();
}

function renderStockNote() {
  const s = stock();
  const su = s.units === 'in' ? MM_PER_INCH : 1;
  const f = (v) => fmt(v / su, su === 1 ? 2 : 4);
  const st = state.stats;
  let txt;
  if (isLathe()) {
    const l = latheStock();
    txt = `Bar Ø${f(l.r * 2)}${l.rIn ? ` (bore Ø${f(l.rIn * 2)})` : ''}, Z ${f(l.z0)} → ${f(l.z1)} ${s.units}. The chuck is drawn at the back end.`;
    if (st && boxValid(st.cut)) txt += ` Cutting moves span Z ${f(st.cut.min[0])} → ${f(st.cut.max[0])}, down to Ø${f(st.cut.min[2] * 2)}.`;
  } else {
    const b = stockBox();
    txt = isRound() ? `Round bar Ø${f(b.r * 2)} along X ${f(b.x0)} → ${f(b.x1)} ${s.units}, centred on Y0 Z0 (the rotary axis).`
      : `${state.mk === 'printer' ? 'Build volume' : 'Stock'} spans X ${f(b.x0)} → ${f(b.x1)}, Y ${f(b.y0)} → ${f(b.y1)}, Z ${f(b.z0)} → ${f(b.z1)} ${s.units}.`;
    if (st && boxValid(st.cut)) txt += ` ${state.mk === 'printer' ? 'Printing' : 'Cutting'} moves span X ${f(st.cut.min[0])} → ${f(st.cut.max[0])}, Y ${f(st.cut.min[1])} → ${f(st.cut.max[1])}, Z ${f(st.cut.min[2])} → ${f(st.cut.max[2])}.`;
    if (state.prog?.rotary && state.mk === 'mill') txt += ' Rotary moves: material removal is off; the path is shown in the part frame.';
  }
  $('stNote').textContent = txt;
}

function onStockChanged() {
  save();
  if (!state.prog) return;
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
  const s = stock();
  const su = s.units === 'in' ? MM_PER_INCH : 1;
  const r = (v) => (s.units === 'in' ? Math.ceil(v * 20) / 20 : Math.ceil(v));
  const rd = (v) => (s.units === 'in' ? Math.floor(v * 20) / 20 : Math.floor(v));
  if (isLathe()) {
    // cut.min/max are display coords: x = lathe Z, z = radius
    s.x = r((st.all.max[2] * 2) / su);
    s.z = r((Math.max(0, -st.cut.min[0]) + 10) / su);
    s.originZ = 'top';
  } else if (state.mk === 'printer') {
    s.x = Math.max(s.x, r(st.all.max[0] / su));
    s.y = Math.max(s.y, r(st.all.max[1] / su));
    s.z = Math.max(s.z, r(st.all.max[2] / su));
  } else {
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
  }
  syncStockInputs();
  onStockChanged();
  toast('Stock sized to the toolpath');
}

function stockFromComments(text) {
  const head = text.slice(0, 20000);
  const m = /\(([^)]*?\b(?:STOCK|BAR|BILLET)\b[^)]*)\)/i.exec(head) || /;(.*\b(?:STOCK|BAR|BILLET)\b.*)$/im.exec(head);
  if (!m) return false;
  const s = stock();
  const units = state.prog?.units || 'mm';
  if (isLathe()) {
    const d = /(?:DIA(?:METER)?|Ø|D)\s*=?\s*(\d*\.?\d+)[^\d]+(?:L(?:ENGTH)?|X)\s*=?\s*(\d*\.?\d+)/i.exec(m[1]) || /(\d*\.?\d+)\s*(?:DIA|Ø)\s*[X×*]\s*(\d*\.?\d+)/i.exec(m[1]);
    if (!d) return false;
    s.units = units; s.x = +d[1]; s.z = +d[2];
    return true;
  }
  const d = /(\d*\.?\d+)\s*(?:mm|in|")?\s*[X×*]\s*(\d*\.?\d+)\s*(?:mm|in|")?\s*[X×*]\s*(\d*\.?\d+)/i.exec(m[1]);
  if (!d) return false;
  s.units = units;
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

function toolOrient(tl, x) {
  if (!isLathe() || !tl) return 'z';
  return latheKind(tl, x) === 'axial' ? 'axial' : 'z';
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
  const tl = state.tools.get(T);
  const orient = toolOrient(tl, pos[2]);
  const key = `${T}|${orient}|${state.display.holder}`;
  if (state.shownTool !== key) {
    viewer.setTool(tl, { holder: state.display.holder, lathe: isLathe(), orient });
    state.shownTool = key;
  }
  const ax = state.prog.rotary ? [segs.ax[i * 3], segs.ax[i * 3 + 1], segs.ax[i * 3 + 2]] : null;
  viewer.setToolPos(pos, ax);
  if (state.display.followTool && state.lastToolPos) {
    viewer.follow(new THREE.Vector3(pos[0] - state.lastToolPos[0], pos[1] - state.lastToolPos[1], pos[2] - state.lastToolPos[2]));
  }
  state.lastToolPos = pos;
  const rpm = segs.rpm[i];
  viewer.toolSpin = state.playing && rpm && state.mk === 'mill' ? -Math.sign(rpm) * Math.min((Math.abs(rpm) / 60) * Math.PI * 2, 45) : 0;

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
  } else if (segs.type[i] === FEED || segs.type[i] === ARC || segs.type[i] === DRILL) removed = 1;
  if (state.playing && state.display.fx && removed > 0 && tl && state.mk !== 'printer' && (rpm || state.mk === 'laser')) {
    const R = state.mk === 'laser' ? 0.5 : Math.max(tl.dia / 2, 0.5);
    viewer.chips.emit(pos, R, Math.min(12, 3 + Math.round(R)), Math.max(40, R * 25), 1500);
  }

  editor.setActive(segs.line[i], scrollEditor && state.display.follow);
  renderHud(i, pos);
}

function cutSeg(sim, k, frac) {
  const segs = state.prog.segs;
  const tl = state.tools.get(segs.tool[k]);
  if (!tl || !(tl.dia > 0)) return 0;
  const o = k * 6, p = segs.p;
  const x1 = p[o] + (p[o + 3] - p[o]) * frac, y1 = p[o + 1] + (p[o + 4] - p[o + 1]) * frac, z1 = p[o + 2] + (p[o + 5] - p[o + 2]) * frac;
  if (sim.lathe) return sim.cutSeg(p[o + 2], p[o], z1, x1, tl, latheKind(tl, z1));
  if (state.mk === 'laser') {
    const ty = segs.type[k];
    if (ty !== FEED && ty !== ARC) return 0;
    const zb = sim.box.z0 - 1; // laser/plasma cuts through the sheet
    return sim.cutSeg(p[o], p[o + 1], zb, x1, y1, zb, sim.kernel(tl));
  }
  return sim.cutSeg(p[o], p[o + 1], p[o + 2], x1, y1, z1, sim.kernel(tl));
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
  let coords;
  if (isLathe()) coords = `<span><i>X</i>${num(pos[2] * 2)}</span><span><i>Z</i>${num(pos[0])}</span><span class="dim">Ø</span>`;
  else coords = `<span><i>X</i>${num(pos[0])}</span><span><i>Y</i>${num(pos[1])}</span><span><i>Z</i>${num(pos[2])}</span>`;
  const what = ty === TRAVEL ? 'Travel' : ty === RAPID ? 'Rapid' : state.mk === 'printer' ? 'Extrude' : state.mk === 'laser' ? 'Cut' : `G${code} ${describeG(code)}`;
  const spin = state.mk === 'laser' ? (rpm ? `Power S${Math.abs(rpm)}` : 'Beam off') : state.mk === 'printer' ? '' : rpm ? `S${Math.abs(rpm)} ${rpm > 0 ? 'CW' : 'CCW'}` : 'Spindle off';
  $('hud').innerHTML = `
    <div class="xyz">${coords}</div>
    <div class="row"><span>Line ${segs.line[i] + 1}</span><span>${what}</span><span>${feed}</span><span>${spin}</span></div>
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
  if (isLathe()) {
    const l = latheStock();
    b.expandByPoint(new THREE.Vector3(l.z0, -l.r, -l.r));
    b.expandByPoint(new THREE.Vector3(l.z1, l.r, l.r));
  } else if (state.mk !== 'printer' || !b.isEmpty()) {
    const sb = stockBox();
    if (state.mk === 'printer') {
      b.expandByPoint(new THREE.Vector3(sb.x0, sb.y0, sb.z0));
      b.expandByPoint(new THREE.Vector3(sb.x1, sb.y1, sb.z0));
    } else {
      b.expandByPoint(new THREE.Vector3(sb.x0, sb.y0, sb.z0));
      b.expandByPoint(new THREE.Vector3(sb.x1, sb.y1, sb.z1));
    }
  }
  if (b.isEmpty()) b.set(new THREE.Vector3(-50, -50, -10), new THREE.Vector3(50, 50, 10));
  viewer.setScene(b, progScale(), isLathe() ? ['Z', '', 'X'] : ['X', 'Y', 'Z']);
  viewer.setGridVisible(state.display.grid);
  viewer.setAxesVisible(state.display.axes);
}

function renderLegend() {
  const el = $('legend');
  const d = state.display;
  const c = (t) => '#' + PATH_COLORS[t].getHexString();
  if (d.colorBy === 'depth' && viewer.depthRange) {
    const [lo, hi] = viewer.depthRange;
    const g = [0, 0.25, 0.5, 0.75, 1].map((f) => '#' + depthColor(f).getHexString()).join(',');
    el.innerHTML = `<span>Z ${num(hi)}</span><span><i style="width:70px;background:linear-gradient(90deg,${g})"></i></span><span>Z ${num(lo)}</span>`;
  } else if (d.colorBy === 'tool') {
    el.innerHTML = [...state.tools.keys()].filter((t) => state.prog.segs.tool.includes(t))
      .map((t) => `<span><i style="background:${toolColor(t)}"></i>T${t}</span>`).join('');
  } else if (state.mk === 'printer') {
    el.innerHTML = `<span data-tip="G1 moves that push out plastic (E increases)"><i style="background:${c(FEED)}"></i>Extrude</span><span data-tip="G2/G3 arcs that extrude"><i style="background:${c(ARC)}"></i>Arc</span><span data-tip="Moves without extruding — the nozzle travels to the next spot"><i style="background:${c(TRAVEL)}"></i>Travel</span>`;
  } else if (state.mk === 'laser') {
    el.innerHTML = `<span data-tip="Feed moves with the beam on (M3/M4 and S power above 0)"><i style="background:${c(FEED)}"></i>Cut</span><span data-tip="G2/G3 arcs with the beam on"><i style="background:${c(ARC)}"></i>Arc</span><span data-tip="Feed moves with the beam off (S0 or M5)"><i style="background:${c(TRAVEL)}"></i>Beam off</span><span data-tip="G0 rapid moves"><i style="background:${c(RAPID)}"></i>Rapid</span>`;
  } else {
    el.innerHTML = `<span data-tip="G0 — fast moves through the air. Should never touch material."><i style="background:${c(RAPID)}"></i>Rapid</span><span data-tip="G1 — straight cutting moves at feed rate F"><i style="background:${c(FEED)}"></i>Feed</span><span data-tip="G2/G3 — cutting arcs and circles"><i style="background:${c(ARC)}"></i>Arc</span><span data-tip="Moves made by a canned cycle (G81–G89 drilling, tapping; lathe peck/groove cycles)"><i style="background:${c(DRILL)}"></i>Cycle</span>`;
  }
}

// ----------------------------------------------------------------- stats
function renderStats() {
  const prog = state.prog, st = state.stats;
  if (!prog || !prog.segs.n) { $('stats').innerHTML = '<p class="hint">No moves yet.</p>'; return; }
  const u = progUnit();
  const range = (b, k, scale = 1) => (boxValid(b) ? `${num(b.min[k] * scale)} → ${num(b.max[k] * scale)}` : '—');
  let arcs = 0;
  const s = prog.segs;
  for (let i = 0; i < s.n; i++) if (s.type[i] === ARC && (i === 0 || s.type[i - 1] !== ARC || s.line[i - 1] !== s.line[i])) arcs++;
  const rows = [
    ['Machine', MACHINES[prog.machine] + (state.machine.kind === 'auto' ? ' (auto-detected)' : '')],
    ['Units', prog.units === 'in' ? 'Inch (G20)' : 'Millimetre (G21)'],
    ['Lines', prog.lineCount.toLocaleString()],
    ['Moves drawn', s.n.toLocaleString()],
    ['Arc moves', arcs.toLocaleString()],
    ['Tool changes', prog.toolChanges],
    ['Estimated run time', formatTime(st.total) + (state.times.incomplete ? ' (some feeds missing)' : '')],
    [prog.machine === 'printer' ? 'Printing time' : 'Cutting time', formatTime(st.cutTime)],
    [prog.machine === 'printer' || prog.machine === 'laser' ? 'Travel time' : 'Rapid time', formatTime(st.rapidTime)],
    ['Dwell', prog.dwellTotal ? fmt(prog.dwellTotal, 1) + ' s' : '—'],
    [prog.machine === 'printer' ? 'Extrusion path' : 'Cutting distance', `${num(st.cutDist)} ${u}`],
    [prog.machine === 'printer' || prog.machine === 'laser' ? 'Travel distance' : 'Rapid distance', `${num(st.rapidDist)} ${u}`],
  ];
  if (prog.machine === 'printer') rows.push(['Layers', st.layers], ['Filament used', `${fmt(prog.filament / progScale(), 1)} ${u} (${fmt(prog.filament / 1000, 2)} m)`], ['Retractions', prog.retracts]);
  if (prog.features.length) rows.push(['Features', prog.features.map((f) => ({ macro: 'macros', owords: 'o-word subroutines', subprograms: 'subprograms', cutterComp: 'cutter comp', latheCycles: 'lathe cycles', threading: 'threading', css: 'constant surface speed', tcp: '5-axis TCP', '5axis': '5-axis', polar: 'polar coords', rotation: 'rotation', scaling: 'scaling', mirror: 'mirroring', offsets: 'work offsets', spline: 'splines', circlePocket: 'circle pockets' }[f] || f)).join(', ')]);
  if (prog.rotary) rows.push(['Rotary axes', 'yes (A/B/C)']);
  if (isLathe()) rows.push(['Z', range(st.all, 0)], ['X (Ø)', range(st.all, 2, 2)]);
  else rows.push(['X', range(st.all, 0)], ['Y', range(st.all, 1)], ['Z', range(st.all, 2)]);
  const tipAttr = (k) => (STAT_TIPS[k] ? ` data-tip="${STAT_TIPS[k].replace(/"/g, '&quot;')}"` : '');
  let html = `<table class="kv">${rows.map(([k, v]) => `<tr${tipAttr(k)}><th>${k}</th><td>${v}</td></tr>`).join('')}</table>`;
  html += `<h3>Per tool</h3><table class="grid"><tr><th>Tool</th><th>Type</th><th>Ø</th><th>Time</th></tr>`;
  for (const [t, pt] of st.perTool) {
    const tl = state.tools.get(t);
    html += `<tr><td><span class="tchip" style="--c:${toolColor(t)}">T${t}</span></td><td>${tl ? TOOL_TYPES[tl.type].label : '?'}</td><td>${tl ? num(tl.dia) : ''}</td><td>${formatTime(pt.time)}</td></tr>`;
  }
  html += '</table><p class="hint">Times use the program feeds plus the rapid rates, acceleration and tool-change time in Settings.</p>';
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
    const m = buildToolMesh(tool, { holder: TOOL_TYPES[tool.type]?.lathe || tool.type === 'nozzle' || tool.type === 'laser' || tool.type === 'plasma', lathe: isLathe() });
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
  const types = MACHINE_TOOLS[state.mk] || Object.keys(TOOL_TYPES);
  for (const [t, tool] of state.tools) {
    const card = document.createElement('div');
    card.className = 'tool-card';
    const used = state.prog.segs.tool.includes(t);
    const opts = types.includes(tool.type) ? types : [tool.type, ...types];
    card.innerHTML = `
      <img class="thumb" alt="">
      <div class="tc-body">
        <div class="tc-head">
          <span class="tchip" style="--c:${toolColor(t)}">T${t}</span>
          <select class="tc-type" aria-label="T${t} type">${opts.map((k) => `<option value="${k}" ${k === tool.type ? 'selected' : ''}>${TOOL_TYPES[k].label}</option>`).join('')}</select>
          ${used ? '' : '<span class="muted">not used</span>'}
        </div>
        <div class="tc-fields"></div>
        <div class="tc-src"></div>
      </div>`;
    const img = card.querySelector('.thumb');
    img.dataset.tip = `What T${t} looks like. Change the type or sizes and the model, the material simulation and the checks update.`;
    card.querySelector('.tc-type').dataset.tip = 'The kind of tool. It changes the 3D model, the shape it cuts and which checks apply (drills can\'t move sideways, taps need G84…).';
    const fields = card.querySelector('.tc-fields');
    const src = card.querySelector('.tc-src');
    const draw = () => {
      const cur = state.tools.get(t);
      fields.innerHTML = '';
      for (const f of TYPE_FIELDS[cur.type]) {
        const lab = document.createElement('label');
        const isLen = !['angle', 'flutes'].includes(f);
        lab.textContent = (TYPE_LABELS[cur.type]?.[f] || FIELD_LABELS[f]) + (isLen ? ` (${progUnit()})` : '');
        if (FIELD_TIPS[f]) lab.dataset.tip = FIELD_TIPS[f];
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
          afterToolsChanged(true);
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
  afterToolsChanged(false);
}

let toolTimer = 0;
function afterToolsChanged(rebuildList) {
  clearTimeout(toolTimer);
  toolTimer = setTimeout(() => {
    if (state.prog.usesComp || rebuildList) { reparse(editor.value); return; } // compensation depends on tool sizes
    state.shownTool = null;
    rebuildStock();
    reverify();
    renderStats();
    applyPlayhead(false);
  }, 150);
}

// ------------------------------------------------- convert air moves to G0
async function convertToRapids() {
  const prog = state.prog;
  if (!prog?.segs.n) return;
  if (state.mk !== 'mill') { toast('Converting air moves works on mill / router programs'); return; }
  const dlg = $('cvDialog');
  $('cvZ').value = '';
  dlg.showModal();
  const ok = await new Promise((res) => dlg.addEventListener('close', () => res(dlg.returnValue === 'ok'), { once: true }));
  if (!ok) return;
  let zMin = parseFloat($('cvZ').value);
  zMin = Number.isFinite(zMin) ? zMin * progScale() : stockBox().z1 + 0.5;
  const segs = prog.segs;
  const lineOk = new Map();
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
    if (lineOk.get(li) && !/[#\[]/.test(codeOf(raw))) {
      if (/\bG\s*0*1(?![\d.])/i.test(codeOf(raw))) lines[li] = raw.replace(/\bG(\s*)0*1(?![\d.])/i, 'G$10');
      else lines[li] = 'G0 ' + raw.replace(/^\s+/, '');
      count++;
      pendingG1 = true;
    } else if (pendingG1 && (isMotion(raw) || motionG(raw))) {
      if (!motionG(raw)) lines[li] = 'G1 ' + raw.replace(/^\s+/, '');
      pendingG1 = false;
    }
  }
  if (!count) { toast(`No feed moves stay above Z${num(zMin)} — nothing to convert`); return; }
  const before = state.stats.total;
  state.undoText = editor.value;
  const text = lines.join('\n');
  editor.setText(text);
  await reparse(text);
  save();
  toast(`Converted ${count} air move${count > 1 ? 's' : ''} above Z${num(zMin)} to G0 — saves ${formatTime(before - state.stats.total)}`, 8000, {
    label: 'Undo',
    run: () => {
      if (state.undoText === null) return;
      const t = state.undoText;
      state.undoText = null;
      editor.setText(t);
      reparse(t);
      save();
      toast('Conversion undone');
    },
  });
}

// ------------------------------------------------------------ loading
function loadProgram(text, name, { fromFile = false } = {}) {
  if (name) state.fileName = name;
  state.undoText = null;
  editor.setText(text);
  state.mk = state.machine.kind === 'auto' ? detectMachine(text) : state.machine.kind;
  if (fromFile && stockFromComments(text)) toast(`Stock size read from the program`, 3500);
  syncStockInputs();
  save();
  return reparse(text, { fitView: true });
}

async function loadDemo(id) {
  const { DEMOS } = await import('./demos.js');
  const d = DEMOS.find((x) => x.id === id);
  if (!d) return;
  if (state.machine.kind !== 'auto' && state.machine.kind !== d.machine) {
    state.machine.kind = 'auto';
    $('mMachine').value = 'auto';
  }
  Object.assign(state.stocks[d.machine], d.stock);
  state.stockView.sim = true;
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

// --------------------------------------------------------------- inputs
const LABELS = {
  mill: { X: 'Length (X)', Y: 'Width (Y)', Z: 'Thickness (Z)', OXY: 'Program zero (X/Y) is at the stock\'s', OZ: 'Program zero (Z) is at the', show: 'Show stock', z: ['Top of the stock', 'Bottom of the stock'] },
  round: { X: 'Length (X)', Y: 'Diameter', Z: '', OXY: 'Program zero (X) is at the bar\'s', OZ: '', show: 'Show stock' },
  lathe: { X: 'Bar diameter', Y: 'Bore Ø (0 = solid)', Z: 'Length (Z)', OXY: '', OZ: 'Z0 is at the', show: 'Show bar & chuck', z: ['Face of the bar', 'Back of the bar (chuck end)'] },
  laser: { X: 'Sheet X', Y: 'Sheet Y', Z: 'Thickness', OXY: 'Program zero (X/Y) is at the sheet\'s', OZ: 'Program zero (Z) is at the', show: 'Show sheet', z: ['Top of the sheet', 'Bottom of the sheet'] },
  printer: { X: 'Bed X', Y: 'Bed Y', Z: 'Max height', OXY: 'Program zero (X/Y) is at the bed\'s', OZ: 'Z0 is at the', show: 'Show bed', z: ['Top of the volume', 'Bed surface'] },
};

function applyMachineLabels() {
  const key = isRound() ? 'round' : state.mk;
  const L = LABELS[key];
  $('lbX').textContent = L.X;
  $('lbY').textContent = L.Y;
  $('lbZ').textContent = L.Z;
  $('lbOXY').textContent = L.OXY;
  $('lbOZ').textContent = L.OZ;
  $('lbShow').textContent = L.show;
  if (L.z) { $('stOriginZ').options[0].textContent = L.z[0]; $('stOriginZ').options[1].textContent = L.z[1]; }
  const hide = (el, on) => { el.dataset.hidden = on ? '1' : '0'; };
  document.querySelectorAll('[data-for="mill"]').forEach((el) => hide(el, state.mk !== 'mill'));
  document.querySelectorAll('[data-hide]').forEach((el) => {
    const h = el.dataset.hide;
    hide(el, (h === 'lathe' && isLathe()) || (h === 'printer' && state.mk === 'printer') || (h === 'round' && key === 'round' && el.querySelector('#stY') === null) || (h === 'roundOnly' && key === 'round'));
  });
  $('customHint').textContent = isLathe() ? 'Where the back end of the bar sits along Z, measured from program zero.' : 'Where the stock\'s lower-left-bottom corner sits, measured from program zero.';
  $('lbOXw').dataset.hidden = isLathe() ? '1' : '0';
  $('lbOYw').dataset.hidden = isLathe() ? '1' : '0';
  $('btnConvert').disabled = state.mk !== 'mill';
  const st = STOCK_TIPS[key] || STOCK_TIPS.mill;
  for (const [id, text] of Object.entries(st)) setTip(id, text);
}

function syncStockInputs() {
  const s = stock(), sv = state.stockView;
  $('stShape').value = s.shape || 'block';
  $('stUnits').value = s.units;
  $('stMaterial').value = s.material;
  $('stX').value = s.x; $('stY').value = s.y; $('stZ').value = s.z;
  $('stOriginXY').value = s.originXY || 'll';
  $('stOriginZ').value = s.originZ;
  $('stOX').value = s.ox; $('stOY').value = s.oy; $('stOZ').value = s.oz;
  $('stShow').checked = sv.show;
  $('stSim').checked = sv.sim;
  $('stRes').value = String(sv.res);
  $('mMachine').value = state.machine.kind;
  applyMachineLabels();
}

function syncMachine() {
  const m = state.machine;
  const ids = { mUnits: 'units', mRapidXY: 'rapidXY', mRapidZ: 'rapidZ', mAccXY: 'accXY', mAccZ: 'accZ', mToolChange: 'toolChange', mMaxRpm: 'maxRpm', mMaxFeed: 'maxFeed', mDefUnits: 'defUnits', mHomeX: 'homeX', mHomeY: 'homeY', mHomeZ: 'homeZ', mMachine: 'kind' };
  for (const [id, k] of Object.entries(ids)) $(id).value = m[k];
}

function initInputs() {
  $('stMaterial').innerHTML = Object.entries(MATERIALS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  syncStockInputs();
  const bindStock = (id, key, kind = 'str') => $(id).addEventListener('change', (e) => {
    const el = e.target;
    const v = kind === 'bool' ? el.checked : kind === 'num' ? parseFloat(el.value) : el.value;
    if (kind === 'num' && !Number.isFinite(v)) return;
    const s = stock();
    const su = s.units === 'in' ? MM_PER_INCH : 1;
    if (key === 'originXY' && v === 'custom') {
      const b = stockBox();
      s.ox = +fmt(b.x0 / su); s.oy = +fmt(b.y0 / su);
    }
    if (key === 'originZ' && v === 'custom') s.oz = +fmt((isLathe() ? latheStock().z0 : stockBox().z0) / su);
    if (key === 'units' && v !== s.units) {
      const f = v === 'in' ? 1 / MM_PER_INCH : MM_PER_INCH;
      for (const k of ['x', 'y', 'z', 'ox', 'oy', 'oz']) s[k] = +fmt(s[k] * f, 4);
    }
    if (key === 'show' || key === 'sim') state.stockView[key] = v;
    else if (key === 'res') state.stockView.res = +v;
    else s[key] = v;
    syncStockInputs();
    onStockChanged();
  });
  bindStock('stShape', 'shape');
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
  $('mMachine').addEventListener('change', (e) => { state.machine.kind = e.target.value; save(); reparse(editor.value, { fitView: true }); });

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
  $('mReset').addEventListener('click', () => { const kind = m.kind; Object.assign(m, MACHINE_DEFAULTS, { kind }); syncMachine(); save(); reparse(editor.value); });

  // display
  const d = state.display;
  const bindDisp = (id, key, fn) => {
    const el = $(id);
    if (el.type === 'checkbox') el.checked = d[key];
    else el.value = d[key];
    el.addEventListener('change', () => { d[key] = el.type === 'checkbox' ? el.checked : el.value; save(); fn(); });
  };
  const redrawPath = () => { drawPath(); applyPlayhead(false); };
  bindDisp('dColor', 'colorBy', redrawPath);
  bindDisp('dFeeds', 'feeds', redrawPath);
  bindDisp('dRapids', 'rapids', redrawPath);
  bindDisp('dTool', 'tool', () => viewer.setToolVisible(d.tool));
  bindDisp('dHolder', 'holder', () => { state.shownTool = null; applyPlayhead(false); });
  bindDisp('dGrid', 'grid', () => viewer.setGridVisible(d.grid));
  bindDisp('dAxes', 'axes', () => viewer.setAxesVisible(d.axes));
  bindDisp('dFx', 'fx', () => {});
  bindDisp('dFollowTool', 'followTool', () => { state.lastToolPos = null; });
  bindDisp('dFollow', 'follow', () => {});

  // tabs
  for (const b of document.querySelectorAll('.tabs button')) {
    b.addEventListener('click', () => {
      for (const x of document.querySelectorAll('.tabs button, .tab')) x.classList.toggle('on', x.dataset.tab === b.dataset.tab);
      for (const x of document.querySelectorAll('.tabs button')) x.setAttribute('aria-selected', x === b);
    });
  }
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
    e.target.textContent = ortho ? 'Switch to perspective' : 'Switch to orthographic';
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
  const groups = {};
  for (const [id, machine, name] of DEMO_LIST) (groups[MACHINES[machine]] ||= []).push({ id, name });
  $('demoSelect').insertAdjacentHTML('beforeend', Object.entries(groups).map(([g, list]) => `<optgroup label="${g}">${list.map((dm) => `<option value="${dm.id}">${dm.name}</option>`).join('')}</optgroup>`).join(''));
  $('demoSelect').addEventListener('change', (e) => { if (e.target.value) loadDemo(e.target.value); e.target.value = ''; });
  $('btnClear').addEventListener('click', () => {
    if (editor.value.trim() && !confirm('Clear the program?')) return;
    loadProgram('', 'program.nc');
    editor.ta.focus();
  });
  $('btnSave').addEventListener('click', saveFile);
  function saveFile() {
    const blob = new Blob([editor.value], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = state.fileName || 'program.nc';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
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
  $('btnConvert').addEventListener('click', convertToRapids);
  initMenus();
  const qs = $('quickstart');
  const showQs = (on) => { qs.hidden = !on; };
  $('qsClose').addEventListener('click', () => { showQs(false); try { localStorage.setItem('ncviewer:qs', '1'); } catch { /* fine */ } });
  $('btnTour').addEventListener('click', () => showQs(true));
  try { if (!localStorage.getItem('ncviewer:qs')) showQs(true); } catch { showQs(true); }
  $('appVersion').textContent = APP_VERSION;

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
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveFile(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); $('fileInput').click(); return; }
    const tag = e.target.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || e.target.isContentEditable || e.ctrlKey || e.metaKey || e.altKey) return;
    if (tag === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return; // let buttons work
    if (e.key === ' ') { e.preventDefault(); play(!state.playing); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stepLine(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); stepLine(-1); }
    else if (e.key === 'Home') { play(false); setT(0); applyPlayhead(true); }
    else if (e.key === 'End') { play(false); setT(Infinity); applyPlayhead(true); }
  });
}

/** Small dropdown menus (⋯ buttons). */
function initMenus() {
  const close = (m) => { m.querySelector('.menu-list').hidden = true; m.querySelector('.menu-btn').setAttribute('aria-expanded', 'false'); };
  for (const m of document.querySelectorAll('.menu')) {
    const btn = m.querySelector('.menu-btn'), list = m.querySelector('.menu-list');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = list.hidden;
      document.querySelectorAll('.menu').forEach(close);
      list.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      if (open) list.querySelector('button:not([disabled])')?.focus();
    });
    list.addEventListener('click', () => close(m));
    list.addEventListener('keydown', (e) => {
      const items = [...list.querySelectorAll('button:not([disabled])')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
      else if (e.key === 'Escape') { close(m); btn.focus(); }
    });
  }
  document.addEventListener('click', () => document.querySelectorAll('.menu').forEach(close));
}

// ------------------------------------------------------------------- go
window.addEventListener('error', (e) => { if (e.error) reportError(e.error); });
window.addEventListener('unhandledrejection', (e) => reportError(e.reason));
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  // works offline after the first visit (handy in a shop with bad Wi-Fi)
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
const saved = load();
initInputs();
initTips();
if (saved && saved.trim()) loadProgram(saved, state.fileName);
else loadDemo('bracket');
window.ncviewer = { state, viewer, editor }; // handy from the browser console
