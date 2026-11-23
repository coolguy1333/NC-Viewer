// Timing, statistics and geometric verification (crash / spindle / tool
// checks) for a parsed program. Pure JS (no DOM).
import { RAPID, FEED, ARC, DRILL, TRAVEL, FM_PER_MIN, FM_PER_REV, FM_INVERSE, fmt } from './gcode.js';
import { PLUNGE_ONLY, TOOL_TYPES, AXIAL_TOOLS } from './tools.js';
import { StockSim, LatheSim } from './sim.js';

const DEFAULT_FEED = 1000; // mm/min, used only for animation when F is missing

/**
 * Per-segment times (seconds) and cumulative time.
 * @param {object} segs
 * @param {number|{rapidXY:number, rapidZ:number, accXY?:number, accZ?:number, toolChange?:number}} m
 *   rapid rates in mm/min, accelerations in mm/s² (0 = instant), tool change in s
 */
export function computeTimes(segs, m) {
  if (typeof m === 'number') m = { rapidXY: m, rapidZ: m };
  const rXY = (m.rapidXY || 5000) / 60, rZ = (m.rapidZ || m.rapidXY || 5000) / 60; // mm/s
  const aXY = m.accXY || 0, aZ = m.accZ || 0, tc = m.toolChange || 0;
  const { n, p, type, feed, fmode, rpm, line, dwell, tool } = segs;
  const time = new Float32Array(n);
  const cum = new Float64Array(n + 1);
  const len = new Float32Array(n);
  const vmax = new Float32Array(n);
  const acc = new Float32Array(n);
  let incomplete = false;
  const invBlock = new Map();
  const dir = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    const dx = p[o + 3] - p[o], dy = p[o + 4] - p[o + 1], dz = p[o + 5] - p[o + 2];
    const L = Math.hypot(dx, dy, dz);
    len[i] = L;
    if (L > 0) { dir[i * 3] = dx / L; dir[i * 3 + 1] = dy / L; dir[i * 3 + 2] = dz / L; }
    const fxy = Math.hypot(dir[i * 3], dir[i * 3 + 1]), fz = Math.abs(dir[i * 3 + 2]);
    // axis-limited top speed along this direction
    const vAxis = Math.min(fxy > 1e-9 ? rXY / fxy : Infinity, fz > 1e-9 ? rZ / fz : Infinity);
    let v;
    if (type[i] === RAPID) v = vAxis;
    else if (fmode[i] === FM_INVERSE) { v = NaN; invBlock.set(line[i], (invBlock.get(line[i]) || 0) + L); }
    else if (fmode[i] === FM_PER_REV) v = (feed[i] * Math.abs(rpm[i])) / 60;
    else v = feed[i] / 60;
    if (!(v > 0) && fmode[i] !== FM_INVERSE) { incomplete = true; v = DEFAULT_FEED / 60; }
    vmax[i] = Math.min(v, vAxis);
    const a = Math.min(fxy > 1e-9 && aXY ? aXY / fxy : Infinity, fz > 1e-9 && aZ ? aZ / fz : Infinity);
    acc[i] = Number.isFinite(a) ? a : 0;
  }
  // Moves that continue in nearly the same direction at the same speed form
  // one chain that accelerates once and decelerates once.
  let i = 0;
  while (i < n) {
    if (fmode[i] === FM_INVERSE && type[i] !== RAPID) {
      const bl = invBlock.get(line[i]) || 1;
      time[i] = feed[i] > 0 ? (60 / feed[i]) * (len[i] / bl) : (incomplete = true, (len[i] / DEFAULT_FEED) * 60);
      i++;
      continue;
    }
    let j = i;
    let L = len[i], v = vmax[i], a = acc[i] || 0;
    while (j + 1 < n && (type[j + 1] === RAPID) === (type[i] === RAPID) && fmode[j + 1] !== FM_INVERSE && tool[j + 1] === tool[i]
      && Math.abs(vmax[j + 1] - vmax[i]) <= vmax[i] * 0.01 && !dwell[j + 1]
      && p[(j + 1) * 6] === p[j * 6 + 3] && p[(j + 1) * 6 + 1] === p[j * 6 + 4] && p[(j + 1) * 6 + 2] === p[j * 6 + 5]
      && dir[j * 3] * dir[(j + 1) * 3] + dir[j * 3 + 1] * dir[(j + 1) * 3 + 1] + dir[j * 3 + 2] * dir[(j + 1) * 3 + 2] > 0.94) {
      j++;
      L += len[j];
      v = Math.min(v, vmax[j]);
      if (acc[j]) a = a ? Math.min(a, acc[j]) : acc[j];
    }
    let t;
    if (L <= 0) t = 0;
    else if (!a) t = L / v;
    else if (L >= (v * v) / a) t = L / v + v / a;
    else t = 2 * Math.sqrt(L / a);
    for (let k = i; k <= j; k++) time[k] = L > 0 ? (t * len[k]) / L : 0;
    i = j + 1;
  }
  let changes = 0;
  for (let k = 0; k < n; k++) {
    if (k > 0 && tool[k] !== tool[k - 1]) { time[k] += tc; changes++; }
    time[k] += dwell[k];
    cum[k + 1] = cum[k] + time[k];
  }
  return { time, cum, len, incomplete, toolChangeTime: changes * tc };
}

