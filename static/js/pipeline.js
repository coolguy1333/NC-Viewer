// Parse → tools → timing → verification, with no DOM or three.js, so the same
// code runs on the page (small programs) or in a Web Worker (big programs).
import { parseGcode, MM_PER_INCH } from './gcode.js';
import { toolFromHints, TOOL_TYPES } from './tools.js';
import { computeTimes, computeStats, verify, lineIndex } from './analyze.js';

/** Stock box (mm, display frame) for mills, lasers and printers. */
export function stockBox(s, machine) {
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
  if (machine === 'mill' && s.shape === 'round') return { x0, x1: x0 + X, y0: -Y / 2, y1: Y / 2, z0: -Y / 2, z1: Y / 2, round: true, r: Y / 2 };
  if (s.originZ === 'bottom') z0 = 0;
  else if (s.originZ === 'custom') z0 = (+s.oz || 0) * u;
  return { x0, x1: x0 + X, y0, y1: y0 + Y, z0, z1: z0 + Z };
}

/** Lathe bar in lathe coordinates (mm): radius, bore radius, z range. */
export function latheStock(s) {
  const u = s.units === 'in' ? MM_PER_INCH : 1;
  const L = Math.max(+s.z || 0, 0.001) * u;
  let z0 = -L;
  if (s.originZ === 'bottom') z0 = 0;
  else if (s.originZ === 'custom') z0 = (+s.oz || 0) * u;
  return { r: (Math.max(+s.x || 0, 0.001) * u) / 2, rIn: (Math.max(+s.y || 0, 0) * u) / 2, z0, z1: z0 + L };
}

const fmtN = (v, d) => (+v.toFixed(d)).toString();

/** Tool table from the program's comments plus the user's edits. */
export function buildTools(prog, toolEdits) {
  const ids = new Set(prog.toolOrder);
  for (let i = 0; i < prog.segs.n; i++) ids.add(prog.segs.tool[i]);
  const tools = new Map();
  const keys = new Map();
  const issues = [];
  const s = prog.units === 'in' ? MM_PER_INCH : 1;
  for (const t of [...ids].sort((a, b) => a - b)) {
    const hints = prog.toolHints.get(t);
    const detected = toolFromHints(hints, prog.units, prog.machine);
    const key = `${prog.machine}|${t}|${detected.source}`;
    keys.set(t, key);
    const edit = toolEdits[key];
    tools.set(t, edit ? { ...detected, ...edit, edited: true } : detected);
    if (!edit && detected.guessed && prog.segs.tool.includes(t)) {
      let line = hints?.[0]?.line;
      if (line === undefined) { line = -1; for (let i = 0; i < prog.segs.n; i++) if (prog.segs.tool[i] === t) { line = prog.segs.line[i]; break; } }
      issues.push({ line, sev: 'info', msg: `T${t} has no ${hints ? 'size' : 'description'} in the program; assuming ${TOOL_TYPES[detected.type].label.toLowerCase()} Ø${fmtN(detected.dia / s, s === 1 ? 3 : 4)} ${prog.units} — set it in Tools` });
    }
  }
  return { tools, keys, issues };
}

/**
 * Everything the page needs from a program.
 * cfg: { defaultUnits, machineKind, home, dynamics, limits:{maxRpm,maxFeed}, stocks, toolEdits, toolDia? }
 */
export function analyzeText(text, cfg) {
  const opts = { defaultUnits: cfg.defaultUnits, home: cfg.home, machine: cfg.machineKind, maxMoves: cfg.maxMoves, timeBudget: cfg.timeBudget };
  let prog = parseGcode(text, opts);
  let tt = buildTools(prog, cfg.toolEdits);
  if (prog.usesComp && !prog.truncated) {
    // cutter compensation needs tool diameters: parse again with the tool table
    prog = parseGcode(text, { ...opts, toolDia: (t) => tt.tools.get(t)?.dia });
    tt = buildTools(prog, cfg.toolEdits);
  }
  const times = computeTimes(prog.segs, cfg.dynamics);
  const stats = computeStats(prog.segs, times);
  const lineIdx = lineIndex(prog.segs, prog.lineCount);
  const geo = verifyProgram(prog, tt.tools, cfg);
  return { prog, tools: tt.tools, toolKeys: tt.keys, toolIssues: tt.issues, times, stats, lineIdx, geo };
}

export function stockFor(prog, cfg) {
  const s = cfg.stocks[prog.machine];
  return prog.machine === 'lathe' ? latheStock(s) : stockBox(s, prog.machine);
}

export function verifyProgram(prog, tools, cfg, show) {
  const unit = prog.units === 'in' ? MM_PER_INCH : 1;
  const sh = show || ((mm) => `${fmtN(mm / unit, unit === 1 ? 3 : 4)} ${prog.units}`);
  const round = prog.machine === 'mill' && cfg.stocks.mill.shape === 'round';
  return verify(prog.segs, stockFor(prog, cfg), tools, cfg.limits, sh, { machine: prog.machine, rotary: prog.rotary || round });
}
