// G-code interpreter for mills/routers (3–5 axis), lathes, lasers/plasma and
// 3D printers. Handles Fanuc/Haas macro B (#vars, IF/GOTO/WHILE, G65),
// LinuxCNC o-words, M98/M97/M99 subprograms, cutter compensation, work
// offsets, rotation/scaling/mirroring, polar coordinates, canned cycles
// (mill and lathe) and rotary axes. Pure JavaScript (no DOM).
//
// Output points are millimetres in the display frame:
//   mill/laser/printer: work coordinates (part frame when rotary axes move)
//   lathe:              x = lathe Z, y = 0, z = lathe X (radius)

import { parseLine, evaluate } from './expr.js';

export const MM_PER_INCH = 25.4;

// Segment types
export const RAPID = 0;
export const FEED = 1; // cutting / extruding move
export const ARC = 2;
export const DRILL = 3; // feed move inside a canned cycle
export const TRAVEL = 4; // non-cutting move at feed rate (laser off, printer travel)

// Feed modes
export const FM_PER_MIN = 0;
export const FM_PER_REV = 1;
export const FM_INVERSE = 2;

export const MACHINES = { mill: 'Mill / router', lathe: 'Lathe', laser: 'Laser / plasma', printer: '3D printer' };

const key = (v) => Math.round(v * 10) / 10;
const D2R = Math.PI / 180;

// ---------------------------------------------------------------- G groups
const G_GROUP = new Map();
const group = (name, codes) => codes.forEach((c) => G_GROUP.set(c, name));
group('motion', [0, 1, 2, 3, 5, 5.1, 12, 13, 33.1, 38.2, 38.3, 38.4, 38.5, 73, 74, 76, 80, 81, 82, 83, 84, 84.2, 84.3, 85, 86, 87, 88, 89]);
group('plane', [17, 18, 19]);
group('distance', [90, 91]);
group('arcDistance', [90.1, 91.1]);
group('feedMode', [93, 94, 95]);
group('units', [20, 21]);
group('comp', [40, 41, 42, 41.1, 42.1]);
group('length', [43, 43.1, 43.4, 43.5, 44, 49, 234]);
group('retract', [98, 99]);
group('wcs', [54, 55, 56, 57, 58, 59, 54.1, 59.1, 59.2, 59.3]);
group('nonModal', [4, 10, 28, 28.1, 30, 30.1, 52, 53, 65, 92, 92.1, 92.2, 92.3]);
group('spindleMode', [96, 97]);
group('scale', [50, 51]);
group('mirror', [50.1, 51.1]);
group('rotation', [68, 69, 68.2]);
group('polar', [15, 16]);
group('diameter', [7, 8]);
group('macroModal', [66, 67]);
group('pathMode', [61, 61.1, 64]); // exact stop / blending: no effect on the drawn path

const IGNORED_G = new Set([5.4, 8, 5.2, 5.3, 7.1, 9, 11, 15.1, 16.1, 29, 31, 47, 100, 103, 107, 110, 150, 154, 187]);
const CYCLES = new Set([73, 74, 76, 81, 82, 83, 84, 84.2, 84.3, 85, 86, 87, 88, 89]);
const CYCLE_NEEDS_Q = new Set([73, 83]);

const M_GROUP = new Map([
  [0, 'stop'], [1, 'stop'], [2, 'stop'], [30, 'stop'], [60, 'stop'],
  [3, 'spindle'], [4, 'spindle'], [5, 'spindle'], [13, 'spindle'], [14, 'spindle'],
  [6, 'toolChange'],
]);
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const KNOWN_M = {
  mill: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 19, 29, 30, 48, 49, 50, 51, 52, 53, ...range(59, 79), 82, 83, 84, 86, 88, 95, 97, 98, 99, ...range(100, 115)],
  lathe: [0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 19, 21, 22, 23, 24, 30, 31, 33, 36, 37, 38, 39, 40, 41, 42, 43, 44, 51, 52, 59, 68, 69, 76, 77, 78, 79, 85, 86, 88, 89, 97, 98, 99, 133, 134, 135, 143, 144, 145, 154, 155],
  laser: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 30, 62, 63, 64, 65, 66, 67, 68, 106, 107, 111, 114, 115, 117, 220, 221, 400],
  printer: [0, 1, 17, 18, 20, 21, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 42, 73, 75, 76, 80, 81, 82, 83, 84, 85, 92, ...range(104, 121), 140, 141, 145, 149, 150, 155, 190, 191, ...range(200, 221), 280, 290, ...range(300, 304), ...range(400, 428), 486, ...range(500, 504), 540, 552, 553, 554, 555, 562, 563, 569, 575, 593, 600, 601, 603, 851, 852, 862, 900, ...range(906, 917), 928, 951, 997, 999],
};

const G_DESCRIPTIONS = {
  0: 'Rapid', 1: 'Linear feed', 2: 'Arc CW', 3: 'Arc CCW', 5: 'Spline', 12: 'Circle pocket CW', 13: 'Circle pocket CCW',
  33: 'Threading', 70: 'Finish cycle', 71: 'Rough turning', 72: 'Rough facing', 73: 'Peck / pattern repeat',
  74: 'Left-hand tap / face peck', 75: 'Grooving', 76: 'Fine bore / threading', 81: 'Drill', 82: 'Spot drill (dwell)', 83: 'Peck drill',
  84: 'Tap', 85: 'Bore (feed out)', 86: 'Bore (rapid out)', 87: 'Back bore', 88: 'Bore (manual out)', 89: 'Bore (dwell, feed out)',
  90: 'Turning cycle', 92: 'Thread cycle', 94: 'Facing cycle',
};
export const describeG = (c) => G_DESCRIPTIONS[c] || `G${c}`;

// ------------------------------------------------------------ segment store
const FIELDS = ['type', 'code', 'line', 'tool', 'feed', 'fmode', 'rpm', 'dwell'];
class SegBuf {
  constructor(cap = 4096) {
    this.n = 0;
    this.grow(cap);
  }
  grow(cap) {
    const old = this;
    const next = {
      p: new Float64Array(cap * 6), ax: new Float32Array(cap * 3), type: new Uint8Array(cap), code: new Uint8Array(cap),
      line: new Int32Array(cap), tool: new Int32Array(cap), feed: new Float32Array(cap),
      fmode: new Uint8Array(cap), rpm: new Float32Array(cap), dwell: new Float32Array(cap),
    };
    if (old.p) {
      next.p.set(old.p.subarray(0, old.n * 6));
      next.ax.set(old.ax.subarray(0, old.n * 3));
      for (const k of FIELDS) next[k].set(old[k].subarray(0, old.n));
    }
    Object.assign(this, next);
    this.cap = cap;
  }
  push(a, b, axis, type, code, line, tool, feed, fmode, rpm, dwell) {
    if (this.n === this.cap) this.grow(this.cap * 2);
    const i = this.n++;
    const o = i * 6;
    this.p[o] = a[0]; this.p[o + 1] = a[1]; this.p[o + 2] = a[2];
    this.p[o + 3] = b[0]; this.p[o + 4] = b[1]; this.p[o + 5] = b[2];
    this.ax[i * 3] = axis[0]; this.ax[i * 3 + 1] = axis[1]; this.ax[i * 3 + 2] = axis[2];
    this.type[i] = type; this.code[i] = Math.min(255, Math.round(code)); this.line[i] = line; this.tool[i] = tool;
    this.feed[i] = feed; this.fmode[i] = fmode; this.rpm[i] = rpm; this.dwell[i] = dwell;
  }
  done() {
    const n = this.n;
    const out = { n, p: this.p.slice(0, n * 6), ax: this.ax.slice(0, n * 3) };
    for (const k of FIELDS) out[k] = this[k].slice(0, n);
    return out;
  }
}

/** Tokenise one line (plain numbers only; kept for tests and tools). */
export function tokenizeLine(s) {
  const r = parseLine(s);
  const words = r.n !== null ? [{ l: 'N', v: r.n, raw: String(r.n) }] : [];
  for (const w of r.words) if (w.e.k === 'num') words.push({ l: w.l, v: w.e.v, raw: w.raw });
  return { words, comments: r.comments, errors: r.errors, macro: r.assigns.length > 0 || !!r.ctl || r.words.some((w) => w.e.k !== 'num'), blockDelete: r.blockDelete };
}