/** Bounds, distances and per-tool numbers. */
export function computeStats(segs, times) {
  const { n, p, type, tool } = segs;
  const all = emptyBox(), cut = emptyBox();
  let rapidDist = 0, cutDist = 0, rapidTime = 0, cutTime = 0;
  const perTool = new Map();
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    const isRapid = type[i] === RAPID || type[i] === TRAVEL;
    grow(all, p, o); grow(all, p, o + 3);
    let pt = perTool.get(tool[i]);
    if (!pt) perTool.set(tool[i], (pt = { cutDist: 0, time: 0, minZ: Infinity, first: i }));
    pt.time += times.time[i];
    if (isRapid) { rapidDist += times.len[i]; rapidTime += times.time[i]; }
    else {
      grow(cut, p, o); grow(cut, p, o + 3);
      cutDist += times.len[i]; cutTime += times.time[i];
      pt.cutDist += times.len[i];
      pt.minZ = Math.min(pt.minZ, p[o + 2], p[o + 5]);
    }
  }
  const layers = new Set();
  for (let i = 0; i < n; i++) if (type[i] === FEED || type[i] === ARC) layers.add(Math.round(p[i * 6 + 5] * 1000));
  return { all, cut, rapidDist, cutDist, rapidTime, cutTime, total: times.cum[n] || 0, perTool, layers: layers.size };
}

function emptyBox() { return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }; }
function grow(b, p, o) {
  for (let k = 0; k < 3; k++) {
    const v = p[o + k];
    if (v < b.min[k]) b.min[k] = v;
    if (v > b.max[k]) b.max[k] = v;
  }
}
export const boxValid = (b) => b && Number.isFinite(b.min[0]);

/**
 * Geometric verification against the stock and tool library.
 * @param {object} segs parsed segments
 * @param {{x0,x1,y0,y1,z0,z1}|null} stock in mm
 * @param {Map<number, object>} tools
 * @param {{maxRpm:number, maxFeed:number}} machine maxFeed in mm/min
 * @param {(mm:number)=>string} show formats a length in program units
 */
