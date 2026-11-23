// G-code parser for 3-axis mills and routers. Pure JavaScript, no DOM, so it
// also runs under Node for the tests.
//
// Output coordinates are always millimetres in the work coordinate system;
// the program's own units (G20/G21) are reported separately for display.

export const MM_PER_INCH = 25.4;

// Segment types
export const RAPID = 0;
export const FEED = 1;
export const ARC = 2;
export const DRILL = 3; // feed move inside a canned cycle

// Feed modes
export const FM_PER_MIN = 0; // G94
export const FM_PER_REV = 1; // G95
export const FM_INVERSE = 2; // G93

const key = (v) => Math.round(v * 10) / 10;

// ---------------------------------------------------------------- G groups
const G_GROUP = new Map();
const group = (name, codes) => codes.forEach((c) => G_GROUP.set(c, name));
group('motion', [0, 1, 2, 3, 38.2, 38.3, 38.4, 38.5, 73, 74, 76, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89]);
group('plane', [17, 18, 19]);
group('distance', [90, 91]);
group('arcDistance', [90.1, 91.1]);
group('feedMode', [93, 94, 95]);
group('units', [20, 21]);
group('comp', [40, 41, 42]);
group('length', [43, 43.1, 44, 49]);
group('retract', [98, 99]);
group('wcs', [54, 55, 56, 57, 58, 59, 54.1, 59.1, 59.2, 59.3]);
group('nonModal', [4, 9, 10, 28, 28.1, 30, 30.1, 52, 53, 92, 92.1, 92.2, 92.3]);
group('spindleMode', [96, 97]);
group('pathMode', [61, 61.1, 64]);
group('scale', [50, 51]);
group('mirror', [50.1, 51.1]);
group('rotation', [68, 69]);

// Controller-specific codes that are valid on common machines but have no
// effect on the drawn toolpath.
const IGNORED_G = new Set([5, 5.1, 5.2, 7.1, 8, 11, 12.1, 13.1, 15, 16, 47, 65, 66, 67, 100, 103, 107, 110, 150, 154, 187]);

const CYCLES = new Set([73, 74, 76, 81, 82, 83, 84, 85, 86, 87, 88, 89]);
const CYCLE_NEEDS_Q = new Set([73, 83]);

const KNOWN_M = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 19, 29, 30, 48, 49, 50, 51, 60, 88, 97, 98, 99]);
const M_GROUP = new Map([
  [0, 'stop'], [1, 'stop'], [2, 'stop'], [30, 'stop'], [60, 'stop'],
  [3, 'spindle'], [4, 'spindle'], [5, 'spindle'], [13, 'spindle'], [14, 'spindle'],
  [6, 'toolChange'],
]);

const G_DESCRIPTIONS = {
  0: 'Rapid', 1: 'Linear feed', 2: 'Arc CW', 3: 'Arc CCW', 73: 'Chip-break peck drill', 74: 'Left-hand tap',
  76: 'Fine bore', 81: 'Drill', 82: 'Spot drill (dwell)', 83: 'Peck drill', 84: 'Tap', 85: 'Bore (feed out)',
  86: 'Bore (rapid out)', 87: 'Back bore', 88: 'Bore (manual out)', 89: 'Bore (dwell, feed out)',
};
export const describeG = (c) => G_DESCRIPTIONS[c] || `G${c}`;

// ------------------------------------------------------------ segment store
class SegBuf {
  constructor(cap = 4096) {
    this.n = 0;
    this.grow(cap);
  }
  grow(cap) {
    const old = this;
    const next = {
      p: new Float64Array(cap * 6), type: new Uint8Array(cap), code: new Uint8Array(cap),
      line: new Int32Array(cap), tool: new Int32Array(cap), feed: new Float32Array(cap),
      fmode: new Uint8Array(cap), rpm: new Float32Array(cap), dwell: new Float32Array(cap),
    };
    if (old.p) {
      next.p.set(old.p.subarray(0, old.n * 6));
      for (const k of ['type', 'code', 'line', 'tool', 'feed', 'fmode', 'rpm', 'dwell']) next[k].set(old[k].subarray(0, old.n));
    }
    Object.assign(this, next);
    this.cap = cap;
  }
  push(a, b, type, code, line, tool, feed, fmode, rpm, dwell) {
    if (this.n === this.cap) this.grow(this.cap * 2);
    const i = this.n++;
    const o = i * 6;
    this.p[o] = a[0]; this.p[o + 1] = a[1]; this.p[o + 2] = a[2];
    this.p[o + 3] = b[0]; this.p[o + 4] = b[1]; this.p[o + 5] = b[2];
    this.type[i] = type; this.code[i] = code; this.line[i] = line; this.tool[i] = tool;
    this.feed[i] = feed; this.fmode[i] = fmode; this.rpm[i] = rpm; this.dwell[i] = dwell;
  }
  done() {
    const n = this.n;
    const out = { n, p: this.p.slice(0, n * 6) };
    for (const k of ['type', 'code', 'line', 'tool', 'feed', 'fmode', 'rpm', 'dwell']) out[k] = this[k].slice(0, n);
    return out;
  }
}