// ------------------------------------------------------ machine detection
/** Guess the machine a program was written for. */
export function detectMachine(text) {
  const head = text.slice(0, 400000);
  const code = head.replace(/\([^)\n]*\)|;[^\n]*/g, '');
  const extrude = (code.match(/^\s*G[01]\b[^\n]*\bE-?\d*\.?\d/gim) || []).length;
  if (extrude >= 3 || /^\s*M1(?:04|09|40|90)\b/im.test(code)) return 'printer';
  const latheCycle = /\bG7[0-3]\b[^\n]*\bP\d+[^\n]*\bQ\d+/i.test(code) || /\bG76\b[^\n]*\bX[^\n]*\bZ[^\n]*\bP\d/i.test(code);
  const latheT = /\bT\d{4}\b/.test(code);
  const hasY = /\bY\s*[-+.\d#[]/i.test(code);
  const uw = /(?:^|[^A-Z])[UW]\s*-?\d/im.test(code);
  if (latheCycle || (!hasY && /\bX/i.test(code) && /\bZ/i.test(code) && (latheT || uw || /\bG9[69]\b|\bG50\s*S|\bG7\b|\bG99\b/i.test(code)))) return 'lathe';
  if (/\b(laser|lightburn|plasma|torch|kerf)\b/i.test(head)) return 'laser';
  const hasZ = /\bZ\s*[-+.\d#[]/i.test(code);
  if (!hasZ && /\bM[34]\b/i.test(code) && /\bS\d/i.test(code) && !/\bT\d/i.test(code)) return 'laser';
  return 'mill';
}

// ------------------------------------------------------------------ parser
/**
 * Parse (interpret) a G-code program.
 * @param {string} text
 * @param {{defaultUnits?: 'mm'|'in', machine?: string, home?: number[], arcTolerance?: number,
 *   toolDia?: (t:number)=>number|undefined, maxLines?: number}} opts
 */
export function parseGcode(text, opts = {}) {
  const lines = text.split(/\r\n|\n|\r/);
  const machine = !opts.machine || opts.machine === 'auto' ? detectMachine(text) : opts.machine;
  const isLathe = machine === 'lathe', isPrinter = machine === 'printer', isLaser = machine === 'laser';
  const issues = [];
  const onceKeys = new Set();
  const add = (line, sev, msg) => issues.push({ line, sev, msg });
  const addOnce = (k, line, sev, msg) => { if (!onceKeys.has(k)) { onceKeys.add(k); add(line, sev, msg); } };
  const knownM = new Set(KNOWN_M[machine]);

  const segs = new SegBuf();
  const toolHints = new Map();
  const toolOrder = [];
  const noteTool = (t) => { if (!toolOrder.includes(t)) toolOrder.push(t); };
  const arcTol = opts.arcTolerance ?? 0.005;
  const features = new Set();

  const st = {
    motion: null, motionLine: -1, plane: isLathe ? 18 : 17, abs: true, arcAbs: false,
    feedMode: isLathe ? FM_PER_REV : FM_PER_MIN, units: null, scale: opts.defaultUnits === 'in' ? MM_PER_INCH : 1,
    comp: 40, retract: 98, diam: true,
    phys: isLaser || isPrinter ? [0, 0, 0] : [null, null, null], rot: [0, 0, 0], tcp: false,
    wcs: 54, wcsOff: new Map(), g52: [0, 0, 0], g92: [0, 0, 0],
    sc: [1, 1, 1], scC: [0, 0, 0], rotAng: 0, rotC: [0, 0], polar: false,
    feed: 0, rpm: 0, sSet: false, dir: 0, css: null, maxRpm: 0,
    tool: 0, next: null,
    cyc: { R: null, Z: null, Q: null, P: 0, initZ: null, incR: null, incZ: null },
    lcyc: null, lc: {},
    E: 0, eRel: false, hot: null, bed: null, lastCtl: null,
    ended: false,
  };
  let A = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], Ainv = A, b0 = [0, 0, 0], diag = true;
  let toolChanges = 0, dwellPending = 0, dwellTotal = 0, filament = 0, retracts = 0;
  let usedG43 = false, g43SinceChange = true;
  const missingG43 = [];
  let lastToolChangeLine = -10, firstMotionLine = -1, endLine = -1, lastCodeLine = 0;
  let rotaryUsed = false, usesComp = false;
  const wcsUsed = new Set();

  // ---------------------------------------------------------- labels / subs
  const cache = new Array(lines.length);
  const P = (li) => cache[li] || (cache[li] = parseLine(lines[li] || ''));
  const labels = new Map();
  const progs = new Map();
  const ostruct = new Map();
  let mainNumber = null;
  let codeSeen = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const m = /^\s*\/?\s*N\s*(\d+)/i.exec(l);
    if (m && !labels.has(+m[1])) labels.set(+m[1], i);
    const o = /^\s*(?:N\d+\s*)?([oO:])\s*(\d+|<[^>]*>)\s*([A-Za-z]*)/.exec(l);
    if (o) {
      const kw = o[3].toLowerCase();
      const id = o[2].startsWith('<') ? o[2].slice(1, -1).replace(/\s+/g, '').toLowerCase() : String(+o[2]);
      if (o[1] !== ':' && /^(sub|endsub|call|if|elseif|else|endif|while|endwhile|do|repeat|endrepeat|break|continue|return)$/.test(kw)) {
        if (!ostruct.has(id)) ostruct.set(id, []);
        ostruct.get(id).push({ line: i, kw });
      } else if (!o[2].startsWith('<')) {
        if (!progs.has(+o[2])) progs.set(+o[2], i);
        if (mainNumber === null && !codeSeen) mainNumber = +o[2];
      }
    } else if (/^\s*[A-NP-Z#]/i.test(l.replace(/\(.*?\)|;.*$/g, ''))) codeSeen = true;
  }
  const oAfter = (id, from, kws) => (ostruct.get(id) || []).find((e) => e.line > from && kws.includes(e.kw));
  const oBefore = (id, from, kws) => [...(ostruct.get(id) || [])].reverse().find((e) => e.line < from && kws.includes(e.kw));

  // ------------------------------------------------------------ variables
  const globals = new Map();
  const gnames = new Map();
  const frames = [{ kind: 'main', locals: new Map(), names: new Map() }];
  const top = () => frames[frames.length - 1];
  const progVal = (k) => {
    const p = progPos()[k];
    return p === null ? null : (isLathe && k === 0 && st.diam ? 2 * p : p) / st.scale;
  };
  const vars = {
    get(n) {
      if (n === 0) return null;
      if (n >= 1 && n <= 33) return top().locals.has(n) ? top().locals.get(n) : null;
      if (n >= 4000 && n < 5000) {
        const map = { 4001: st.motion, 4002: st.plane, 4003: st.abs ? 90 : 91, 4005: [94, 95, 93][st.feedMode], 4006: st.units === 'in' ? 20 : 21, 4007: st.comp, 4014: st.wcs, 4109: st.feed / st.scale, 4119: st.rpm, 4120: st.tool };
        return map[n] ?? null;
      }
      for (const base of [5001, 5021, 5041, 5061, 5420]) if (n >= base && n < base + 3) return progVal(n - base);
      if (n >= 5221 && n <= 5346) {
        const idx = Math.floor((n - 5221) / 20), ax = (n - 5221) % 20;
        const off = st.wcsOff.get(54 + idx);
        return off && ax < 3 ? off[ax] / st.scale : 0;
      }
      if (n === 3001 || n === 3002) return 0;
      return globals.has(n) ? globals.get(n) : null;
    },
    getName(n) {
      const sys = { _x: () => progVal(0), _y: () => progVal(1), _z: () => progVal(2), _metric: () => (st.units === 'in' ? 0 : 1), _imperial: () => (st.units === 'in' ? 1 : 0), _absolute: () => (st.abs ? 1 : 0), _incremental: () => (st.abs ? 0 : 1), _feed: () => st.feed / st.scale, _rpm: () => st.rpm, _current_tool: () => st.tool, _selected_tool: () => st.next ?? st.tool };
      if (sys[n]) return sys[n]();
      if (n.startsWith('_')) return gnames.has(n) ? gnames.get(n) : null;
      return top().names.has(n) ? top().names.get(n) : gnames.has(n) ? gnames.get(n) : null;
    },
  };
  const setVar = (target, v, li, comment) => {
    if (target.k === 'name') {
      if (target.n.startsWith('_')) gnames.set(target.n, v);
      else top().names.set(target.n, v);
      return true;
    }
    const n = Math.round(evaluate(target.idx, vars) ?? -1);
    if (n === 3000) { add(li, 'error', `Macro alarm #3000=${v}${comment ? `: ${comment}` : ''} — the control stops here`); return false; }
    if (n === 3006) { add(li, 'info', `Program stop with message${comment ? `: ${comment}` : ''}`); return true; }
    if (n >= 1 && n <= 33) top().locals.set(n, v);
    else if (n >= 100) globals.set(n, v);
    else add(li, 'error', `Variable #${n} can't be written`);
    return true;
  };
  const ev = (node, li) => {
    const v = evaluate(node, vars);
    if (v !== null && !Number.isFinite(v)) { add(li, 'error', 'Expression result is not a number (divide by zero or bad function input)'); return null; }
    return v;
  };

  // ------------------------------------------------------------ transforms
  function updXf() {
    const s = st.sc, c = Math.cos(st.rotAng * D2R), sn = Math.sin(st.rotAng * D2R);
    A = [[c * s[0], -sn * s[1], 0], [sn * s[0], c * s[1], 0], [0, 0, s[2]]];
    const det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
    Ainv = [[A[1][1] / det, -A[0][1] / det, 0], [-A[1][0] / det, A[0][0] / det, 0], [0, 0, 1 / s[2]]];
    diag = Math.abs(sn) < 1e-12;
    const q = [st.scC[0] - s[0] * st.scC[0] - st.rotC[0], st.scC[1] - s[1] * st.scC[1] - st.rotC[1]];
    b0 = [c * q[0] - sn * q[1] + st.rotC[0], sn * q[0] + c * q[1] + st.rotC[1], st.scC[2] - s[2] * st.scC[2]];
  }
  const offs = () => {
    const base = st.wcsOff.get(54) || [0, 0, 0];
    const cur = st.wcsOff.get(st.wcs) || base;
    return [0, 1, 2].map((k) => cur[k] - base[k] + st.g52[k] + st.g92[k]);
  };
  function xf(p) {
    const o = offs();
    if (diag) return [0, 1, 2].map((k) => (p[k] === null ? null : A[k][k] * p[k] + b0[k] + o[k]));
    if (p[0] === null || p[1] === null) return [null, null, p[2] === null ? null : A[2][2] * p[2] + b0[2] + o[2]];
    return [0, 1, 2].map((k) => (k < 2 ? A[k][0] * p[0] + A[k][1] * p[1] : A[2][2] * p[2]) + b0[k] + o[k]);
  }
  function progPos() {
    const o = offs();
    const q = st.phys.map((v, k) => (v === null ? null : v - b0[k] - o[k]));
    if (diag) return q.map((v, k) => (v === null ? null : Ainv[k][k] * v));
    if (q[0] === null || q[1] === null) return [null, null, q[2] === null ? null : Ainv[2][2] * q[2]];
    return [Ainv[0][0] * q[0] + Ainv[0][1] * q[1], Ainv[1][0] * q[0] + Ainv[1][1] * q[1], Ainv[2][2] * q[2]];
  }

  // Display frame: rotary table kinematics or lathe mapping.
  function rotate(p, r) {
    let [x, y, z] = p;
    if (r[0]) { const c = Math.cos(-r[0] * D2R), s = Math.sin(-r[0] * D2R); [y, z] = [c * y - s * z, s * y + c * z]; }
    if (r[1]) { const c = Math.cos(-r[1] * D2R), s = Math.sin(-r[1] * D2R); [x, z] = [c * x + s * z, -s * x + c * z]; }
    if (r[2]) { const c = Math.cos(-r[2] * D2R), s = Math.sin(-r[2] * D2R); [x, y] = [c * x - s * y, s * x + c * y]; }
    return [x, y, z];
  }
  const noRot = (r) => !r[0] && !r[1] && !r[2];
  const disp = (p, r) => (isLathe ? [p[2], 0, p[0]] : st.tcp || noRot(r) ? p : rotate(p, r));
  const axisOf = (r) => (isLathe || noRot(r) ? [0, 0, 1] : rotate([0, 0, 1], r));

  // ----------------------------------------------------------- emission
  const known = (p) => p[0] !== null && p[1] !== null && p[2] !== null;
  function rpmAt(x) {
    if (st.css === null || !isLathe) return st.dir * st.rpm;
    const d = Math.max(2 * Math.abs(x), 0.01);
    const surface = st.units === 'in' ? st.css * 304.8 : st.css * 1000; // mm/min
    let r = surface / (Math.PI * d);
    if (st.maxRpm > 0) r = Math.min(r, st.maxRpm);
    else r = Math.min(r, 1e5);
    return st.dir * Math.round(r);
  }
  function emitRaw(a, b, ra, rb, type, code, li) {
    const d = dwellPending;
    dwellPending = 0;
    const rotMove = ra[0] !== rb[0] || ra[1] !== rb[1] || ra[2] !== rb[2];
    if (!isLathe && (rotMove || !noRot(ra))) rotaryUsed = true;
    const n = rotMove ? Math.max(1, Math.ceil(Math.max(...[0, 1, 2].map((k) => Math.abs(rb[k] - ra[k]))) / 2)) : 1;
    let pa = disp(a, ra);
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      const p = k === n ? b : a.map((v, i) => v + (b[i] - v) * f);
      const r = k === n ? rb : ra.map((v, i) => v + (rb[i] - v) * f);
      const pb = disp(p, r);
      segs.push(pa, pb, axisOf(r), type, code, li, st.tool, st.feed, st.feedMode, rpmAt(p[0]), k === 1 ? d : 0);
      pa = pb;
    }
  }

  let compBuf = null;
  let startOverride = null;
  function out(a, b, type, code, li, ra = st.rot, rb = st.rot) {
    if (startOverride) { a = startOverride; startOverride = null; }
    if (compBuf) {
      compBuf.items.push({ a: a.slice(), b: b.slice(), type, code, li, ra: ra.slice(), rb: rb.slice(), feed: st.feed, fmode: st.feedMode, tool: st.tool, rpm: st.rpm, dir: st.dir });
      return;
    }
    emitRaw(a, b, ra, rb, type, code, li);
  }

  function moveTo(to, type, code, li, rotTo = st.rot) {
    const from = st.phys;
    const rf = st.rot;
    if (known(from) && known(to)) {
      if (from[0] !== to[0] || from[1] !== to[1] || from[2] !== to[2] || rf[0] !== rotTo[0] || rf[1] !== rotTo[1] || rf[2] !== rotTo[2] || dwellPending) out(from, to, type, code, li, rf, rotTo);
    } else if (type !== RAPID && type !== TRAVEL) {
      addOnce('unknownStart', li, 'warning', 'Cutting move starts from an unknown position (no earlier G0 to a full X Y Z point); it is not drawn');
    }
    st.phys = to.slice();
    st.rot = rotTo.slice();
  }
  const goP = (p, type, code, li) => moveTo(xf(p), type, code, li);

  // ======================================================== main loop
  const maxLines = opts.maxLines ?? 5e6;
  let pc = 0;
  let steps = 0;
  const repeatCount = new Map();
  while (pc < lines.length) {
    if (++steps > maxLines) {
      add(pc, 'error', `Program runs more than ${maxLines.toLocaleString()} lines; stopped (endless loop?)`);
      break;
    }
    const lab = P(pc).prog;
    if (lab !== null && frames.length === 1 && lab !== mainNumber && segs.n > 0) {
      add(pc, 'warning', `The main program runs into subprogram O${lab} — add M30 before the subprograms`);
      break;
    }
    const next = runLine(pc);
    if (next === -1) break;
    pc = next;
  }
  flushComp();
  if (endLine >= 0) {
    for (let li = endLine + 1; li < lines.length; li++) {
      const r = P(li);
      if (r.prog !== null || r.oword) break;
      if (r.words.length) { add(li, 'warning', `Code after the program end (line ${endLine + 1}) will never run`); break; }
    }
  }
  if (endLine < 0 && segs.n > 0 && !isPrinter && !isLaser) add(lastCodeLine, 'warning', 'Program has no end code (M30 or M2)');
  if (usedG43) for (const m of missingG43) add(m.line, 'warning', `No G43 tool length offset after the T${m.tool} tool change (other tools use G43)`);
  if (rotaryUsed) add(-1, 'info', 'Rotary axes (A/B/C) are drawn in the part frame, assuming a rotary table centred on program zero; material removal is not simulated for rotary moves');

  const seenIssue = new Set();
  return {
    segs: segs.done(),
    issues: issues.filter((i) => { const k = `${i.line}|${i.sev}|${i.msg}`; if (seenIssue.has(k)) return false; seenIssue.add(k); return true; }),
    units: st.units || (opts.defaultUnits === 'in' ? 'in' : 'mm'),
    machine,
    lineCount: lines.length,
    toolHints,
    toolOrder,
    toolChanges,
    dwellTotal,
    filament,
    retracts,
    rotary: rotaryUsed,
    usesComp,
    features: [...features],
  };

  // ======================================================== one line
  function runLine(li) {
    const raw = lines[li];
    if (!raw || !raw.trim()) return li + 1;
    const t = P(li);
    for (const e of t.errors) add(li, 'error', e);
    const commentText = t.comments.map((c) => c.trim()).filter(Boolean).join(' ');

    if (t.oword) return oword(t.oword, li);

    if (t.words.length || t.assigns.length || t.ctl) lastCodeLine = li;
    if (!t.words.length && !t.assigns.length && !t.ctl) {
      if (commentText) commentHint(commentText, li);
      return li + 1;
    }

    // Fanuc macro control
    if (t.ctl) {
      features.add('macro');
      const c = t.ctl;
      if (c.kind === 'goto' || (c.kind === 'ifgoto' && truthy(ev(c.cond, li)))) {
        const n = Math.round(ev(c.target, li) ?? -1);
        const to = labels.get(n);
        if (to === undefined) { add(li, 'error', `GOTO ${n}: there is no N${n} in this program`); return -1; }
        return to;
      }
      if (c.kind === 'ifgoto') return li + 1;
      if (c.kind === 'ifthen') {
        if (truthy(ev(c.cond, li))) for (const a of c.assigns) if (!setVar(a.target, ev(a.e, li), li, commentText)) return -1;
        return li + 1;
      }
      if (c.kind === 'while') {
        if (truthy(ev(c.cond, li))) return li + 1;
        const end = findEnd(li, c.m);
        if (end < 0) { add(li, 'error', `WHILE … DO${c.m} has no matching END${c.m}`); return -1; }
        return end + 1;
      }
      if (c.kind === 'end') {
        const w = findWhile(li, c.m);
        if (w < 0) { add(li, 'error', `END${c.m} has no matching WHILE … DO${c.m}`); return li + 1; }
        return w;
      }
      if (c.kind === 'do') return li + 1;
    }

    // ---- evaluate words
    const gs = [], ms = [], w = {}, wraw = {};
    for (const word of t.words) {
      const v = ev(word.e, li);
      if (v === null) continue; // vacant variable: word omitted
      const L = word.l;
      if (word.e.k !== 'num') features.add('macro');
      if (L === 'G') gs.push(key(v));
      else if (L === 'M') ms.push(key(v));
      else if (L === 'N' || L === 'O') continue;
      else {
        if (w[L] !== undefined) add(li, 'error', `${L} appears twice on one line`);
        w[L] = v;
        wraw[L] = word.raw;
      }
    }
    if (t.assigns.length) features.add('macro');
    for (const a of t.assigns) if (!setVar(a.target, ev(a.e, li), li, commentText)) return -1;
    if (!gs.length && !ms.length && !Object.keys(w).length) {
      if (commentText) commentHint(commentText, li);
      return li + 1;
    }

    // ---- G65 macro call: the other words are arguments
    if (gs.includes(65)) {
      features.add('macro');
      const p = w.P;
      const target = progs.get(Math.round(p ?? -1));
      if (target === undefined) { add(li, 'warning', `G65 P${p}: macro program O${p} is not in this file; skipped`); return li + 1; }
      const map = { A: 1, B: 2, C: 3, I: 4, J: 5, K: 6, D: 7, E: 8, F: 9, H: 11, M: 13, Q: 17, R: 18, S: 19, T: 20, U: 21, V: 22, W: 23, X: 24, Y: 25, Z: 26 };
      const locals = new Map();
      for (const [L, n] of Object.entries(map)) if (w[L] !== undefined) locals.set(n, w[L]);
      if (frames.length > 16) { add(li, 'error', 'Macro calls nested more than 16 deep'); return -1; }
      frames.push({ kind: 'g65', ret: li + 1, start: target + 1, left: Math.max(0, Math.round(w.L ?? 1) - 1), locals, names: new Map() });
      return target + 1;
    }

    // ---- G codes / modal groups (some codes mean different things per machine)
    const seen = new Map();
    const lineG = {};
    for (const c of gs) {
      let g = G_GROUP.get(c);
      if (isLathe) {
        const withMotion = gs.some((x) => x === 0 || x === 1 || x === 2 || x === 3);
        if (c === 98 || c === 99) g = 'feedMode';
        if ([70, 71, 72, 73, 74, 75, 76, 32, 33, 34].includes(c)) g = 'latheCycle';
        if (c === 90 || c === 92 || c === 94) g = 'latheSingle';
        if (c === 90 && withMotion) g = 'distance'; // LinuxCNC-style lathe: G90 = absolute
        if (c === 94 && withMotion) g = 'feedMode';
        if (c === 92 && t.words.every((x) => x.l !== 'F') && st.lcyc !== 92) g = 'nonModal'; // offset, not thread cycle
        if (c === 50) g = 'latheG50';
      } else if (isPrinter) {
        if (c === 10 || c === 11) g = 'printerRetract';
        if (c === 29) g = 'printerIgnored';
      } else if (c === 70 || c === 71) g = 'units';
      else if (c === 33) g = 'motion';
      if (!g) {
        if (IGNORED_G.has(c)) addOnce('ig' + c, li, 'info', `G${c} is machine-specific and is not simulated`);
        else add(li, 'warning', `Unknown G-code G${c} (ignored by the viewer; check your controller supports it)`);
        continue;
      }
      if (seen.has(g)) add(li, 'error', `G${seen.get(g)} and G${c} are in the same modal group and can't be on one line`);
      seen.set(g, c);
      lineG[g] = c;
    }
    const mSeen = new Map();
    for (const c of ms) {
      if (!knownM.has(c)) addOnce('m' + c, li, 'info', `M${c} is machine-specific; the viewer ignores it`);
      const g = M_GROUP.get(c);
      if (g && !isPrinter) {
        if (mSeen.has(g)) add(li, 'error', `M${mSeen.get(g)} and M${c} conflict on the same line`);
        mSeen.set(g, c);
      }
    }
    if (!isLathe && (w.U !== undefined || w.V !== undefined || w.W !== undefined)) addOnce('uvw', li, 'warning', 'U/V/W axis words are ignored on a mill');
    if (isLathe && (w.A !== undefined || w.B !== undefined || w.C !== undefined)) addOnce('latheC', li, 'info', 'C-axis / live-tooling moves are not drawn on the lathe view');
    if (w.E !== undefined && !isPrinter && lineG.nonModal === undefined) addOnce('E', li, 'warning', '"E" words (3D-printer extrusion) are ignored on this machine');
    if (t.blockDelete) addOnce('blockDelete', li, 'info', 'Block-delete "/" lines are shown as if block delete is off');

    // ---- units
    if (lineG.units !== undefined) {
      const u = lineG.units === 20 || lineG.units === 70 ? 'in' : 'mm';
      if (st.units && st.units !== u) add(li, 'warning', `Units change from ${st.units} to ${u} mid-program`);
      if (!st.units && firstMotionLine >= 0) add(li, 'warning', 'Units (G20/G21) are set after the first move');
      st.units = u;
      st.scale = u === 'in' ? MM_PER_INCH : 1;
    }
    const sc = st.scale;

    // ---- feed mode, F, S, T
    if (lineG.feedMode !== undefined) {
      const f = lineG.feedMode;
      st.feedMode = f === 93 ? FM_INVERSE : f === 95 || f === 99 ? FM_PER_REV : FM_PER_MIN;
    }
    if (w.F !== undefined) {
      if (w.F < 0) add(li, 'error', 'Feed rate F cannot be negative');
      st.feed = st.feedMode === FM_INVERSE ? w.F : w.F * sc;
    } else if (st.feedMode === FM_INVERSE) st.feed = 0;
    if (w.S !== undefined) {
      if (w.S < 0) add(li, 'error', 'Spindle speed S cannot be negative');
      const limitOnly = isLathe && (lineG.latheG50 === 50 || (lineG.latheSingle === 92 && !['X', 'Z', 'U', 'W'].some((L) => w[L] !== undefined)));
      if (limitOnly) st.maxRpm = w.S;
      else if (lineG.spindleMode === 96 || (st.css !== null && lineG.spindleMode !== 97)) {
        st.css = w.S;
        if (w.D !== undefined) st.maxRpm = w.D;
        st.sSet = true;
        features.add('css');
      } else {
        st.rpm = Math.abs(w.S);
        st.sSet = true;
      }
    }
    if (lineG.spindleMode === 97) st.css = null;
    if (lineG.spindleMode === 96 && isLathe && !st.maxRpm) add(li, 'warning', 'G96 constant surface speed without a spindle limit (G50 S…) — rpm runs away near the centre');
    if (w.T !== undefined) {
      if (!Number.isInteger(w.T) || w.T < 0) add(li, 'error', `Tool number T${w.T} must be a whole number`);
      const tn = isLathe && w.T >= 100 ? Math.floor(w.T / 100) : Math.round(w.T);
      st.next = tn;
      noteTool(tn);
      if (commentText) hint(tn, li, commentText);
      if (isLathe || isPrinter || isLaser) {
        if (st.tool !== tn) { if (segs.n) toolChanges++; st.tool = tn; lastToolChangeLine = li; }
      } else if (!st.tool && !ms.includes(6)) st.tool = tn;
    } else if (commentText) commentHint(commentText, li);

    // ---- tool change
    if (ms.includes(6) && !isPrinter) {
      flushComp();
      if (st.next === null) add(li, 'error', 'M6 tool change with no tool number (T)');
      else { st.tool = st.next; noteTool(st.tool); }
      toolChanges++;
      if (!isLaser) st.dir = 0;
      g43SinceChange = false;
      lastToolChangeLine = li;
    }

    // ---- spindle / laser / printer M codes, subprogram calls
    let callReq = null, retReq = false;
    for (const c of ms) {
      if (isPrinter) {
        if (c === 82) st.eRel = false;
        else if (c === 83) st.eRel = true;
        else if (c === 104 || c === 109) { if (w.S !== undefined) st.hot = w.S; if (w.R !== undefined) st.hot = w.R; }
        else if (c === 140 || c === 190) { if (w.S !== undefined) st.bed = w.S; }
        continue;
      }
      if (c === 3 || c === 4 || c === 13 || c === 14) {
        if (!isLaser && (!st.sSet || (st.rpm === 0 && st.css === null))) add(li, 'warning', `Spindle started (M${c}) with no speed (S)`);
        st.dir = c === 3 || c === 13 ? 1 : -1;
      } else if (c === 5) st.dir = 0;
      else if (c === 98) {
        let p = w.P, l = w.L ?? w.K;
        if (p === undefined) add(li, 'error', 'M98 subprogram call without P (program number)');
        else {
          if (l === undefined && p > 9999 && progs.get(p) === undefined) { l = Math.floor(p / 10000); p %= 10000; }
          callReq = { prog: Math.round(p), reps: Math.round(l ?? 1) };
        }
      } else if (c === 97) {
        if (w.P === undefined) add(li, 'error', 'M97 local subroutine call without P (N number)');
        else callReq = { label: Math.round(w.P), reps: Math.round(w.L ?? 1) };
      } else if (c === 99) retReq = true;
    }

    // ---- dwell
    const nm = lineG.nonModal;
    if (nm === 4) {
      const p = w.P ?? w.X ?? w.U ?? w.S;
      if (p === undefined) add(li, 'error', 'G4 dwell needs a time (P)');
      else {
        const sec = w.P !== undefined && wraw.P && !/\./.test(wraw.P) && p >= 100 ? p / 1000 : p;
        dwellPending += sec;
        dwellTotal += sec;
      }
    }

    // ---- modal settings
    if (lineG.plane !== undefined) st.plane = lineG.plane;
    if (lineG.distance !== undefined) st.abs = lineG.distance === 90;
    if (lineG.arcDistance !== undefined) st.arcAbs = lineG.arcDistance === 90.1;
    if (lineG.retract !== undefined && !isLathe) st.retract = lineG.retract;
    if (lineG.diameter !== undefined) st.diam = lineG.diameter === 7;
    if (lineG.wcs !== undefined) {
      const before = st.phys.slice();
      st.wcs = lineG.wcs === 54.1 ? 100 + Math.round(w.P ?? 1) : lineG.wcs;
      wcsUsed.add(st.wcs);
      if (wcsUsed.size === 2 && !st.wcsOff.has(st.wcs)) addOnce('wcs', li, 'warning', 'More than one work offset (G54–G59) is used; offsets not set with G10 are drawn on the same origin');
      st.phys = before;
    }
    if (lineG.comp !== undefined) setComp(lineG, w, li);
    if (lineG.length !== undefined) {
      const c = lineG.length;
      if (c === 43 || c === 43.1 || c === 44) {
        usedG43 = true;
        g43SinceChange = true;
        if (w.H === undefined && c !== 43.1) add(li, 'warning', 'G43 tool length offset without H');
        else if (w.H !== undefined && st.tool && w.H !== st.tool) add(li, 'warning', `G43 H${w.H} does not match the active tool T${st.tool}`);
      }
      if (c === 43.4 || c === 43.5 || c === 234) { st.tcp = true; usedG43 = true; g43SinceChange = true; features.add('tcp'); }
      if (c === 49) st.tcp = false;
    }
    if (lineG.scale === 51) {
      const pRaw = w.P !== undefined && wraw.P && !wraw.P.includes('.') && w.P >= 100 ? w.P / 1000 : w.P;
      const f = (L) => (pRaw !== undefined ? pRaw : w[L] ?? 1);
      st.sc = [f('I'), f('J'), f('K')].map((v, k) => Math.sign(st.sc[k]) * Math.abs(v));
      st.scC = [w.X !== undefined ? w.X * sc : 0, w.Y !== undefined ? w.Y * sc : 0, w.Z !== undefined ? w.Z * sc : 0];
      features.add('scaling');
      updXf();
    } else if (lineG.scale === 50) { st.sc = st.sc.map((v) => Math.sign(v)); updXf(); }
    if (lineG.mirror === 51.1) {
      st.sc = st.sc.map((v, k) => (w['XYZ'[k]] !== undefined ? -Math.abs(v) : v));
      st.scC = st.scC.map((v, k) => (w['XYZ'[k]] !== undefined ? w['XYZ'[k]] * sc : v));
      features.add('mirror');
      updXf();
    } else if (lineG.mirror === 50.1) { st.sc = st.sc.map(Math.abs); updXf(); }
    let rotationSet = false;
    if (lineG.rotation === 68) {
      st.rotC = [w.X !== undefined ? w.X * sc : 0, w.Y !== undefined ? w.Y * sc : 0];
      st.rotAng = w.R ?? 0;
      features.add('rotation');
      rotationSet = true;
      updXf();
    } else if (lineG.rotation === 69) { st.rotAng = 0; updXf(); }
    else if (lineG.rotation === 68.2) addOnce('g682', li, 'warning', 'G68.2 tilted work plane is not simulated');
    if (lineG.polar !== undefined) { st.polar = lineG.polar === 16; if (st.polar) features.add('polar'); }
    if (lineG.macroModal === 66) addOnce('g66', li, 'warning', 'G66 modal macro calls are not followed');

    // ---- non-modal codes that consume axis words
    const axisLetters = isLathe ? ['X', 'Z', 'U', 'W'] : ['X', 'Y', 'Z'];
    const hasAxis = axisLetters.some((L) => w[L] !== undefined) || (isLathe && w.Y !== undefined);
    const hasRot = !isLathe && ['A', 'B', 'C'].some((L) => w[L] !== undefined);
    let axesUsed = rotationSet;
    if (isPrinter && (lineG.printerRetract === 10 || lineG.printerRetract === 11)) { if (lineG.printerRetract === 10) retracts++; axesUsed = true; }
    if (isLathe && lineG.latheG50 === 50 && hasAxis) { axesUsed = true; setCurrentAs(w, li); }
    if (nm === 92) {
      axesUsed = true;
      if (isPrinter && w.E !== undefined) st.E = w.E;
      setCurrentAs(w, li);
    } else if (nm === 92.1 || nm === 92.2) st.g92 = [0, 0, 0];
    else if (nm === 52) {
      axesUsed = true;
      ['X', 'Y', 'Z'].forEach((L, k) => { if (w[L] !== undefined) st.g52[k] = w[L] * sc; });
      features.add('offsets');
    } else if (nm === 10 && !isPrinter) {
      axesUsed = true;
      const L = Math.round(w.L ?? 2);
      const p = Math.round(w.P ?? 1);
      if (L === 2 || L === 20) {
        const code = p === 0 ? st.wcs : p <= 6 ? 53 + p : 100 + (p - 6);
        const base = st.wcsOff.get(54) || [0, 0, 0];
        const cur = (st.wcsOff.get(code) || base).slice();
        ['X', 'Y', 'Z'].forEach((Lt, k) => {
          if (w[Lt] === undefined) return;
          if (L === 2) cur[k] = w[Lt] * sc;
          else if (st.phys[k] !== null) cur[k] = st.phys[k] + base[k] - w[Lt] * sc;
        });
        if (!st.wcsOff.has(54) && code !== 54) st.wcsOff.set(54, [0, 0, 0]);
        st.wcsOff.set(code, cur);
        features.add('offsets');
      }
    } else if (nm === 28 || nm === 30) {
      axesUsed = true;
      flushComp();
      const given = (k) => (k === 0 ? w.X !== undefined || (isLathe && w.U !== undefined) : k === 1 ? w.Y !== undefined : w.Z !== undefined || (isLathe && w.W !== undefined));
      const axes = hasAxis ? [0, 1, 2].map(given) : [true, true, true];
      if (hasAxis) goP(targetOf(w, li), isPrinter ? TRAVEL : RAPID, 0, li);
      const home = isPrinter ? [0, 0, 0] : isLathe ? null : nm === 28 ? opts.home : opts.home2 || opts.home;
      if (home) {
        const to = st.phys.slice();
        axes.forEach((on, k) => { if (on) to[k] = home[k]; });
        if (!isPrinter && axes[2] && to[2] !== null && st.phys[2] !== null && to[2] > st.phys[2]) moveTo([st.phys[0], st.phys[1], to[2]], RAPID, 0, li);
        moveTo(to, isPrinter ? TRAVEL : RAPID, 0, li, !hasAxis || hasRot ? [0, 0, 0] : st.rot);
      } else {
        axes.forEach((on, k) => { if (on) st.phys[k] = null; });
        addOnce('g28', li, 'info', `G${nm} goes to machine home, whose position isn't known; the viewer resumes at the next full positioning move`);
      }
    } else if (nm === 53) {
      axesUsed = true;
      if (hasAxis) {
        const base = st.wcsOff.get(54);
        if (base) {
          const to = st.phys.slice();
          ['X', 'Y', 'Z'].forEach((L, k) => { if (w[L] !== undefined) to[k] = w[L] * sc - base[k]; });
          moveTo(to, lineG.motion === 1 ? FEED : RAPID, lineG.motion === 1 ? 1 : 0, li);
        } else {
          ['X', 'Y', 'Z'].forEach((L, k) => { if (w[L] !== undefined) st.phys[k] = null; });
          addOnce('g53', li, 'info', 'G53 machine-coordinate moves can\'t be drawn (set G54 with G10 L2 P1 to place them)');
        }
      }
    }
    if (axesUsed && lineG.motion !== undefined && hasAxis && nm !== 53 && !rotationSet) {
      add(li, 'error', `G${nm ?? lineG.latheG50} and a motion code (G${lineG.motion}) both use the axis words on this line`);
    }

    // ---- motion mode
    if (lineG.motion !== undefined) {
      const m = lineG.motion;
      if (CYCLES.has(m) && !CYCLES.has(st.motion)) st.cyc.initZ = progPos()[2];
      if (!CYCLES.has(m)) st.cyc = { R: null, Z: null, Q: null, P: 0, initZ: null, incR: null, incZ: null };
      if (m >= 38 && m < 39) addOnce('probe', li, 'info', 'Probing moves (G38.x) are drawn as feed moves to the target');
      st.motion = m;
      st.motionLine = li;
      st.lcyc = null;
    }
    if (lineG.latheCycle === 32 || lineG.latheCycle === 33 || lineG.latheCycle === 34) { st.motion = 33; st.motionLine = li; st.lcyc = null; }
    if (lineG.latheSingle !== undefined) {
      const c = lineG.latheSingle;
      if (['X', 'Z', 'U', 'W'].some((L) => w[L] !== undefined)) { st.lcyc = c; st.motion = null; }
      else if (c === 90) st.abs = true;
      else if (c === 94) st.feedMode = FM_PER_MIN;
    }

    // ---- lathe multi-block cycles
    if (isLathe && [70, 71, 72, 73, 74, 75, 76].includes(lineG.latheCycle)) return latheCycle(lineG.latheCycle, w, wraw, li);

    const usesIJKR = w.I !== undefined || w.J !== undefined || w.K !== undefined || w.R !== undefined;
    const eMove = isPrinter && w.E !== undefined && !axesUsed;
    const pocket = st.motion === 12 || st.motion === 13;
    if (!axesUsed && (hasAxis || hasRot || eMove || (usesIJKR && (st.motion === 2 || st.motion === 3)) || (pocket && lineG.motion !== undefined))) {
      if (firstMotionLine < 0 && (hasAxis || hasRot)) {
        firstMotionLine = li;
        if (!st.units && !isPrinter) {
          add(li, 'warning', `No units (G20 inch / G21 mm) set before the first move; assuming ${opts.defaultUnits === 'in' ? 'inches' : 'millimetres'}`);
          st.units = opts.defaultUnits === 'in' ? 'in' : 'mm';
        }
      }
      const m = st.motion;
      if (st.lcyc && isLathe) latheSingleCycle(st.lcyc, w, li);
      else if (m === null) {
        if (isPrinter || eMove) linear(w, li, false);
        else add(li, 'error', 'Axis words with no motion mode active (add G0 or G1)');
      } else if (m === 80) add(li, 'error', 'Axis words while G80 (cancel cycle) is active; add G0 or G1');
      else if (m === 0) linear(w, li, true);
      else if (m === 1 || (m >= 38 && m < 39) || m === 33) { checkFeed(li, w, m === 33); trackG43(li); linear(w, li, false); }
      else if (m === 33.1) rigidTap(w, li);
      else if (m === 2 || m === 3) { checkFeed(li, w); trackG43(li); arc(m, w, li); }
      else if (m === 5 || m === 5.1) { checkFeed(li, w); trackG43(li); spline(m, w, li); }
      else if (pocket) { checkFeed(li, w); trackG43(li); circlePocket(m, w, li); }
      else if (CYCLES.has(m)) { checkFeed(li, w); trackG43(li); cycle(m, w, li); }
    } else if (!axesUsed && usesIJKR && !CYCLES.has(st.motion) && st.motion !== 2 && st.motion !== 3 && !isLathe && lineG.scale === undefined) {
      if (w.I !== undefined || w.J !== undefined || w.K !== undefined) add(li, 'warning', 'I/J/K given without an arc move; ignored');
    }
    if (compBuf && compBuf.cancelPending) flushComp();

    // ---- program flow
    if (ms.includes(30) || ms.includes(2)) {
      flushComp();
      st.ended = true;
      endLine = li;
      return -1;
    }
    if (callReq) {
      const target = callReq.label !== undefined ? labels.get(callReq.label) : progs.get(callReq.prog);
      if (target === undefined) {
        add(li, 'warning', callReq.label !== undefined ? `M97 P${callReq.label}: there is no N${callReq.label}` : `Subprogram O${callReq.prog} (M98 P${callReq.prog}) is not in this file; the call is skipped`);
        return li + 1;
      }
      features.add('subprograms');
      if (frames.length > 16) { add(li, 'error', 'Subprograms nested more than 16 deep'); return -1; }
      if (callReq.reps <= 0) return li + 1;
      const start = callReq.label !== undefined ? target : target + 1;
      frames.push({ kind: 'm98', ret: li + 1, start, left: callReq.reps - 1, locals: top().locals, names: top().names });
      return start;
    }
    if (retReq) {
      if (frames.length === 1) {
        addOnce('m99main', li, 'info', 'M99 in the main program restarts it on most controls; the viewer stops here');
        endLine = li;
        return -1;
      }
      const fr = top();
      if (fr.left > 0) { fr.left--; return fr.start; }
      frames.pop();
      return fr.ret;
    }
    return li + 1;
  }

  // ------------------------------------------------------- LinuxCNC o-words
  function oword(o, li) {
    features.add('owords');
    const id = o.id;
    switch (o.kw) {
      case 'sub': {
        const end = oAfter(id, li, ['endsub']);
        if (!end) { add(li, 'error', `o${id} sub has no endsub`); return -1; }
        return end.line + 1;
      }
      case 'endsub':
      case 'return': {
        if (o.kw === 'return' && o.cond) gnames.set('_value', ev(o.cond, li));
        const fr = top();
        if (fr.kind !== 'osub') return li + 1;
        frames.pop();
        return fr.ret;
      }
      case 'call': {
        const sub = (ostruct.get(id) || []).find((e) => e.kw === 'sub');
        if (!sub) { add(li, 'warning', `o${id} call: the subroutine is not in this file (external files are not followed)`); return li + 1; }
        if (frames.length > 16) { add(li, 'error', 'Subroutine calls nested more than 16 deep'); return -1; }
        const locals = new Map();
        o.args.forEach((a, i) => locals.set(i + 1, ev(a, li)));
        frames.push({ kind: 'osub', ret: li + 1, locals, names: new Map() });
        return sub.line + 1;
      }
      case 'if': {
        if (truthy(ev(o.cond, li))) return li + 1;
        let from = li;
        for (;;) {
          const cl = oAfter(id, from, ['elseif', 'else', 'endif']);
          if (!cl) { add(li, 'error', `o${id} if has no endif`); return -1; }
          if (cl.kw !== 'elseif') return cl.line + 1;
          if (truthy(ev(P(cl.line).oword.cond, cl.line))) return cl.line + 1;
          from = cl.line;
        }
      }
      case 'elseif':
      case 'else': {
        const end = oAfter(id, li, ['endif']);
        return end ? end.line + 1 : li + 1;
      }
      case 'endif':
      case 'do':
        return li + 1;
      case 'while': {
        const opener = oBefore(id, li, ['do', 'while', 'endwhile']);
        if (opener && opener.kw === 'do') return truthy(ev(o.cond, li)) ? opener.line + 1 : li + 1;
        if (truthy(ev(o.cond, li))) return li + 1;
        const end = oAfter(id, li, ['endwhile']);
        if (!end) { add(li, 'error', `o${id} while has no endwhile`); return -1; }
        return end.line + 1;
      }
      case 'endwhile': {
        const w = oBefore(id, li, ['while']);
        return w ? w.line : li + 1;
      }
      case 'repeat': {
        if (!repeatCount.has(li)) repeatCount.set(li, Math.round(ev(o.cond, li) ?? 0));
        const left = repeatCount.get(li);
        if (left <= 0) {
          repeatCount.delete(li);
          const end = oAfter(id, li, ['endrepeat']);
          return end ? end.line + 1 : li + 1;
        }
        repeatCount.set(li, left - 1);
        return li + 1;
      }
      case 'endrepeat': {
        const r = oBefore(id, li, ['repeat']);
        return r ? r.line : li + 1;
      }
      case 'break': {
        const r = oBefore(id, li, ['repeat']);
        if (r) repeatCount.delete(r.line);
        const end = oAfter(id, li, ['endwhile', 'endrepeat', 'while']);
        return end ? end.line + 1 : li + 1;
      }
      case 'continue': {
        const loop = oBefore(id, li, ['while', 'repeat', 'do']);
        if (!loop) return li + 1;
        if (loop.kw === 'do') { const cl = oAfter(id, li, ['while']); return cl ? cl.line : li + 1; }
        if (loop.kw === 'repeat') { const end = oAfter(id, li, ['endrepeat']); return end ? end.line : li + 1; }
        return loop.line;
      }
      default:
        return li + 1;
    }
  }

  function findEnd(li, m) {
    let depth = 0;
    for (let i = li + 1; i < lines.length; i++) {
      const c = P(i).ctl;
      if (!c) continue;
      if (c.kind === 'while' && c.m === m) depth++;
      if (c.kind === 'end' && c.m === m) { if (depth === 0) return i; depth--; }
    }
    return -1;
  }
  function findWhile(li, m) {
    let depth = 0;
    for (let i = li - 1; i >= 0; i--) {
      const c = P(i).ctl;
      if (!c) continue;
      if (c.kind === 'end' && c.m === m) depth++;
      if (c.kind === 'while' && c.m === m) { if (depth === 0) return i; depth--; }
    }
    return -1;
  }
  function truthy(v) { return v !== null && v !== 0 && !Number.isNaN(v); }

  // ---------------------------------------------------------------- helpers
  function hint(tool, line, text) {
    if (!toolHints.has(tool)) toolHints.set(tool, []);
    const arr = toolHints.get(tool);
    if (!arr.some((h) => h.text === text)) arr.push({ line, text });
  }
  function commentHint(text, li) {
    const m = /(?:^|[^A-Z0-9])T\s*(\d+)\b/i.exec(text);
    if (m) {
      let tn = +m[1];
      if (isLathe && tn >= 100) tn = Math.floor(tn / 100);
      hint(tn, li, text);
    } else if (li - lastToolChangeLine <= 2 && !toolHints.has(st.tool)) hint(st.tool, li, text);
  }

  function trackG43(li) {
    if (!g43SinceChange && toolChanges > 0 && !isLathe && !isLaser) {
      missingG43.push({ line: li, tool: st.tool });
      g43SinceChange = true;
    }
  }

  function checkFeed(li, w, thread = false) {
    if (st.feedMode === FM_INVERSE) {
      if (w.F === undefined) add(li, 'error', 'Inverse-time feed (G93) needs F on every feed move');
    } else if (!(st.feed > 0)) {
      add(li, 'error', thread ? 'Threading move without a lead (F)' : `Feed move (G${st.motion}) with no feed rate (F)`);
    }
  }

  /** Program-space target from axis words. */
  function targetOf(w, li) {
    const sc = st.scale;
    const cur = progPos();
    const to = cur.slice();
    if (st.polar && !isLathe && (w.X !== undefined || w.Y !== undefined)) {
      const r0 = cur[0] !== null && cur[1] !== null ? Math.hypot(cur[0], cur[1]) : 0;
      const a0 = cur[0] !== null && cur[1] !== null ? Math.atan2(cur[1], cur[0]) / D2R : 0;
      const r = w.X !== undefined ? (st.abs ? w.X * sc : r0 + w.X * sc) : r0;
      const a = w.Y !== undefined ? (st.abs ? w.Y : a0 + w.Y) : a0;
      to[0] = r * Math.cos(a * D2R);
      to[1] = r * Math.sin(a * D2R);
      if (w.Z !== undefined) to[2] = st.abs ? w.Z * sc : cur[2] === null ? null : cur[2] + w.Z * sc;
      return to;
    }
    ['X', 'Y', 'Z'].forEach((L, k) => {
      if (w[L] === undefined || (isLathe && k === 1)) return;
      let v = w[L] * sc;
      if (isLathe && k === 0 && st.diam) v /= 2;
      if (st.abs) to[k] = v;
      else if (cur[k] === null) { addOnce('incUnknown', li, 'warning', 'Incremental (G91) move from an unknown position'); to[k] = null; }
      else to[k] = cur[k] + v;
    });
    if (isLathe) {
      if (w.U !== undefined) to[0] = cur[0] === null ? null : cur[0] + (w.U * sc) / (st.diam ? 2 : 1);
      if (w.W !== undefined) to[2] = cur[2] === null ? null : cur[2] + w.W * sc;
      to[1] = 0;
    }
    return to;
  }
  function rotTarget(w) {
    const r = st.rot.slice();
    if (isLathe) return r;
    ['A', 'B', 'C'].forEach((L, k) => { if (w[L] !== undefined) r[k] = st.abs ? w[L] : r[k] + w[L]; });
    return r;
  }
  function setCurrentAs(w, li) {
    const sc = st.scale;
    const pp = progPos();
    ['X', 'Y', 'Z'].forEach((L, k) => {
      if (w[L] === undefined) return;
      if (pp[k] === null) { add(li, 'warning', `${L} offset set while its position is unknown`); return; }
      let v = w[L] * sc;
      if (isLathe && k === 0 && st.diam) v /= 2;
      st.g92[k] += (pp[k] - v) * A[k][k];
    });
  }

  function cutType(isRapid, w, kind = FEED) {
    if (isPrinter) {
      let de = 0;
      if (w.E !== undefined) {
        de = st.eRel ? w.E : w.E - st.E;
        st.E = st.eRel ? st.E + w.E : w.E;
      }
      if (de > 1e-6) {
        filament += de;
        if (st.hot === null) addOnce('cold', firstMotionLine, 'warning', 'Extruding before a hotend temperature is set (M104/M109)');
        else if (st.hot < 170) addOnce('coldT', firstMotionLine, 'warning', `Extruding with the hotend set to ${st.hot}° — below the usual minimum for extrusion`);
        return kind;
      }
      if (de < -1e-6) retracts++;
      return TRAVEL;
    }
    if (isRapid) return RAPID;
    if (isLaser) return st.dir !== 0 && (st.rpm > 0 || !st.sSet) ? kind : TRAVEL;
    return kind;
  }

  function linear(w, li, isRapid) {
    if (isRapid && isLaser && st.dir === 1 && st.rpm > 0) addOnce('laserRapid', li, 'info', 'Laser is in constant-power mode (M3) during G0 moves; Grbl turns it off for rapids, other controls may not');
    const to = xf(targetOf(w, li));
    const rt = rotTarget(w);
    const type = cutType(isRapid && !isPrinter, w);
    const geomMove = ['X', 'Y', 'Z', 'U', 'W'].some((L) => w[L] !== undefined) || rt.some((v, k) => v !== st.rot[k]);
    if (!geomMove) return;
    if (st.tcp && rt.some((v, k) => v !== st.rot[k])) features.add('5axis');
    moveTo(to, type, isRapid ? 0 : st.motion === 33 ? 33 : 1, li, rt);
  }

  function arc(m, w, li) {
    const sc = st.scale;
    const [a, b, l] = st.plane === 17 ? [0, 1, 2] : st.plane === 18 ? [2, 0, 1] : [1, 2, 0];
    const offL = ['I', 'J', 'K'];
    const from = progPos();
    const to = targetOf(w, li);
    if (!known(from) || !known(to)) { add(li, 'error', 'Arc from or to an unknown position'); st.phys = xf(to); return; }
    const sa = from[a], sb = from[b], ea = to[a], eb = to[b];
    let ca, cb;
    if (w.R !== undefined) {
      const R = w.R * sc;
      const dx = ea - sa, dy = eb - sb;
      const d = Math.hypot(dx, dy);
      if (d < 1e-6) { add(li, 'error', 'R-format arc with the same start and end point (use I/J/K for a full circle)'); st.phys = xf(to); return; }
      if (Math.abs(R) < d / 2 - Math.max(0.005, d * 1e-4)) {
        add(li, 'error', `Arc radius R${fmt(w.R)} is too small to reach the end point (needs at least ${fmt(d / 2 / sc)})`);
        st.phys = xf(to);
        return;
      }
      const h = Math.sqrt(Math.max(0, R * R - (d / 2) ** 2));
      const mx = (sa + ea) / 2, my = (sb + eb) / 2;
      const px = -dy / d, py = dx / d;
      let side = m === 2 ? -1 : 1;
      if (R < 0) side = -side;
      ca = mx + side * h * px;
      cb = my + side * h * py;
    } else {
      const ia = w[offL[a]], ib = w[offL[b]];
      if (ia === undefined && ib === undefined) {
        add(li, 'error', st.motionLine === li
          ? `Arc (G${m}) needs I/J/K centre offsets or R`
          : `This move uses G${m} (arc) still active from line ${st.motionLine + 1}, but has no I/J/K or R — add G0 or G1`);
        st.phys = xf(to);
        return;
      }
      const oa = (ia ?? 0) * sc, ob = (ib ?? 0) * sc;
      if (st.arcAbs) { ca = oa; cb = ob; } else { ca = sa + oa; cb = sb + ob; }
      const r1 = Math.hypot(sa - ca, sb - cb), r2 = Math.hypot(ea - ca, eb - cb);
      const diff = Math.abs(r1 - r2);
      if (diff > 0.05) add(li, 'error', `Arc end point is not on the circle: start radius ${fmt(r1 / sc)}, end radius ${fmt(r2 / sc)}`);
      else if (diff > 0.0125 && diff > r1 * 1e-3) add(li, 'warning', `Arc radius mismatch of ${fmt(diff / sc)} between start and end`);
    }
    const r1 = Math.hypot(sa - ca, sb - cb), r2 = Math.hypot(ea - ca, eb - cb);
    if (r1 < 1e-6) { add(li, 'error', 'Arc has zero radius'); st.phys = xf(to); return; }
    const a0 = Math.atan2(sb - cb, sa - ca);
    const a1 = Math.atan2(eb - cb, ea - ca);
    let sweep;
    if (Math.hypot(ea - sa, eb - sb) < 1e-4) sweep = 2 * Math.PI;
    else {
      sweep = m === 2 ? a0 - a1 : a1 - a0;
      while (sweep <= 0) sweep += 2 * Math.PI;
      while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;
    }
    if (w.P !== undefined && w.P > 1 && !isPrinter) sweep += 2 * Math.PI * (Math.round(w.P) - 1);
    const dir = m === 2 ? -1 : 1;
    const rMax = Math.max(r1, r2);
    const step = rMax > arcTol ? 2 * Math.acos(Math.max(-1, 1 - arcTol / rMax)) : Math.PI / 4;
    const n = Math.min(4000, Math.max(1, Math.ceil(sweep / Math.min(step, Math.PI / 18))));
    const type = cutType(false, w, ARC);
    const rt = rotTarget(w);
    const r0 = st.rot.slice();
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      let p;
      if (k === n) p = to.slice();
      else {
        const ang = a0 + dir * sweep * f;
        const r = r1 + (r2 - r1) * f;
        p = [0, 0, 0];
        p[a] = ca + r * Math.cos(ang);
        p[b] = cb + r * Math.sin(ang);
        p[l] = from[l] + (to[l] - from[l]) * f;
      }
      moveTo(xf(p), type, m, li, r0.map((v, i) => v + (rt[i] - v) * f));
    }
  }

  function spline(m, w, li) {
    const sc = st.scale;
    const from = progPos();
    const to = targetOf(w, li);
    if (!known(from) || !known(to)) { add(li, 'error', 'Spline from or to an unknown position'); st.phys = xf(to); return; }
    features.add('spline');
    let c1, c2;
    if (m === 5.1) c1 = [from[0] + (w.I ?? 0) * sc, from[1] + (w.J ?? 0) * sc];
    else {
      if (w.I !== undefined || w.J !== undefined) c1 = [from[0] + (w.I ?? 0) * sc, from[1] + (w.J ?? 0) * sc];
      else if (st.lastCtl) c1 = [2 * from[0] - st.lastCtl[0], 2 * from[1] - st.lastCtl[1]];
      else { add(li, 'error', 'G5 spline needs I/J for its first control point'); st.phys = xf(to); return; }
      if (w.P === undefined || w.Q === undefined) { add(li, 'error', 'G5 spline needs P and Q for its second control point'); st.phys = xf(to); return; }
      c2 = [to[0] + w.P * sc, to[1] + w.Q * sc];
      st.lastCtl = c2;
    }
    const n = 32;
    const type = cutType(false, w, ARC);
    for (let k = 1; k <= n; k++) {
      const t = k / n, u = 1 - t;
      let x, y;
      if (m === 5.1) { x = u * u * from[0] + 2 * u * t * c1[0] + t * t * to[0]; y = u * u * from[1] + 2 * u * t * c1[1] + t * t * to[1]; }
      else {
        x = u * u * u * from[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * to[0];
        y = u * u * u * from[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * to[1];
      }
      moveTo(xf([x, y, from[2] + (to[2] - from[2]) * t]), type, 5, li);
    }
  }

  // Haas G12/G13 circular pocket: I first radius, K final radius, Q step, Z depth
  function circlePocket(m, w, li) {
    const sc = st.scale;
    const c = progPos();
    if (!known(c)) { add(li, 'error', `G${m} circular pocket from an unknown position`); return; }
    features.add('circlePocket');
    const I = (w.I ?? 0) * sc, K = (w.K ?? w.I ?? 0) * sc, Q = (w.Q ?? 0) * sc;
    if (!(I > 0)) { add(li, 'error', `G${m} needs I (radius of the first circle)`); return; }
    const z = w.Z !== undefined ? (st.abs ? w.Z * sc : c[2] + w.Z * sc) : c[2];
    if (z !== c[2]) goP([c[0], c[1], z], FEED, 1, li);
    const radii = [];
    for (let r = I; r < K - 1e-9 && Q > 0; r += Q) radii.push(r);
    radii.push(Math.max(I, K));
    const dir = m === 12 ? -1 : 1;
    for (const r of radii) {
      goP([c[0] + r, c[1], z], FEED, 1, li);
      const n = Math.max(36, Math.ceil(2 * Math.PI * r));
      for (let k = 1; k <= n; k++) {
        const a = (dir * 2 * Math.PI * k) / n;
        goP([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a), z], ARC, m, li);
      }
    }
    goP([c[0], c[1], z], FEED, 1, li);
    goP(c, RAPID, 0, li);
  }

  function rigidTap(w, li) {
    const sc = st.scale;
    const c = progPos();
    if (!known(c) || w.Z === undefined) { add(li, 'error', 'G33.1 rigid tap needs a Z depth'); return; }
    const z = st.abs ? w.Z * sc : c[2] + w.Z * sc;
    goP([c[0], c[1], z], DRILL, 84, li);
    goP(c, DRILL, 84, li);
  }

  // ------------------------------------------------------- drilling cycles
  function cycle(m, w, li) {
    const sc = st.scale;
    const c = st.cyc;
    if (st.plane !== 17 && !isLathe) addOnce('cyclePlane', li, 'warning', 'Canned cycles are only drawn in the G17 (XY) plane');
    flushComp();
    const cur = progPos();
    if (cur[2] === null) { add(li, 'error', `Canned cycle G${m} started with an unknown Z position; position Z first`); return; }
    if (c.initZ === null) c.initZ = cur[2];
    if (w.Q !== undefined) c.Q = Math.abs(w.Q) * sc;
    if (w.P !== undefined) c.P = w.P >= 100 && wraw_isInt(w.P) ? w.P / 1000 : w.P;
    const reps = w.L ?? w.K;
    if (reps === 0) return;
    let R, Z;
    if (st.abs) {
      if (w.R !== undefined) c.R = w.R * sc;
      if (w.Z !== undefined) c.Z = w.Z * sc;
      R = c.R;
      Z = c.Z;
    } else {
      if (w.R !== undefined) c.incR = w.R * sc;
      if (w.Z !== undefined) c.incZ = w.Z * sc;
      R = c.incR === null ? null : c.initZ + c.incR;
      Z = c.incZ === null || R === null ? null : R + c.incZ;
    }
    if (R === null || R === undefined) {
      if (isLathe) R = cur[2];
      else { add(li, 'error', `Canned cycle G${m} needs R (retract plane)`); return; }
    }
    if (Z === null || Z === undefined) { add(li, 'error', `Canned cycle G${m} needs Z (hole bottom)`); return; }
    if (Z > R) { add(li, 'error', `Canned cycle bottom Z${fmt(Z / sc)} is above the R plane R${fmt(R / sc)}`); return; }
    if (CYCLE_NEEDS_Q.has(m) && !(c.Q > 0)) { add(li, 'error', `Peck cycle G${m} needs a peck depth Q greater than 0`); return; }
    const count = st.abs ? 1 : Math.max(1, Math.round(reps ?? 1));
    for (let k = 0; k < count; k++) {
      const p = progPos();
      const xy = p.slice();
      if (isLathe) xy[0] = 0;
      else {
        ['X', 'Y'].forEach((L, i) => {
          if (w[L] === undefined) return;
          const v = w[L] * sc;
          xy[i] = st.abs ? v : xy[i] === null ? null : xy[i] + v;
        });
      }
      if (p[2] < R) goP([p[0], p[1], R], RAPID, m, li);
      goP([xy[0], xy[1], progPos()[2]], RAPID, m, li);
      if (!known(st.phys)) { add(li, 'error', 'Canned cycle hole at an unknown XY position'); return; }
      goP([xy[0], xy[1], R], RAPID, m, li);
      const x = xy[0], y = xy[1];
      const feedTo = (z) => goP([x, y, z], DRILL, m, li);
      const rapidTo = (z) => goP([x, y, z], RAPID, m, li);
      if (m === 83 || m === 73) {
        const clear = Math.min(0.25, c.Q / 2);
        let depth = R;
        while (depth > Z + 1e-9) {
          const nextD = Math.max(Z, depth - c.Q);
          if (m === 83 && depth < R) rapidTo(depth + clear);
          feedTo(nextD);
          if (m === 83) rapidTo(R);
          else if (nextD > Z) rapidTo(nextD + clear);
          depth = nextD;
        }
        if (m === 73) rapidTo(R);
      } else {
        feedTo(Z);
        if (m === 82 || m === 89) dwellPending += c.P || 0;
        if (m === 84 || m === 74 || m === 85 || m === 89 || m === 84.2 || m === 84.3) feedTo(R);
        else rapidTo(R);
      }
      if (st.retract === 98 && c.initZ > R && !isLathe) rapidTo(c.initZ);
    }
  }
  function wraw_isInt(v) { return Number.isInteger(v); }

  // ---------------------------------------------------- lathe single cycles
  function latheSingleCycle(code, w, li) {
    const sc = st.scale;
    const s = progPos();
    if (!known(s)) { add(li, 'error', `G${code} cycle from an unknown position`); return; }
    checkFeed(li, w, code === 92);
    const t = targetOf(w, li);
    const taper = ((w.R ?? 0) * sc);
    features.add('latheCycles');
    if (code === 90) {
      goP([t[0] + taper, 0, s[2]], RAPID, 90, li);
      goP([t[0], 0, t[2]], FEED, 90, li);
      goP([s[0], 0, t[2]], FEED, 90, li);
      goP(s, RAPID, 90, li);
    } else if (code === 92) {
      goP([t[0] + taper, 0, s[2]], RAPID, 92, li);
      goP([t[0], 0, t[2]], FEED, 33, li);
      goP([s[0], 0, t[2]], RAPID, 92, li);
      goP(s, RAPID, 92, li);
    } else if (code === 94) {
      goP([s[0], 0, t[2] + taper], RAPID, 94, li);
      goP([t[0], 0, t[2]], FEED, 94, li);
      goP([t[0], 0, s[2]], FEED, 94, li);
      goP(s, RAPID, 94, li);
    }
  }

  // ------------------------------------------------ lathe multi-block cycles
  function latheCycle(code, w, wraw, li) {
    const sc = st.scale;
    const inc = st.units === 'in' ? 0.0001 * MM_PER_INCH : 0.001; // Fanuc least increment
    const micro = (L) => (w[L] === undefined ? undefined : wraw[L] && !wraw[L].includes('.') ? w[L] * inc : w[L] * sc);
    features.add('latheCycles');
    const hasPQ = w.P !== undefined && w.Q !== undefined;
    const hasXZ = ['X', 'Z', 'U', 'W'].some((L) => w[L] !== undefined);
    if ((code === 71 || code === 72) && !hasPQ) {
      st.lc[code] = { d: ((code === 71 ? w.U : w.W) ?? 1) * sc, e: (w.R ?? 0.5) * sc };
      return li + 1;
    }
    if (code === 73 && !hasPQ) {
      st.lc[73] = { di: (w.U ?? 0) * sc, dk: (w.W ?? 0) * sc, n: Math.max(1, Math.round(w.R ?? 1)) };
      return li + 1;
    }
    if (code === 70 || code === 71 || code === 72 || code === 73) {
      const ns = labels.get(Math.round(w.P)), nf = labels.get(Math.round(w.Q));
      if (ns === undefined || nf === undefined || nf < ns) { add(li, 'error', `G${code} P${w.P} Q${w.Q}: profile blocks N${w.P}…N${w.Q} not found`); return li + 1; }
      const start = progPos();
      if (!known(start)) { add(li, 'error', `G${code} from an unknown position`); return code === 70 ? li + 1 : nf + 1; }
      if (code === 70) {
        for (let i = ns; i <= nf; i++) runLine(i);
        goP(start, RAPID, 0, li);
        return li + 1;
      }
      if (w.F !== undefined) st.feed = w.F * sc;
      if (!(st.feed > 0)) add(li, 'error', `G${code} cycle with no feed rate (F)`);
      const prof = captureProfile(ns, nf);
      if (prof.length < 2) { add(li, 'error', `G${code}: the profile N${w.P}…N${w.Q} has no moves`); return nf + 1; }
      const ua = ((w.U ?? 0) * sc) / (st.diam ? 2 : 1), wa = (w.W ?? 0) * sc;
      if (code === 73) {
        const pr = st.lc[73] || { di: 0, dk: 0, n: 1 };
        for (let k = 1; k <= pr.n; k++) {
          const f = pr.n === 1 ? 0 : (pr.n - k) / (pr.n - 1);
          const ox = ua + pr.di * f, oz = wa + pr.dk * f;
          goP([prof[0][0] + ox, 0, prof[0][1] + oz], RAPID, 73, li);
          for (const q of prof.slice(1)) goP([q[0] + ox, 0, q[1] + oz], FEED, 73, li);
          goP(start, RAPID, 73, li);
        }
        return nf + 1;
      }
      const pr = st.lc[code] || { d: 1, e: 0.5 };
      if (!(pr.d > 0)) { add(li, 'error', `G${code} depth of cut must be greater than 0`); return nf + 1; }
      // (cross, along) coordinates: G71 cross = X(radius), along = Z; G72 swaps them
      const sw = code === 72;
      const C = (x, z) => (sw ? [z, x] : [x, z]);
      const U = (c, a) => (sw ? [a, 0, c] : [c, 0, a]);
      const off = sw ? [wa, ua] : [ua, wa];
      const pts = prof.map(([x, z]) => { const c = C(x, z); return [c[0] + off[0], c[1] + off[1]]; });
      const s0 = C(start[0], start[2]);
      const outside = Math.min(...pts.map((q) => q[0])) < s0[0];
      const sgn = outside ? -1 : 1;
      const limit = outside ? Math.min(...pts.map((q) => q[0])) : Math.max(...pts.map((q) => q[0]));
      const alongDir = Math.sign(pts[pts.length - 1][1] - pts[0][1]) || -1;
      let level = s0[0] + sgn * pr.d;
      let guard = 0;
      while ((outside ? level > limit + 1e-6 : level < limit - 1e-6) && guard++ < 5000) {
        if (outside ? pts[0][0] >= level : pts[0][0] <= level) { level += sgn * pr.d; continue; }
        let endA = pts[pts.length - 1][1];
        for (let i = 1; i < pts.length; i++) {
          const [c0, a0] = pts[i - 1], [c1, a1] = pts[i];
          if (outside ? c1 >= level && c0 < level : c1 <= level && c0 > level) { endA = a0 + ((level - c0) / (c1 - c0)) * (a1 - a0); break; }
        }
        goP(U(level, s0[1]), RAPID, code, li);
        goP(U(level, endA), FEED, code, li);
        goP(U(level - sgn * pr.e, endA - alongDir * pr.e), FEED, code, li);
        goP(U(level - sgn * pr.e, s0[1]), RAPID, code, li);
        level += sgn * pr.d;
      }
      goP(U(pts[0][0], s0[1]), RAPID, code, li);
      for (const q of pts) goP(U(q[0], q[1]), FEED, code, li);
      const endNow = progPos();
      goP(U(s0[0], C(endNow[0], endNow[2])[1]), RAPID, code, li);
      goP(start, RAPID, code, li);
      return nf + 1;
    }
    if (code === 74 || code === 75) {
      if (!hasXZ) { st.lc[code] = { e: (w.R ?? 0.5) * sc }; return li + 1; }
      const s = progPos();
      if (!known(s)) { add(li, 'error', `G${code} from an unknown position`); return li + 1; }
      checkFeed(li, w);
      const t = targetOf(w, li);
      const e = st.lc[code]?.e ?? 0.5;
      const di = micro('P') ?? 0, dk = micro('Q') ?? 0;
      const steps = (from, to, step) => {
        const out = [];
        if (step > 0 && Math.abs(to - from) > 1e-6) for (let v = from; Math.abs(v - to) > 1e-6; v += Math.sign(to - from) * Math.min(step, Math.abs(to - v))) out.push(v);
        out.push(to);
        return out;
      };
      if (code === 74) {
        for (const x of steps(s[0], t[0], di)) {
          goP([x, 0, s[2]], RAPID, 74, li);
          let z = s[2];
          const dir = Math.sign(t[2] - s[2]) || -1;
          while (dir * (t[2] - z) > 1e-9) {
            const nz = dk > 0 ? z + dir * Math.min(dk, Math.abs(t[2] - z)) : t[2];
            goP([x, 0, nz], DRILL, 74, li);
            if (dir * (t[2] - nz) > 1e-9) goP([x, 0, nz - dir * e], RAPID, 74, li);
            z = nz;
          }
          goP([x, 0, s[2]], RAPID, 74, li);
        }
      } else {
        for (const z of steps(s[2], t[2], dk)) {
          goP([s[0], 0, z], RAPID, 75, li);
          let x = s[0];
          const dir = Math.sign(t[0] - s[0]) || -1;
          while (dir * (t[0] - x) > 1e-9) {
            const nx = di > 0 ? x + dir * Math.min(di, Math.abs(t[0] - x)) : t[0];
            goP([nx, 0, z], DRILL, 75, li);
            if (dir * (t[0] - nx) > 1e-9) goP([nx - dir * e, 0, z], RAPID, 75, li);
            x = nx;
          }
          goP([s[0], 0, z], RAPID, 75, li);
        }
      }
      goP(s, RAPID, code, li);
      return li + 1;
    }
    if (code === 76) {
      const s = progPos();
      if (w.J !== undefined && w.K !== undefined && w.P !== undefined) {
        // LinuxCNC: G76 P(pitch) Z I(offset) J(first depth) K(full depth) R(degression) H(spring passes)
        if (!known(s) || w.Z === undefined) { add(li, 'error', 'G76 needs a start position and Z'); return li + 1; }
        const pitch = w.P * sc, I = (w.I ?? 0) * sc, J = w.J * sc, K = w.K * sc, deg = w.R ?? 1;
        const zEnd = st.abs ? w.Z * sc : s[2] + w.Z * sc;
        const crest = s[0] + I, dirIn = I < 0 ? -1 : 1;
        const depths = [];
        for (let n = 1; depths.length < 200; n++) { const d = J * Math.pow(n, 1 / deg); if (d >= K) break; depths.push(d); }
        depths.push(K);
        for (let h = 0; h < Math.round(w.H ?? 0); h++) depths.push(K);
        const keep = { feed: st.feed, fm: st.feedMode };
        st.feed = pitch;
        st.feedMode = FM_PER_REV;
        for (const d of depths) {
          const x = crest + dirIn * d;
          goP([x, 0, s[2]], RAPID, 76, li);
          goP([x, 0, zEnd], FEED, 33, li);
          goP([s[0], 0, zEnd], RAPID, 76, li);
          goP(s, RAPID, 76, li);
        }
        st.feed = keep.feed; st.feedMode = keep.fm;
        features.add('threading');
        return li + 1;
      }
      if (!hasXZ) {
        const pw = w.P !== undefined ? Math.round(w.P) : 10060;
        st.lc[76] = { spring: Math.floor(pw / 10000), angle: pw % 100, dmin: micro('Q') ?? 0.05, fin: (w.R ?? 0) * sc };
        return li + 1;
      }
      if (!known(s)) { add(li, 'error', 'G76 thread cycle from an unknown position'); return li + 1; }
      const cfg = st.lc[76] || { spring: 1, angle: 60, dmin: 0.05, fin: 0 };
      const t = targetOf(w, li);
      const k = micro('P'), d1 = micro('Q');
      if (!(k > 0) || !(d1 > 0)) { add(li, 'error', 'G76 needs P (thread height) and Q (first cut depth)'); return li + 1; }
      if (w.F === undefined && !(st.feed > 0)) add(li, 'error', 'G76 needs F (thread lead)');
      const keep = { feed: st.feed, fm: st.feedMode };
      if (w.F !== undefined) st.feed = w.F * sc;
      st.feedMode = FM_PER_REV;
      const sgn = t[0] < s[0] ? 1 : -1; // OD thread: cut radius above the root
      const depths = [];
      for (let n = 1; n < 500; n++) {
        let d = d1 * Math.sqrt(n);
        const prev = depths[depths.length - 1] ?? 0;
        if (n > 1 && d - prev < cfg.dmin) d = prev + cfg.dmin;
        if (d >= k - cfg.fin) break;
        depths.push(d);
      }
      depths.push(k);
      for (let i = 1; i < Math.max(1, cfg.spring); i++) depths.push(k);
      const taper = (w.R ?? 0) * sc;
      for (const d of depths) {
        const x = t[0] + sgn * (k - d);
        goP([x + taper, 0, s[2]], RAPID, 76, li);
        goP([x, 0, t[2]], FEED, 33, li);
        goP([s[0], 0, t[2]], RAPID, 76, li);
        goP(s, RAPID, 76, li);
      }
      st.feed = keep.feed; st.feedMode = keep.fm;
      features.add('threading');
      return li + 1;
    }
    return li + 1;
  }

  /** Run profile blocks without drawing; returns [radius, z] points in program space. */
  function captureProfile(ns, nf) {
    const saved = { phys: st.phys.slice(), rot: st.rot.slice(), motion: st.motion, motionLine: st.motionLine, feed: st.feed, rpm: st.rpm, abs: st.abs, lcyc: st.lcyc };
    const pts = [[st.phys[0], st.phys[2]]];
    const realPush = segs.push;
    const cb = compBuf;
    compBuf = null;
    segs.push = (a, b) => { pts.push([b[2], b[0]]); };
    const before = issues.length;
    for (let i = ns; i <= nf; i++) runLine(i);
    issues.length = before;
    segs.push = realPush;
    compBuf = cb;
    Object.assign(st, saved);
    const o = offs();
    return pts.map(([x, z]) => [x - o[0], z - o[2]]);
  }

  // ------------------------------------------------ cutter compensation
  function setComp(lineG, w, li) {
    const c = lineG.comp;
    if (c === 40) {
      st.comp = 40;
      if (compBuf) { compBuf.cancelPending = true; compBuf.cancelLine = li; }
      return;
    }
    if (isLathe) { addOnce('tnr', li, 'info', 'Tool-nose radius compensation (G41/G42) is not simulated on the lathe'); return; }
    if (isLaser || isPrinter) { addOnce('kerf', li, 'info', 'Kerf compensation (G41/G42) is not simulated'); return; }
    usesComp = true;
    features.add('cutterComp');
    let dia;
    if (c === 41.1 || c === 42.1) dia = (w.D ?? 0) * st.scale;
    else {
      const tn = w.D !== undefined ? Math.round(w.D) : st.tool;
      if (w.D === undefined) add(li, 'warning', `G${Math.floor(c)} cutter compensation without a D offset number (using T${st.tool})`);
      dia = opts.toolDia?.(tn) ?? opts.toolDia?.(st.tool);
    }
    if (!(dia > 0)) { add(li, 'warning', 'Cutter compensation radius unknown (set the tool diameter in Tools); the path is drawn uncompensated'); return; }
    if (lineG.motion === 2 || lineG.motion === 3) add(li, 'warning', 'Cutter compensation should be turned on with a G0/G1 move, not an arc');
    const det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
    const side = (Math.floor(c) === 41 ? 1 : -1) * (det < 0 ? -1 : 1);
    if (compBuf) flushComp();
    compBuf = { items: [], r: dia / 2, side, start: li };
    st.comp = c;
  }

  function flushComp() {
    const cb = compBuf;
    if (!cb) return;
    compBuf = null;
    const items = cb.items;
    if (!items.length) return;
    const r = cb.r, side = cb.side;
    const cancel = !!cb.cancelPending && items[items.length - 1].li === cb.cancelLine;
    const dirOf = (it) => {
      const dx = it.b[0] - it.a[0], dy = it.b[1] - it.a[1];
      const L = Math.hypot(dx, dy);
      return L < 1e-9 ? null : [dx / L, dy / L, L];
    };
    const nrm = (d) => [-d[1] * side, d[0] * side];
    const dirs = items.map(dirOf);
    const emitIt = (it, a, b, type = it.type) => {
      const save = { feed: st.feed, feedMode: st.feedMode, tool: st.tool, rpm: st.rpm, dir: st.dir };
      Object.assign(st, { feed: it.feed, feedMode: it.fmode, tool: it.tool, rpm: it.rpm, dir: it.dir });
      emitRaw(a, b, it.ra, it.rb, type, it.code, it.li);
      Object.assign(st, save);
    };
    const nextDir = (i) => { for (let k = i; k < dirs.length; k++) if (dirs[k]) return dirs[k]; return null; };
    let cur = items[0].a.slice();
    let pend = null;
    let prevD = null;
    let gouged = false;
    const flushPend = () => { if (pend) { emitIt(pend.it, pend.a, pend.b); cur = pend.b.slice(); pend = null; } };
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const d = dirs[i];
      const last = i === items.length - 1;
      if (i === 0) {
        const nd = nextDir(1) || d;
        if (!nd) { emitIt(it, cur, it.b); cur = it.b.slice(); continue; }
        const n = nrm(nd);
        const to = [it.b[0] + r * n[0], it.b[1] + r * n[1], it.b[2]];
        emitIt(it, cur, to);
        cur = to;
        prevD = nd;
        continue;
      }
      if (last && cancel) { flushPend(); emitIt(it, cur, it.b); cur = it.b.slice(); break; }
      if (!d) { flushPend(); const to = [cur[0], cur[1], it.b[2]]; emitIt(it, cur, to); cur = to; continue; }
      const n = nrm(d);
      const sOff = [it.a[0] + r * n[0], it.a[1] + r * n[1], it.a[2]];
      const eOff = [it.b[0] + r * n[0], it.b[1] + r * n[1], it.b[2]];
      const startPt = pend ? pend.b : cur;
      if (prevD && Math.hypot(startPt[0] - sOff[0], startPt[1] - sOff[1]) > 1e-7) {
        const cross = prevD[0] * d[1] - prevD[1] * d[0];
        if (cross * side > 1e-12) {
          // inside corner: trim to the intersection of the two offset lines
          const p0 = pend ? pend.a : startPt;
          const d0 = prevD;
          const den = d0[0] * d[1] - d0[1] * d[0];
          const tt = ((sOff[0] - p0[0]) * d[1] - (sOff[1] - p0[1]) * d[0]) / den;
          const uu = ((sOff[0] - p0[0]) * d0[1] - (sOff[1] - p0[1]) * d0[0]) / den;
          const X = [p0[0] + tt * d0[0], p0[1] + tt * d0[1]];
          const prevLen = pend ? Math.hypot(pend.b[0] - pend.a[0], pend.b[1] - pend.a[1]) : Infinity;
          if (tt < -1e-6 || tt > prevLen + 1e-6 || -uu > d[2] + 1e-6) {
            if (!gouged) add(it.li, 'warning', `Cutter compensation gouges here: the tool radius ${fmt(r / st.scale)} is bigger than this inside corner or arc`);
            gouged = true;
          }
          if (pend) { pend.b = [X[0], X[1], pend.b[2]]; flushPend(); }
          else { const to = [X[0], X[1], cur[2]]; emitIt(it, cur, to); cur = to; }
          pend = { it, a: [X[0], X[1], sOff[2]], b: eOff };
        } else {
          flushPend();
          // outside corner: arc around the programmed corner point
          const v = it.a;
          const a0 = Math.atan2(cur[1] - v[1], cur[0] - v[0]);
          const a1 = Math.atan2(sOff[1] - v[1], sOff[0] - v[0]);
          let sweep = a1 - a0;
          if (side > 0) { while (sweep > 1e-12) sweep -= 2 * Math.PI; } else { while (sweep < -1e-12) sweep += 2 * Math.PI; }
          const n2 = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 18)));
          for (let k = 1; k <= n2; k++) {
            const ang = a0 + (sweep * k) / n2;
            const to = k === n2 ? [sOff[0], sOff[1], cur[2]] : [v[0] + r * Math.cos(ang), v[1] + r * Math.sin(ang), cur[2]];
            emitIt(it, cur, to, it.type === RAPID ? RAPID : ARC);
            cur = to;
          }
          pend = { it, a: [sOff[0], sOff[1], cur[2]], b: eOff };
        }
      } else {
        flushPend();
        pend = { it, a: sOff, b: eOff };
      }
      prevD = d;
    }
    flushPend();
    startOverride = cancel ? null : cur.slice();
  }
}

export function fmt(v, d = 4) {
  if (!Number.isFinite(v)) return String(v);
  return (+v.toFixed(d)).toString();
}