function verifyMill(segs, stock, tools, machine, show = (v) => fmt(v), ctx = {}) {
  const issues = [];
  const counts = new Map();
  const CAP = 100;
  const add = (kind, line, sev, msg) => {
    const c = (counts.get(kind) || 0) + 1;
    counts.set(kind, c);
    if (c <= CAP) issues.push({ line, sev, msg });
  };
  const onceKeys = new Set();
  const once = (k, line, sev, msg) => { if (!onceKeys.has(k)) { onceKeys.add(k); issues.push({ line, sev, msg }); } };
  const lastLine = new Map(); // kind -> last line reported (one issue per line per kind)
  const perLine = (kind, line, sev, msg) => {
    if (lastLine.get(kind) === line) return;
    lastLine.set(kind, line);
    add(kind, line, sev, msg);
  };

  const { n, p, type, code, line, tool, feed, fmode, rpm } = segs;
  const getTool = (t) => tools.get(t);

  // Machine limits
  for (let i = 0; i < n; i++) {
    if (machine.maxRpm > 0 && Math.abs(rpm[i]) > machine.maxRpm + 0.5) perLine('rpm', line[i], 'warning', `Spindle speed S${Math.round(Math.abs(rpm[i]))} is above the machine maximum (${machine.maxRpm} rpm)`);
    if (machine.maxFeed > 0 && type[i] !== RAPID && fmode[i] === FM_PER_MIN && feed[i] > machine.maxFeed * 1.0001) perLine('feed', line[i], 'warning', `Feed rate ${show(feed[i])}/min is above the machine maximum (${show(machine.maxFeed)}/min)`);
  }

  // Tool sanity
  for (const [t, tl] of tools) {
    if (!(tl.dia > 0)) once('dia' + t, -1, 'error', `T${t} has no diameter; set it in the Tools panel`);
  }

  if (!stock || ctx.rotary) return finish();

  const sim = new StockSim(stock, 220);
  const deep = new Map(); // tool -> {depth, line}
  const below = new Map();
  const touched = new Set();
  let anyContact = false;
  const EPS = 0.02;

  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    if ((i & 32767) === 0 && i && Date.now() - t0 > 4000) {
      issues.push({ line: -1, sev: 'info', msg: `Crash checks stopped after ${Math.round((100 * i) / n)}% of the moves to keep the page responsive (very long program)` });
      break;
    }
    const tl = getTool(tool[i]);
    if (!tl || !(tl.dia > 0)) continue;
    const K = sim.kernel(tl);
    const o = i * 6;
    const x0 = p[o], y0 = p[o + 1], z0 = p[o + 2], x1 = p[o + 3], y1 = p[o + 4], z1 = p[o + 5];
    const rem = sim.cutSeg(x0, y0, z0, x1, y1, z1, K);
    if (rem <= EPS) continue;
    const li = line[i];
    const ty = type[i];
    const zMin = Math.min(z0, z1);
    touched.add(tool[i]);
    if (ty === RAPID) {
      perLine('rapid', li, 'error', `Rapid move (G0) cuts ${show(rem)} into material — crash risk`);
      continue;
    }
    anyContact = true;
    if (rpm[i] === 0) perLine('spindleOff', li, 'error', 'Cutting with the spindle off (no M3/M4 since the last M5/M6)');
    else if (rpm[i] < 0 && code[i] !== 74 && tl.type !== 'tap') once('rev' + tool[i], li, 'warning', `T${tool[i]} cuts with the spindle in reverse (M4)`);
    if (code[i] === 84 && rpm[i] < 0) perLine('g84rev', li, 'warning', 'G84 right-hand tapping with the spindle in reverse (M4)');

    const xyLen = Math.hypot(x1 - x0, y1 - y0);
    if (PLUNGE_ONLY.has(tl.type) && (ty === FEED || ty === ARC) && xyLen > 0.01) {
      perLine('sideways', li, 'error', `${TOOL_TYPES[tl.type].label} T${tool[i]} moves sideways while in material`);
    }
    if (tl.type === 'tap') {
      if (code[i] !== 84 && code[i] !== 74) once('tapNoCycle' + tool[i], li, 'warning', `Tap T${tool[i]} is used without a tapping cycle (G84/G74)`);
      else if (ty === DRILL && tl.pitch > 0) {
        const want = fmode[i] === FM_PER_REV ? tl.pitch : tl.pitch * Math.abs(rpm[i]);
        if (want > 0 && Math.abs(feed[i] - want) / want > 0.02) {
          perLine('tapFeed', li, 'error', `Tap feed ${show(feed[i])}${fmode[i] === FM_PER_REV ? '/rev' : '/min'} doesn't match pitch × rpm (should be ${show(want)}${fmode[i] === FM_PER_REV ? '/rev' : '/min'})`);
        }
      }
    } else if ((code[i] === 84 || code[i] === 74) && ty === DRILL) {
      once('cycleNotTap' + tool[i], li, 'warning', `Tapping cycle G${code[i]} used with T${tool[i]}, which is a ${TOOL_TYPES[tl.type].label.toLowerCase()} (set it to Tap in Tools)`);
    }

    const depth = stock.z1 - zMin;
    const d = deep.get(tool[i]);
    if (!d || depth > d.depth) deep.set(tool[i], { depth, line: li });
    if (zMin < stock.z0 - 0.01) {
      const b = below.get(tool[i]);
      if (!b || zMin < b.z) below.set(tool[i], { z: zMin, line: li });
    }
  }

  for (const [t, d] of deep) {
    const tl = getTool(t);
    if (d.depth > tl.stickout + 0.01) issues.push({ line: d.line, sev: 'error', msg: `T${t} goes ${show(d.depth)} deep but only sticks out ${show(tl.stickout)} — the holder hits the stock` });
    else if (d.depth > tl.flute + 0.01 && tl.type !== 'face') issues.push({ line: d.line, sev: 'warning', msg: `T${t} cuts ${show(d.depth)} deep but its flute length is ${show(tl.flute)} — the shank rubs` });
  }
  for (const [t, b] of below) {
    issues.push({ line: b.line, sev: 'warning', msg: `T${t} goes ${show(stock.z0 - b.z)} below the bottom of the stock (into the table/spoilboard)` });
  }
  if (n > 0 && !anyContact) issues.push({ line: -1, sev: 'warning', msg: 'No cutting move touches the stock — check the stock size and origin' });

  return finish();

  function finish() {
    for (const [kind, c] of counts) {
      if (c > CAP) issues.push({ line: -1, sev: 'info', msg: `…and ${c - CAP} more "${kind}" problems not listed` });
    }
    return issues;
  }
}