// ---------------------------------------------------------------- tokenizer
const NUM = /[+-]?(?:\d+\.?\d*|\.\d+)/y;

export function tokenizeLine(s) {
  const r = { words: [], comments: [], errors: [], macro: false, blockDelete: false };
  let i = 0;
  const n = s.length;
  while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
  if (s[i] === '/') { r.blockDelete = true; i++; }
  while (i < n) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '%') { i++; continue; }
    if (c === '(') {
      const j = s.indexOf(')', i + 1);
      if (j < 0) { r.errors.push('Comment "(" is never closed with ")"'); r.comments.push(s.slice(i + 1)); break; }
      r.comments.push(s.slice(i + 1, j));
      i = j + 1;
      continue;
    }
    if (c === ';') { r.comments.push(s.slice(i + 1)); break; }
    if (c === '#' || c === '[' || c === '<') { r.macro = true; break; }
    if (c === ')') { r.errors.push('")" has no matching "("'); i++; continue; }
    let L = c.toUpperCase();
    if (c === ':') L = 'O';
    if (L >= 'A' && L <= 'Z') {
      i++;
      while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
      if (s[i] === '#' || s[i] === '[') { r.macro = true; break; }
      NUM.lastIndex = i;
      const m = NUM.exec(s);
      if (!m) { r.errors.push(`"${L}" has no number after it`); continue; }
      r.words.push({ l: L, v: parseFloat(m[0]), raw: m[0] });
      i += m[0].length;
      continue;
    }
    r.errors.push(`Unexpected character "${c}"`);
    i++;
  }
  return r;
}

// ------------------------------------------------------------------ parser
/**
 * Parse a G-code program.
 * @param {string} text
 * @param {{defaultUnits?: 'mm'|'in', arcTolerance?: number}} opts
 */