/**
 * Verification for the program's machine type.
 * @param {object} ctx {machine, rotary}
 */
export function verify(segs, stock, tools, machine, show = (v) => fmt(v), ctx = {}) {
  const m = ctx.machine || 'mill';
  if (m === 'lathe') return verifyLathe(segs, stock, tools, machine, show);
  if (m === 'laser') return verifySheet(segs, stock, tools, show, 'laser');
  if (m === 'printer') return verifySheet(segs, stock, tools, show, 'printer');
  return verifyMill(segs, stock, tools, machine, show, ctx);
}

function collector() {
  const issues = [];
  const counts = new Map();
  const seen = new Set();
  return {
    issues,
    add(kind, line, sev, msg, cap = 100) {
      const c = (counts.get(kind) || 0) + 1;
      counts.set(kind, c);
      if (c <= cap) issues.push({ line, sev, msg });
    },
    once(k, line, sev, msg) { if (!seen.has(k)) { seen.add(k); issues.push({ line, sev, msg }); } },
    perLine(kind, line, sev, msg) { this.once(kind + '@' + line, line, sev, msg); },
    finish() {
      for (const [kind, c] of counts) if (c > 100) issues.push({ line: -1, sev: 'info', msg: `…and ${c - 100} more "${kind}" problems not listed` });
      return issues;
    },
  };
}

/** Lathe kind of cut for a tool at a radius. */
export function latheKind(tool, x) {
  if (tool.type === 'boring') return 'id';
  if (AXIAL_TOOLS.has(tool.type) && Math.abs(x) <= (tool.dia || 1) / 2 + 1e-6) return 'axial';
  return 'od';
}