export function parseGcode(text, opts = {}) {
  const lines = text.split(/\r\n|\n|\r/);
  const issues = [];
  const onceKeys = new Set();
  const add = (line, sev, msg) => issues.push({ line, sev, msg });
  const addOnce = (k, line, sev, msg) => { if (!onceKeys.has(k)) { onceKeys.add(k); add(line, sev, msg); } };

  const segs = new SegBuf();
  const toolHints = new Map(); // T -> [{line, text}]
  const toolOrder = [];
  const noteTool = (t) => { if (!toolOrder.includes(t)) toolOrder.push(t); };
  const arcTol = opts.arcTolerance ?? 0.005;

  const st = {
    motion: null, plane: 17, abs: true, arcAbs: false, feedMode: FM_PER_MIN,
    units: null, scale: opts.defaultUnits === 'in' ? MM_PER_INCH : 1,
    comp: 40, retract: 98,
    pos: [null, null, null], off: [0, 0, 0], g52: [0, 0, 0],
    feed: 0, rpm: 0, sSet: false, dir: 0,
    tool: 0, next: null,
    cyc: { R: null, Z: null, Q: null, P: 0, initZ: null, incR: null, incZ: null },
    ended: false,
  };
  let toolChanges = 0;
  let dwellPending = 0;
  let dwellTotal = 0;
  let usedG43 = false;
  let g43SinceChange = true;
  const missingG43 = [];
  let lastToolChangeLine = -10;
  let lineHasMotion = false;
  let lastCodeLine = 0;
  let firstMotionLine = -1;
  let endLine = -1;
  const wcsUsed = new Set();

  const offset = (k) => st.off[k] + st.g52[k];
  const known = (p) => p[0] !== null && p[1] !== null && p[2] !== null;

  const emit = (a, b, type, code, li) => {
    const d = dwellPending;
    dwellPending = 0;
    segs.push(a, b, type, code, li, st.tool, st.feed, st.feedMode, st.dir * st.rpm, d);
  };

  // Straight move; skipped (not drawn) while any axis of the start is unknown.
  const move = (to, type, code, li) => {
    const from = st.pos;
    if (known(from) && known(to)) {
      if (from[0] !== to[0] || from[1] !== to[1] || from[2] !== to[2] || dwellPending) emit(from, to, type, code, li);
    } else if (type !== RAPID) {
      addOnce('unknownStart', li, 'warning', 'Cutting move starts from an unknown position (no earlier G0 to a full X Y Z point); it is not drawn');
    }
    st.pos = to.slice();
  };

  // Subprogram labels (O1234 or :1234 at the start of a line).
  const subs = new Map();
  lines.forEach((l, i) => {
    const m = /^\s*(?:N\d+\s*)?[O:]\s*(\d+)/i.exec(l);
    if (m && !subs.has(+m[1])) subs.set(+m[1], i);
  });
  let mainNumber = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*[O:]\s*(\d+)/i.exec(lines[i]);
    if (m) { mainNumber = +m[1]; break; }
    if (/^\s*[A-NP-Z]/i.test(lines[i].replace(/\(.*?\)|;.*$/g, ''))) break;
  }

  // Run the program, following M98 subprogram calls and M99 returns.
  const stack = [];
  let pc = 0;
  let steps = 0;
  while (pc < lines.length) {
    if (++steps > 5e6) {
      add(pc, 'error', 'Program runs more than 5 million lines; stopped (endless subprogram loop?)');
      break;
    }
    const lab = /^\s*(?:N\d+\s*)?[O:]\s*(\d+)/i.exec(lines[pc]);
    if (lab && !stack.length && +lab[1] !== mainNumber && segs.n > 0) {
      add(pc, 'warning', `The main program runs into subprogram O${lab[1]} — add M30 before the subprograms`);
      break;
    }
    const r = runLine(pc);
    if (r === 'end') break;
    if (r === 'ret') {
      if (!stack.length) {
        addOnce('m99main', pc, 'info', 'M99 in the main program restarts it on most controls; the viewer stops here');
        endLine = pc;
        break;
      }
      const fr = stack[stack.length - 1];
      if (fr.left > 0) { fr.left--; pc = fr.start; } else { stack.pop(); pc = fr.ret; }
      continue;
    }
    if (r && r.call !== undefined) {
      const target = subs.get(r.call);
      if (target === undefined) add(pc, 'warning', `Subprogram O${r.call} (M98 P${r.call}) is not in this file; the call is skipped`);
      else if (stack.length >= 16) add(pc, 'error', 'Subprograms nested more than 16 deep');
      else if (r.reps > 0) {
        stack.push({ ret: pc + 1, start: target + 1, left: r.reps - 1 });
        pc = target + 1;
        continue;
      }
    }
    pc++;
  }
  if (endLine >= 0) {
    for (let li = endLine + 1; li < lines.length; li++) {
      if (/^\s*(?:N\d+\s*)?[O:]\s*\d+/i.test(lines[li])) break; // subprograms follow
      const t = tokenizeLine(lines[li]);
      if (t.words.length) { add(li, 'warning', `Code after the program end (line ${endLine + 1}) will never run`); break; }
    }
  }

  function runLine(li) {
    const raw = lines[li];
    if (!raw || !raw.trim()) return;
    const t = tokenizeLine(raw);
    for (const e of t.errors) add(li, 'error', e);
    const commentText = t.comments.map((c) => c.trim()).filter(Boolean).join(' ');

    if (t.macro) {
      addOnce('macro', li, 'warning', 'Macro variables/expressions (#, [ ]) are not supported; those lines are skipped');
      return;
    }
    if (t.words.length) lastCodeLine = li;
    if (!t.words.length) {
      if (commentText) {
        const m = /(?:^|[^A-Z0-9])T\s*(\d+)\b/i.exec(commentText);
        if (m) hint(+m[1], li, commentText);
        else if (li - lastToolChangeLine <= 2 && st.tool && !toolHints.has(st.tool)) hint(st.tool, li, commentText);
      }
      return;
    }

    // ---- collect words
    let callReq = null;
    let retReq = false;
    const gs = [];
    const ms = [];
    const w = {};
    for (const word of t.words) {
      const L = word.l;
      if (L === 'G') gs.push(key(word.v));
      else if (L === 'M') ms.push(key(word.v));
      else if (L === 'N' || L === 'O') continue;
      else {
        if (w[L] !== undefined) add(li, 'error', `${L} appears twice on one line`);
        w[L] = word.v;
      }
    }

    // ---- validate G codes / modal groups
    const seen = new Map();
    const lineG = {};
    for (const c of gs) {
      const g = G_GROUP.get(c);
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
      if (!KNOWN_M.has(c)) addOnce('m' + c, li, 'info', `M${c} is machine-specific; the viewer ignores it`);
      const g = M_GROUP.get(c);
      if (g) {
        if (mSeen.has(g)) add(li, 'error', `M${mSeen.get(g)} and M${c} conflict on the same line`);
        mSeen.set(g, c);
      }
    }
    for (const L of ['A', 'B', 'C', 'U', 'V', 'W']) {
      if (w[L] !== undefined) addOnce('rot', li, 'warning', 'Rotary/extra axis words (A B C U V W) are ignored; this is a 3-axis view');
    }
    if (w.E !== undefined) addOnce('E', li, 'warning', '"E" words (3D-printer extrusion) are ignored');
    if (t.blockDelete) addOnce('blockDelete', li, 'info', 'Block-delete "/" lines are shown as if block delete is off');

    // ---- units first so the line's numbers are read in the right units
    if (lineG.units !== undefined) {
      const u = lineG.units === 20 ? 'in' : 'mm';
      if (st.units && st.units !== u) add(li, 'warning', `Units change from ${st.units} to ${u} mid-program`);
      if (!st.units && firstMotionLine >= 0) add(li, 'warning', 'Units (G20/G21) are set after the first move');
      st.units = u;
      st.scale = u === 'in' ? MM_PER_INCH : 1;
    }
    const sc = st.scale;

    // ---- feed mode, F, S, T
    if (lineG.feedMode !== undefined) st.feedMode = lineG.feedMode === 93 ? FM_INVERSE : lineG.feedMode === 95 ? FM_PER_REV : FM_PER_MIN;
    if (w.F !== undefined) {
      if (w.F < 0) add(li, 'error', 'Feed rate F cannot be negative');
      st.feed = st.feedMode === FM_INVERSE ? w.F : w.F * sc;
    } else if (st.feedMode === FM_INVERSE) {
      st.feed = 0; // inverse time feed is not modal
    }
    if (w.S !== undefined) {
      if (w.S < 0) add(li, 'error', 'Spindle speed S cannot be negative');
      st.rpm = Math.abs(w.S);
      st.sSet = true;
    }
    if (w.T !== undefined) {
      if (!Number.isInteger(w.T) || w.T < 0) add(li, 'error', `Tool number T${w.T} must be a whole number`);
      st.next = Math.round(w.T);
      noteTool(st.next);
      if (commentText) hint(st.next, li, commentText);
      if (!st.tool && !ms.includes(6)) st.tool = st.next; // routers without M6
    } else if (commentText) {
      const m = /(?:^|[^A-Z0-9])T\s*(\d+)\b/i.exec(commentText);
      if (m) hint(+m[1], li, commentText);
      else if (li - lastToolChangeLine <= 2 && st.tool && !toolHints.has(st.tool)) hint(st.tool, li, commentText);
    }

    // ---- tool change
    if (ms.includes(6)) {
      if (st.next === null) add(li, 'error', 'M6 tool change with no tool number (T)');
      else {
        st.tool = st.next;
        noteTool(st.tool);
      }
      toolChanges++;
      st.dir = 0; // controllers stop the spindle for a tool change
      g43SinceChange = false;
      lastToolChangeLine = li;
    }

    // ---- spindle, coolant
    for (const c of ms) {
      if (c === 3 || c === 4 || c === 13 || c === 14) {
        if (!st.sSet || st.rpm === 0) add(li, 'warning', `Spindle started (M${c}) with no speed (S)`);
        st.dir = c === 3 || c === 13 ? 1 : -1;
      } else if (c === 5) st.dir = 0;
      else if (c === 98) {
        if (w.P === undefined) add(li, 'error', 'M98 subprogram call without P (program number)');
        else callReq = { call: Math.round(w.P), reps: Math.round(w.L ?? w.K ?? 1) };
      } else if (c === 99) retReq = true;
    }

    // ---- dwell
    if (lineG.nonModal === 4) {
      const p = w.P ?? w.X;
      if (p === undefined) add(li, 'error', 'G4 dwell needs a time (P)');
      else {
        // Fanuc style: integer P is milliseconds; LinuxCNC/Grbl: seconds.
        const sec = w.P !== undefined && !/\./.test(String(t.words.find((x) => x.l === 'P')?.raw)) && p >= 100 ? p / 1000 : p;
        dwellPending += sec;
        dwellTotal += sec;
      }
    }

    // ---- modal settings
    if (lineG.plane !== undefined) st.plane = lineG.plane;
    if (lineG.distance !== undefined) st.abs = lineG.distance === 90;
    if (lineG.arcDistance !== undefined) st.arcAbs = lineG.arcDistance === 90.1;
    if (lineG.retract !== undefined) st.retract = lineG.retract;
    if (lineG.wcs !== undefined) {
      wcsUsed.add(lineG.wcs);
      if (wcsUsed.size === 2) addOnce('wcs', li, 'warning', 'More than one work offset (G54–G59) is used; the viewer draws them all on the same origin');
    }
    if (lineG.comp !== undefined) {
      st.comp = lineG.comp;
      if (lineG.comp !== 40) {
        addOnce('comp', li, 'info', 'Cutter compensation (G41/G42) is not simulated; the programmed path is drawn');
        if (w.D === undefined) add(li, 'warning', `G${lineG.comp} cutter compensation without a D offset number`);
        if (lineG.motion === 2 || lineG.motion === 3) add(li, 'warning', 'Cutter compensation should be turned on with a G0/G1 move, not an arc');
      }
    }
    if (lineG.length === 43 || lineG.length === 43.1) {
      usedG43 = true;
      g43SinceChange = true;
      if (w.H === undefined) add(li, 'warning', 'G43 tool length offset without H');
      else if (st.tool && w.H !== st.tool) add(li, 'warning', `G43 H${w.H} does not match the active tool T${st.tool}`);
    }
    if (lineG.scale === 51 || lineG.mirror === 51.1 || lineG.rotation === 68) {
      addOnce('xform' + li, li, 'warning', 'Scaling/mirroring/rotation is not simulated');
    }
    if (lineG.spindleMode === 96) addOnce('css', li, 'info', 'G96 constant surface speed is a lathe feature; S is read as rpm');

    // ---- work-offset style non-modal codes that consume axis words
    const nm = lineG.nonModal;
    const hasAxis = w.X !== undefined || w.Y !== undefined || w.Z !== undefined;
    let axesUsed = false;
    if (nm === 92) {
      axesUsed = true;
      ['X', 'Y', 'Z'].forEach((L, k) => {
        if (w[L] === undefined) return;
        if (st.pos[k] === null) add(li, 'warning', `G92 sets ${L} while its position is unknown`);
        else st.off[k] = st.pos[k] - w[L] * sc - st.g52[k];
      });
    } else if (nm === 92.1 || nm === 92.2) {
      st.off = [0, 0, 0];
    } else if (nm === 52) {
      axesUsed = true;
      ['X', 'Y', 'Z'].forEach((L, k) => { if (w[L] !== undefined) st.g52[k] = w[L] * sc; });
    } else if (nm === 10) {
      axesUsed = true;
    } else if (nm === 28 || nm === 30) {
      axesUsed = true;
      const axes = hasAxis ? ['X', 'Y', 'Z'].map((L) => w[L] !== undefined) : [true, true, true];
      if (hasAxis) move(targetOf(w, li), RAPID, 0, li);
      const home = nm === 28 ? opts.home : opts.home2 || opts.home;
      if (home) {
        // home is given in work coordinates (Machine dynamics settings)
        const to = st.pos.slice();
        axes.forEach((on, k) => { if (on) to[k] = home[k]; });
        if (axes[2] && to[2] !== null && st.pos[2] !== null && to[2] > st.pos[2]) {
          move([st.pos[0], st.pos[1], to[2]], RAPID, 0, li); // controls lift Z first
        }
        move(to, RAPID, 0, li);
      } else {
        axes.forEach((on, k) => { if (on) st.pos[k] = null; });
        addOnce('g28', li, 'info', `G${nm} goes to machine home, whose position isn't known; the viewer resumes at the next full positioning move`);
      }
    } else if (nm === 53) {
      axesUsed = true;
      if (hasAxis) {
        ['X', 'Y', 'Z'].forEach((L, k) => { if (w[L] !== undefined) st.pos[k] = null; });
        addOnce('g53', li, 'info', 'G53 machine-coordinate moves can\'t be drawn (machine offsets unknown)');
      }
    }
    if (axesUsed && lineG.motion !== undefined && hasAxis) {
      add(li, 'error', `G${nm} and a motion code (G${lineG.motion}) both use the axis words on this line`);
    }

    // ---- motion
    if (lineG.motion !== undefined) {
      const m = lineG.motion;
      if (CYCLES.has(m) && !CYCLES.has(st.motion)) st.cyc.initZ = st.pos[2];
      if (!CYCLES.has(m)) st.cyc = { R: null, Z: null, Q: null, P: 0, initZ: null, incR: null, incZ: null };
      if (m >= 38 && m < 39) addOnce('probe', li, 'info', 'Probing moves (G38.x) are drawn as feed moves to the target');
      st.motion = m;
      st.motionLine = li;
    }
    lineHasMotion = lineG.motion !== undefined;
    const usesIJKR = w.I !== undefined || w.J !== undefined || w.K !== undefined || w.R !== undefined;
    if (!axesUsed && (hasAxis || (usesIJKR && (st.motion === 2 || st.motion === 3)))) {
      if (firstMotionLine < 0) {
        firstMotionLine = li;
        if (!st.units) {
          add(li, 'warning', `No units (G20 inch / G21 mm) set before the first move; assuming ${opts.defaultUnits === 'in' ? 'inches' : 'millimetres'}`);
          st.units = opts.defaultUnits === 'in' ? 'in' : 'mm';
        }
      }
      const m = st.motion;
      if (m === null) add(li, 'error', 'Axis words with no motion mode active (add G0 or G1)');
      else if (m === 80) add(li, 'error', 'Axis words while G80 (cancel cycle) is active; add G0 or G1');
      else if (m === 0) move(targetOf(w, li), RAPID, 0, li);
      else if (m === 1 || (m >= 38 && m < 39)) {
        checkFeed(li, w);
        trackG43(li);
        move(targetOf(w, li), FEED, 1, li);
      } else if (m === 2 || m === 3) {
        checkFeed(li, w);
        trackG43(li);
        arc(m, w, li);
      } else if (CYCLES.has(m)) {
        checkFeed(li, w);
        trackG43(li);
        cycle(m, w, li);
      }
    } else if (!axesUsed && usesIJKR && !CYCLES.has(st.motion) && !(st.motion === 2 || st.motion === 3)) {
      if (w.I !== undefined || w.J !== undefined || w.K !== undefined) add(li, 'warning', 'I/J/K given without an arc move; ignored');
    }

    // ---- program stop / end
    if (ms.includes(30) || ms.includes(2)) {
      st.ended = true;
      endLine = li;
      return 'end';
    }
    if (retReq) return 'ret';
    if (callReq) return callReq;
  }

  if (endLine < 0 && segs.n > 0) add(lastCodeLine, 'warning', 'Program has no end code (M30 or M2)');
  if (usedG43) for (const m of missingG43) add(m.line, 'warning', `No G43 tool length offset after the T${m.tool} tool change (other tools use G43)`);

  const seenIssue = new Set();
  return {
    segs: segs.done(),
    issues: issues.filter((i) => { const k = `${i.line}|${i.sev}|${i.msg}`; if (seenIssue.has(k)) return false; seenIssue.add(k); return true; }),
    units: st.units || (opts.defaultUnits === 'in' ? 'in' : 'mm'),
    lineCount: lines.length,
    toolHints,
    toolOrder,
    toolChanges,
    dwellTotal,
  };

  // ---------------------------------------------------------------- helpers
  function hint(tool, line, text) {
    if (!toolHints.has(tool)) toolHints.set(tool, []);
    const arr = toolHints.get(tool);
    if (!arr.some((h) => h.text === text)) arr.push({ line, text });
  }

  function trackG43(li) {
    if (!g43SinceChange && toolChanges > 0) {
      missingG43.push({ line: li, tool: st.tool });
      g43SinceChange = true; // report once per tool change
    }
  }

  function checkFeed(li, w) {
    if (st.feedMode === FM_INVERSE) {
      if (w.F === undefined) add(li, 'error', 'Inverse-time feed (G93) needs F on every feed move');
    } else if (!(st.feed > 0)) {
      add(li, 'error', `Feed move (G${st.motion}) with no feed rate (F)`);
    }
  }

  function targetOf(w, li) {
    const to = st.pos.slice();
    ['X', 'Y', 'Z'].forEach((L, k) => {
      if (w[L] === undefined) return;
      const v = w[L] * st.scale;
      if (st.abs) to[k] = v + offset(k);
      else if (st.pos[k] === null) {
        addOnce('incUnknown', li, 'warning', 'Incremental (G91) move from an unknown position');
        to[k] = null;
      } else to[k] = st.pos[k] + v;
    });
    return to;
  }

  function arc(m, w, li) {
    const sc = st.scale;
    // plane axes (a, b) and linear axis l
    const [a, b, l] = st.plane === 17 ? [0, 1, 2] : st.plane === 18 ? [2, 0, 1] : [1, 2, 0];
    const offL = ['I', 'J', 'K'];
    const from = st.pos;
    const to = targetOf(w, li);
    if (!known(from) || !known(to)) {
      add(li, 'error', 'Arc from or to an unknown position');
      st.pos = to;
      return;
    }
    const sa = from[a], sb = from[b], ea = to[a], eb = to[b];
    let ca, cb;
    if (w.R !== undefined) {
      let R = w.R * sc;
      const dx = ea - sa, dy = eb - sb;
      const d = Math.hypot(dx, dy);
      if (d < 1e-6) {
        add(li, 'error', 'R-format arc with the same start and end point (use I/J/K for a full circle)');
        st.pos = to;
        return;
      }
      const absR = Math.abs(R);
      if (absR < d / 2 - Math.max(0.005, d * 1e-4)) {
        add(li, 'error', `Arc radius R${fmt(w.R)} is too small to reach the end point (needs at least ${fmt(d / 2 / sc)})`);
        st.pos = to;
        return;
      }
      const h = Math.sqrt(Math.max(0, R * R - (d / 2) ** 2));
      const mx = (sa + ea) / 2, my = (sb + eb) / 2;
      const px = -dy / d, py = dx / d; // left of travel direction
      // CW with positive R: centre to the right; flip for CCW or negative R.
      let side = m === 2 ? -1 : 1;
      if (R < 0) side = -side;
      ca = mx + side * h * px;
      cb = my + side * h * py;
    } else {
      const ia = w[offL[a]], ib = w[offL[b]];
      if (ia === undefined && ib === undefined) {
        add(li, 'error', lineHasMotion
          ? `Arc (G${m}) needs I/J/K centre offsets or R`
          : `This move uses G${m} (arc) still active from line ${st.motionLine + 1}, but has no I/J/K or R — add G0 or G1`);
        st.pos = to;
        return;
      }
      const oa = (ia ?? 0) * sc, ob = (ib ?? 0) * sc;
      if (st.arcAbs) { ca = oa + offset(a); cb = ob + offset(b); }
      else { ca = sa + oa; cb = sb + ob; }
      const r1 = Math.hypot(sa - ca, sb - cb), r2 = Math.hypot(ea - ca, eb - cb);
      const diff = Math.abs(r1 - r2);
      if (diff > 0.05) add(li, 'error', `Arc end point is not on the circle: start radius ${fmt(r1 / sc)}, end radius ${fmt(r2 / sc)}`);
      else if (diff > 0.0125 && diff > r1 * 1e-3) add(li, 'warning', `Arc radius mismatch of ${fmt(diff / sc)} between start and end`);
      const outOfPlane = offL[l];
      if (w[outOfPlane] !== undefined && w[outOfPlane] !== 0) add(li, 'warning', `${outOfPlane} is not used for arcs in G${st.plane}`);
    }
    const r1 = Math.hypot(sa - ca, sb - cb), r2 = Math.hypot(ea - ca, eb - cb);
    if (r1 < 1e-6) {
      add(li, 'error', 'Arc has zero radius');
      st.pos = to;
      return;
    }
    const a0 = Math.atan2(sb - cb, sa - ca);
    const a1 = Math.atan2(eb - cb, ea - ca);
    let sweep;
    const full = Math.hypot(ea - sa, eb - sb) < 1e-4;
    if (full) sweep = 2 * Math.PI;
    else {
      sweep = m === 2 ? a0 - a1 : a1 - a0;
      while (sweep <= 0) sweep += 2 * Math.PI;
      while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;
    }
    if (w.P !== undefined && w.P > 1) sweep += 2 * Math.PI * (Math.round(w.P) - 1);
    const dir = m === 2 ? -1 : 1;
    const rMax = Math.max(r1, r2);
    const step = rMax > arcTol ? 2 * Math.acos(Math.max(-1, 1 - arcTol / rMax)) : Math.PI / 4;
    const n = Math.min(4000, Math.max(1, Math.ceil(sweep / Math.min(step, Math.PI / 18))));
    let prev = from.slice();
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
      emit(prev, p, ARC, m, li);
      prev = p;
    }
    st.pos = to.slice();
  }

  function cycle(m, w, li) {
    const sc = st.scale;
    const c = st.cyc;
    if (st.plane !== 17) addOnce('cyclePlane', li, 'warning', 'Canned cycles are only drawn in the G17 (XY) plane');
    if (st.pos[2] === null) {
      add(li, 'error', `Canned cycle G${m} started with an unknown Z position; position Z first`);
      return;
    }
    if (c.initZ === null) c.initZ = st.pos[2];
    if (w.Q !== undefined) c.Q = Math.abs(w.Q) * sc;
    if (w.P !== undefined) c.P = w.P >= 100 && !/\./.test(String(w.P)) ? w.P / 1000 : w.P;
    const reps = w.L ?? w.K;
    if (reps === 0) return; // L0/K0: store the cycle only

    let R, Z;
    if (st.abs) {
      if (w.R !== undefined) c.R = w.R * sc + offset(2);
      if (w.Z !== undefined) c.Z = w.Z * sc + offset(2);
      R = c.R;
      Z = c.Z;
    } else {
      if (w.R !== undefined) c.incR = w.R * sc;
      if (w.Z !== undefined) c.incZ = w.Z * sc;
      R = c.incR === null ? null : c.initZ + c.incR;
      Z = c.incZ === null || R === null ? null : R + c.incZ;
    }
    if (R === null || R === undefined) { add(li, 'error', `Canned cycle G${m} needs R (retract plane)`); return; }
    if (Z === null || Z === undefined) { add(li, 'error', `Canned cycle G${m} needs Z (hole bottom)`); return; }
    if (Z > R) { add(li, 'error', `Canned cycle bottom Z${fmt((Z - offset(2)) / sc)} is above the R plane R${fmt((R - offset(2)) / sc)}`); return; }
    if (CYCLE_NEEDS_Q.has(m) && !(c.Q > 0)) { add(li, 'error', `Peck cycle G${m} needs a peck depth Q greater than 0`); return; }
    if (c.initZ < R - 1e-6 && st.retract === 98) {
      addOnce('initBelowR' + li, li, 'warning', 'Initial Z is below the R plane; the tool retracts to R');
    }

    const count = st.abs ? 1 : Math.max(1, Math.round(reps ?? 1));
    for (let k = 0; k < count; k++) {
      // XY target
      const xy = st.pos.slice();
      ['X', 'Y'].forEach((L, i) => {
        if (w[L] === undefined) return;
        const v = w[L] * sc;
        xy[i] = st.abs ? v + offset(i) : xy[i] === null ? null : xy[i] + v;
      });
      if (st.pos[2] < R) move([st.pos[0], st.pos[1], R], RAPID, m, li);
      move([xy[0], xy[1], st.pos[2]], RAPID, m, li);
      if (!known(st.pos)) {
        add(li, 'error', 'Canned cycle hole at an unknown XY position');
        return;
      }
      move([xy[0], xy[1], R], RAPID, m, li);
      const x = xy[0], y = xy[1];
      const feedTo = (z) => { const to = [x, y, z]; emit(st.pos, to, DRILL, m, li); st.pos = to; };
      const rapidTo = (z) => { const to = [x, y, z]; if (to[2] !== st.pos[2]) emit(st.pos, to, RAPID, m, li); st.pos = to; };
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
        if (m === 84 || m === 74 || m === 85 || m === 89) feedTo(R);
        else rapidTo(R);
      }
      if (st.retract === 98 && c.initZ > R) rapidTo(c.initZ);
    }
  }
}

export function fmt(v, d = 4) {
  if (!Number.isFinite(v)) return String(v);
  return (+v.toFixed(d)).toString();
}