function verifyLathe(segs, stock, tools, machine, show) {
  const c = collector();
  const { n, p, type, line, tool, rpm } = segs;
  for (let i = 0; i < n; i++) {
    if (machine.maxRpm > 0 && Math.abs(rpm[i]) > machine.maxRpm + 0.5) c.perLine('rpm', line[i], 'warning', `Spindle speed ${Math.round(Math.abs(rpm[i]))} rpm is above the machine maximum (${machine.maxRpm} rpm)`);
  }
  if (!stock) return c.finish();
  const sim = new LatheSim(stock, 500);
  let contact = false;
  const deepest = new Map();
  for (let i = 0; i < n; i++) {
    const tl = tools.get(tool[i]);
    if (!tl) continue;
    const o = i * 6;
    const x0 = p[o + 2], z0 = p[o], x1 = p[o + 5], z1 = p[o + 3];
    if ((x0 < -0.01 || x1 < -0.01) && type[i] !== RAPID && !AXIAL_TOOLS.has(tl.type)) c.perLine('center', line[i], 'warning', `T${tool[i]} crosses the spindle centre line (X below 0)`);
    const kind = latheKind(tl, x1);
    const rem = sim.cutSeg(x0, z0, x1, z1, tl, kind);
    if (rem <= 0.02) continue;
    if (type[i] === RAPID) { c.perLine('rapid', line[i], 'error', `Rapid move (G0) cuts ${show(rem)} into the part — crash risk`); continue; }
    contact = true;
    if (rpm[i] === 0) c.perLine('spindleOff', line[i], 'error', 'Cutting with the spindle off (no M3/M4)');
    if (kind !== 'axial') {
      const d = deepest.get(tool[i]) ?? Infinity;
      deepest.set(tool[i], Math.min(d, Math.min(x0, x1)));
    }
  }
  if (n && !contact) c.once('nocontact', -1, 'warning', 'No cutting move touches the stock — check the bar diameter, length and Z zero');
  return c.finish();
}

function verifySheet(segs, stock, tools, show, kind) {
  const c = collector();
  const { n, p, type, line } = segs;
  if (!n) return c.finish();
  let extrudes = 0;
  let firstLayer = null;
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    const cutting = type[i] === FEED || type[i] === ARC;
    if (cutting) extrudes++;
    if (kind === 'printer' && cutting && firstLayer === null) firstLayer = { z: Math.min(p[o + 2], p[o + 5]), line: line[i] };
    if (!stock) continue;
    for (const k of [0, 3]) {
      const x = p[o + k], y = p[o + k + 1], z = p[o + k + 2];
      const outXY = x < stock.x0 - 0.01 || x > stock.x1 + 0.01 || y < stock.y0 - 0.01 || y > stock.y1 + 0.01;
      if (kind === 'laser' && cutting && outXY) c.perLine('outside', line[i], 'warning', 'Cut runs off the edge of the sheet');
      if (kind === 'printer' && (outXY || z > stock.z1 + 0.01 || z < stock.z0 - 0.01)) c.perLine('bed', line[i], 'warning', `Move goes outside the build volume (X ${fmt(x, 2)} Y ${fmt(y, 2)} Z ${fmt(z, 2)})`);
      if (kind === 'printer' && cutting && z < stock.z0 - 0.001) c.perLine('below', line[i], 'error', 'Extruding below the bed — the nozzle crashes into it');
    }
  }
  if (kind === 'printer') {
    if (!extrudes) c.once('noext', -1, 'warning', 'No extrusion found (no G1 moves with a rising E value)');
    if (firstLayer && stock && (firstLayer.z - stock.z0 > 0.6 || firstLayer.z - stock.z0 < 0.04)) c.once('first', firstLayer.line, 'warning', `First layer is at Z ${fmt(firstLayer.z - stock.z0, 3)} mm — usually 0.1–0.4 mm`);
  } else if (!extrudes) c.once('nocut', -1, 'warning', 'Nothing is cut: the laser/torch is never on during a feed move (M3/M4 with S above 0)');
  return c.finish();
}

/** Index of the last segment at or before each line (−1 if none). */
export function lineIndex(segs, lineCount) {
  const out = new Int32Array(lineCount).fill(-1);
  for (let i = 0; i < segs.n; i++) out[segs.line[i]] = i;
  let last = -1;
  for (let l = 0; l < lineCount; l++) {
    if (out[l] >= 0) last = out[l];
    else out[l] = last;
  }
  return out;
}

export function formatTime(sec) {
  if (!Number.isFinite(sec)) return '—';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
