// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGcode, tokenizeLine, detectMachine, RAPID, FEED, ARC, DRILL, TRAVEL } from '../static/js/gcode.js';
import { parseToolComment, toolFromHints, defaultTool, profileAt } from '../static/js/tools.js';
import { LatheSim } from '../static/js/sim.js';
import { computeTimes, computeStats, verify } from '../static/js/analyze.js';
import { DEMOS } from '../static/js/demos.js';

const SAMPLE = DEMOS.find((d) => d.id === 'bracket').text;

const STOCK = { x0: 0, x1: 100, y0: 0, y1: 80, z0: -12, z1: 0 };
const MACHINE = { maxRpm: 24000, maxFeed: 10000 };

function run(text, stock = STOCK, opts = {}) {
  const prog = parseGcode(text, opts);
  const tools = new Map();
  for (const t of new Set([...prog.toolOrder, ...prog.segs.tool])) tools.set(t, toolFromHints(prog.toolHints.get(t), prog.units));
  const issues = [...prog.issues, ...verify(prog.segs, stock, tools, MACHINE, undefined, { machine: prog.machine })];
  return { prog, tools, issues, msgs: issues.map((i) => `${i.sev}@${i.line + 1}: ${i.msg}`) };
}
const has = (r, sev, re) => r.issues.some((i) => i.sev === sev && re.test(i.msg));
const endOf = (segs, i) => [...segs.p.slice(i * 6 + 3, i * 6 + 6)];
const near = (a, b, eps = 1e-6) => a.every((v, k) => Math.abs(v - b[k]) < eps);

test('sample program verifies clean and finds all 7 tools', () => {
  const r = run(SAMPLE);
  assert.deepEqual(r.issues.filter((i) => i.sev !== 'info'), [], r.msgs.join('\n'));
  assert.deepEqual([...r.tools.keys()].sort(), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(r.tools.get(1).type, 'face');
  assert.equal(r.tools.get(3).type, 'drill');
  assert.equal(r.tools.get(4).type, 'tap');
  assert.equal(r.tools.get(4).pitch, 1);
  assert.equal(r.tools.get(6).type, 'ball');
  assert.equal(r.tools.get(7).angle, 90);
});

test('tokenizer: comments, spaces, lowercase, errors', () => {
  const t = tokenizeLine('n10 g 01 x1.5 Y-.25 (cut) ; tail');
  assert.deepEqual(t.words.map((w) => w.l + w.v), ['N10', 'G1', 'X1.5', 'Y-0.25']);
  assert.deepEqual(t.comments, ['cut', ' tail']);
  assert.ok(tokenizeLine('G1 X').errors.length);
  assert.ok(tokenizeLine('G1 (open').errors.length);
  assert.ok(tokenizeLine('G1 X#1').macro);
});

test('inch program is converted to mm', () => {
  const r = run('G20 G90\nG0 X0 Y0 Z1\nG0 X1 Y2 Z0.5\nM30');
  assert.equal(r.prog.units, 'in');
  assert.ok(near(endOf(r.prog.segs, 0), [25.4, 50.8, 12.7]));
});

test('incremental moves', () => {
  const r = run('G21 G90 G0 X10 Y10 Z5\nG91 G0 X5 Y-2 Z-1\nM30');
  assert.ok(near(endOf(r.prog.segs, 0), [15, 8, 4]));
});

test('IJK arcs: quarter and full circle', () => {
  const r = run('G21 G90 G17\nG0 X10 Y0 Z5\nM3 S1000\nG2 X0 Y-10 I-10 J0 F100\nG3 X0 Y-10 I0 J10\nM30');
  const segs = r.prog.segs;
  const arcs = [...segs.type].map((t, i) => i).filter((i) => segs.type[i] === ARC);
  // all arc points on the circle of radius 10 around the origin
  for (const i of arcs) {
    const [x, y] = endOf(segs, i);
    assert.ok(Math.abs(Math.hypot(x, y) - 10) < 1e-6);
  }
  // quarter (CW from +X to -Y) passes through x>0,y<0 only
  const q = arcs.filter((i) => segs.line[i] === 3);
  for (const i of q) { const [x, y] = endOf(segs, i); assert.ok(x >= -1e-9 && y <= 1e-9); }
  // full circle covers all four quadrants
  const f = arcs.filter((i) => segs.line[i] === 4).map((i) => endOf(segs, i));
  assert.ok(f.some(([x, y]) => x > 5 && y > 0) && f.some(([x, y]) => x < -5));
  assert.ok(!r.issues.some((i) => i.sev === 'error'), r.msgs.join('\n'));
});

test('R-format arcs pick the right centre', () => {
  // CW from (0,0) to (20,0) with R10 is a half circle over the top (y >= 0)
  const r = run('G21 G90\nG0 X0 Y0 Z5\nG2 X20 Y0 R10 F100\nM30');
  const segs = r.prog.segs;
  for (let i = 0; i < segs.n; i++) if (segs.type[i] === ARC) assert.ok(segs.p[i * 6 + 4] >= -1e-9);
  // negative R gives the long way round
  const r2 = run('G21 G90\nG0 X0 Y0 Z5\nG3 X10 Y10 R-10 F100\nM30');
  const s2 = r2.prog.segs;
  let minY = Infinity;
  for (let i = 0; i < s2.n; i++) if (s2.type[i] === ARC) minY = Math.min(minY, s2.p[i * 6 + 4]);
  assert.ok(minY < -9, 'long arc dips below y=0');
});

test('arc radius mismatch and missing centre are errors', () => {
  assert.ok(has(run('G21 G90\nG0 X10 Y0 Z5\nG2 X0 Y-12 I-10 J0 F100\nM30'), 'error', /not on the circle/));
  assert.ok(has(run('G21 G90\nG0 X10 Y0 Z5\nG2 X0 Y-10 F100\nM30'), 'error', /needs I\/J\/K/));
  assert.ok(has(run('G21 G90\nG0 X0 Y0 Z5\nG2 X0 Y0 R5 F100\nM30'), 'error', /same start and end/));
});

test('canned cycles expand into pecks and retract to the initial plane (G98)', () => {
  const r = run('G21 G90\nT1 M6 (T1 5MM DRILL)\nS2000 M3\nG0 X10 Y10 Z20\nG98 G83 X10 Y10 Z-6 R2 Q2 F100\nX20\nG80\nM30');
  const segs = r.prog.segs;
  const drills = [...segs.type].filter((t) => t === DRILL).length;
  assert.equal(drills, 8); // pecks from R2 to Z-6 at Q2 = 4 per hole x 2 holes
  // after the first hole the tool is back at Z20
  const lastOfHole1 = [...segs.line].lastIndexOf(4);
  assert.equal(segs.p[lastOfHole1 * 6 + 5], 20);
  // the deepest point is the Z word
  let minZ = Infinity;
  for (let i = 0; i < segs.n; i++) minZ = Math.min(minZ, segs.p[i * 6 + 5]);
  assert.equal(minZ, -6);
});

test('canned cycle errors', () => {
  assert.ok(has(run('G21 G90\nG0 X0 Y0 Z10\nG81 X1 Y1 Z-3 F100\nM30'), 'error', /needs R/));
  assert.ok(has(run('G21 G90\nG0 X0 Y0 Z10\nG83 X1 Y1 Z-3 R2 F100\nM30'), 'error', /needs a peck depth Q/));
  assert.ok(has(run('G21 G90\nG0 X0 Y0 Z10\nG81 X1 Y1 Z3 R2 F100\nM30'), 'error', /above the R plane/));
});

test('modal-group conflicts, duplicate words, missing feed, unknown codes', () => {
  assert.ok(has(run('G21 G0 G1 X1 Y1 Z1\nM30'), 'error', /same modal group/));
  assert.ok(has(run('G21 G0 X1 X2 Y1 Z1\nM30'), 'error', /X appears twice/));
  assert.ok(has(run('G21 G90\nG0 X0 Y0 Z5\nG1 X10\nM30'), 'error', /no feed rate/));
  assert.ok(has(run('G21 G90 G0 X0 Y0 Z5\nG777\nM30'), 'warning', /Unknown G-code G777/));
  assert.ok(has(run('G21 G90 G0 X0 Y0 Z5\nG0 X1\n'), 'warning', /no end code/));
  assert.ok(has(run('G90 G0 X0 Y0 Z5\nM30'), 'warning', /No units/));
  assert.ok(has(run('G21 G90 G0 X0 Y0 Z5\nM30\nG0 X5'), 'warning', /never run/));
});

test('G43 H mismatch and missing G43 after a tool change', () => {
  const r = run('G21 G90\nT1 M6\nG0 X0 Y0\nG43 Z10 H1\nM3 S1000\nG1 Z5 F100\nT2 M6\nG0 X0 Y0 Z10\nM3 S1000\nG1 Z5 F100\nT3 M6\nG43 H4 Z10\nM30');
  assert.ok(has(r, 'warning', /No G43 tool length offset after the T2/));
  assert.ok(has(r, 'warning', /G43 H4 does not match the active tool T3/));
});

test('crash checks: rapid into stock, spindle off, drill sideways', () => {
  const r = run([
    'G21 G90', 'T1 M6 (T1 D=6 flat end mill)', 'G0 X10 Y10 Z5',
    'G1 Z-2 F100', // spindle off
    'M3 S8000', 'G0 X30 Y10', // rapid at Z-2 through stock
    'G0 Z5', 'T2 M6 (T2 D=5 drill)', 'M3 S2000', 'G0 X50 Y40 Z2', 'G1 Z-3 F100', 'G1 X60', // drill sideways
    'G0 Z5', 'M30',
  ].join('\n'));
  assert.ok(has(r, 'error', /spindle off/));
  assert.ok(has(r, 'error', /Rapid move \(G0\) cuts/));
  assert.ok(has(r, 'error', /moves sideways/));
});

test('retracting straight up with G0 is not a crash', () => {
  const r = run('G21 G90\nT1 M6 (T1 D=6 flat end mill)\nM3 S8000\nG0 X10 Y10 Z5\nG1 Z-3 F100\nG1 X20\nG0 Z5\nM30');
  assert.ok(!r.issues.some((i) => i.sev === 'error'), r.msgs.join('\n'));
});

test('depth checks: flute length, holder, below the stock', () => {
  const r = run('G21 G90\nT1 M6 (T1 D=3 flat end mill)\nM3 S8000\nG0 X10 Y10 Z5\nG1 Z-11 F100\nG0 Z5\nG0 X20 Y20\nG1 Z-14 F100\nG0 Z5\nM30');
  assert.ok(has(r, 'warning', /flute length/));
  assert.ok(has(r, 'warning', /below the bottom of the stock/));
  const deep = run('G21 G90\nT1 M6 (T1 D=3 flat end mill)\nM3 S8000\nG0 X10 Y10 Z5\nG1 Z-40 F100\nG0 Z5\nM30', { ...STOCK, z0: -50 });
  assert.ok(has(deep, 'error', /holder hits/));
});

test('tap feed must equal pitch x rpm', () => {
  const ok = run('G21 G90\nT1 M6 (T1 M6x1.0 TAP)\nS500 M3\nG0 X10 Y10 Z10\nG84 X10 Y10 Z-8 R5 F500\nG80\nM30');
  assert.ok(!ok.issues.some((i) => /Tap feed/.test(i.msg)), ok.msgs.join('\n'));
  const bad = run('G21 G90\nT1 M6 (T1 M6x1.0 TAP)\nS500 M3\nG0 X10 Y10 Z10\nG84 X10 Y10 Z-8 R5 F400\nG80\nM30');
  assert.ok(has(bad, 'error', /Tap feed/));
});

test('no contact with stock is reported', () => {
  const r = run('G21 G90\nT1 M6 (T1 D=6 flat)\nM3 S8000\nG0 X500 Y500 Z5\nG1 Z-1 F100\nG1 X520\nG0 Z5\nM30');
  assert.ok(has(r, 'warning', /No cutting move touches the stock/));
});

test('tool comment parsing', () => {
  const cases = [
    ['T1 D=6. CR=0. - ZMIN=-5. - flat end mill', 'mm', { type: 'flat', dia: 6 }],
    ['T2 D=0.25 CR=0. - flat end mill', 'in', { type: 'flat', dia: 6.35 }],
    ['T1 1/4 FLAT ENDMILL', 'in', { type: 'flat', dia: 6.35 }],
    ['T3 D=6. CR=3. - ball end mill', 'mm', { type: 'ball', dia: 6 }],
    ['T4 D=10. CR=1. - bull nose end mill', 'mm', { type: 'bull', dia: 10, cr: 1 }],
    ['6.0 DRILL', 'mm', { type: 'drill', dia: 6 }],
    ['T5 M8x1.25 TAP', 'mm', { type: 'tap', dia: 8, pitch: 1.25 }],
    ['1/4-20 TAP', 'in', { type: 'tap', dia: 6.35, pitch: 1.27 }],
    ['T6 D=12. TAPER=45DEG - chamfer mill', 'mm', { type: 'chamfer', dia: 12, angle: 90 }],
    ['T7 D=10. TAPER=90DEG - spot drill', 'mm', { type: 'spot', dia: 10, angle: 90 }],
    ['60 DEG V-BIT 1/2"', 'in', { type: 'vbit', dia: 12.7, angle: 60 }],
    ['T9 D=63 face mill', 'mm', { type: 'face', dia: 63 }],
    ['T10 3/8 REAMER', 'in', { type: 'reamer', dia: 9.525 }],
  ];
  for (const [text, units, want] of cases) {
    const t = toolFromHints([{ line: 0, text }], units);
    for (const [k, v] of Object.entries(want)) assert.ok(Math.abs(t[k] - v) < 1e-6 || t[k] === v, `${text}: ${k}=${t[k]}, want ${v}`);
  }
  assert.equal(parseToolComment('SETUP 1 - OP1', 'mm'), null);
});

test('tool profiles', () => {
  assert.equal(profileAt(defaultTool('flat', 10), 4), 0);
  assert.ok(Math.abs(profileAt(defaultTool('ball', 10), 5) - 5) < 1e-9);
  assert.ok(Math.abs(profileAt({ ...defaultTool('drill', 10), angle: 90 }, 5) - 5) < 1e-9);
  assert.equal(profileAt(defaultTool('flat', 10), 6), Infinity);
});

test('timing uses feed and rapid rate', () => {
  const prog = parseGcode('G21 G90\nG0 X0 Y0 Z0\nG0 X100\nG1 X200 F1000\nM30');
  const t = computeTimes(prog.segs, { rapidXY: 5000, rapidZ: 5000 });
  const st = computeStats(prog.segs, t);
  assert.ok(Math.abs(st.rapidTime - 1.2) < 1e-6); // 100 mm at 5000 mm/min
  assert.ok(Math.abs(st.cutTime - 6) < 1e-6); // 100 mm at 1000 mm/min
});

test('acceleration and separate Z rapid rate', () => {
  const prog = parseGcode('G21 G90\nG0 X0 Y0 Z0\nG0 Z60\nG1 X100 F600\nM30');
  const t = computeTimes(prog.segs, { rapidXY: 6000, rapidZ: 1200, accXY: 100, accZ: 100, toolChange: 0 });
  // Z rapid: 60 mm at 20 mm/s with 100 mm/s² -> 3 s + 0.2 s
  assert.ok(Math.abs(t.time[0] - 3.2) < 1e-4, String(t.time[0]));
  // feed: 100 mm at 10 mm/s -> 10 s + 0.1 s
  assert.ok(Math.abs(t.time[1] - 10.1) < 1e-4, String(t.time[1]));
  // a polyline that keeps its direction accelerates once
  const chain = parseGcode('G21 G90\nG0 X0 Y0 Z0\nG1 X10 F600\nX20\nX30\nM30');
  const tc = computeTimes(chain.segs, { rapidXY: 6000, rapidZ: 6000, accXY: 100, accZ: 100 });
  const sum = tc.time.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 3.1) < 1e-4, String(sum));
});

test('subprograms: M98 P L, nesting, M99 and G52 shifts', () => {
  const r = run([
    'O100 (MAIN)', 'G21 G90', 'T1 M6 (T1 D=6 flat end mill)', 'M3 S8000', 'G0 X0 Y0 Z5',
    'G52 X10 Y10', 'M98 P200', 'G52 X50 Y10', 'M98 P200 L2', 'G52 X0 Y0', 'G0 Z10', 'M30',
    'O200 (SQUARE)', 'G0 X0 Y0 Z1', 'G1 Z-1 F200', 'M98 P300', 'G0 Z5', 'M99',
    'O300', 'G1 X5 F400', 'G1 Y5', 'M99',
  ].join('\n'));
  const s = r.prog.segs;
  const feedsAt = (line) => [...s.line].filter((l, i) => l === line && s.type[i] === FEED).length;
  assert.equal(feedsAt(19), 3); // O300's X move runs 3 times (1 + L2)
  // the second part is shifted by G52 X50
  let maxX = -Infinity;
  for (let i = 0; i < s.n; i++) maxX = Math.max(maxX, s.p[i * 6 + 3]);
  assert.equal(maxX, 55);
  assert.ok(!r.issues.some((i) => i.sev !== 'info'), r.msgs.join('\n'));
});

test('subprogram problems are reported', () => {
  assert.ok(has(run('G21 G90\nG0 X0 Y0 Z5\nM98 P999\nM30'), 'warning', /O999.*not in this file/));
  assert.ok(has(run('G21 G90\nG0 X0 Y0 Z5\nG0 X1\nO500\nG0 X2\nM99'), 'warning', /runs into subprogram O500/));
});

test('G28 goes to the configured home', () => {
  const prog = parseGcode('G21 G90\nG0 X10 Y10 Z5\nG91 G28 Z0\nG90 G28 X0 Y0\nM30', { home: [0, 0, 50] });
  const s = prog.segs;
  const last = s.n - 1;
  assert.deepEqual([...s.p.slice(last * 6 + 3, last * 6 + 6)], [0, 0, 50]);
});

function demoStock(d) {
  const st = d.stock, u = st.units === 'in' ? 25.4 : 1;
  if (d.machine === 'lathe') {
    const L = st.z * u;
    const z0 = st.originZ === 'custom' ? st.oz * u : st.originZ === 'bottom' ? 0 : -L;
    return { r: (st.x * u) / 2, rIn: ((st.y || 0) * u) / 2, z0, z1: z0 + L };
  }
  const X = st.x * u, Y = st.y * u, Z = st.z * u;
  const x0 = st.originXY === 'c' ? -X / 2 : 0, y0 = st.originXY === 'c' ? -Y / 2 : 0;
  const z0 = st.originZ === 'bottom' ? 0 : -Z;
  return { x0, x1: x0 + X, y0, y1: y0 + Y, z0, z1: z0 + Z };
}

test('every demo verifies without errors or warnings, on the right machine', () => {
  for (const d of DEMOS) {
    let prog = parseGcode(d.text, { home: [0, 0, 50] });
    assert.equal(prog.machine, d.machine, `${d.name}: detected ${prog.machine}`);
    const toolsOf = () => {
      const tools = new Map();
      for (const t of new Set([...prog.toolOrder, ...prog.segs.tool])) tools.set(t, toolFromHints(prog.toolHints.get(t), prog.units, prog.machine));
      return tools;
    };
    let tools = toolsOf();
    if (prog.usesComp) { prog = parseGcode(d.text, { home: [0, 0, 50], toolDia: (t) => tools.get(t)?.dia }); tools = toolsOf(); }
    const issues = [...prog.issues, ...verify(prog.segs, demoStock(d), tools, MACHINE, undefined, { machine: prog.machine, rotary: prog.rotary || d.stock.shape === 'round' })];
    const bad = issues.filter((i) => i.sev !== 'info');
    assert.deepEqual(bad, [], `${d.name}:\n${bad.map((i) => `${i.line + 1}: ${i.msg}`).join('\n')}`);
    assert.ok(prog.segs.n > 10, d.name);
  }
});

test('Fanuc macro B: variables, expressions, WHILE, IF/GOTO, G65 arguments, #3000 alarm', () => {
  const r = run([
    'G21 G90', 'T1 M6 (T1 D=6 flat)', 'S5000 M3', 'G0 X0 Y0 Z5',
    '#1=0', 'WHILE [#1 LT 4] DO1', 'G0 X[#1*10] Y[SQRT[16]]', '#1=#1+1', 'END1',
    'IF [#1 EQ 4] GOTO 20', 'G0 X999', 'N20 G0 Y-7', 'G65 P8000 A3 B[2*5]', 'M30',
    'O8000', 'G0 X#1 Y#2', 'IF [#2 GT 5] THEN #3000=1 (TOO FAR)', 'M99',
  ].join('\n'));
  const s = r.prog.segs;
  const ends = [];
  for (let i = 0; i < s.n; i++) ends.push([s.p[i * 6 + 3], s.p[i * 6 + 4]]);
  assert.ok(ends.some(([x, y]) => x === 30 && y === 4), 'loop reached X30 Y4');
  assert.ok(!ends.some(([x]) => x === 999), 'GOTO skipped X999');
  assert.ok(ends.some(([x, y]) => x === 3 && y === 10), 'G65 arguments A->#1, B->#2');
  assert.ok(has(r, 'error', /Macro alarm #3000=1: TOO FAR/));
});

test('LinuxCNC o-words: sub/call, while, if/else, repeat, named parameters', () => {
  const r = run([
    'G21 G90', 'G0 X0 Y0 Z5', '#<_n> = 0',
    'o10 sub', 'G0 X#1 Y#2', 'o10 endsub',
    'o20 while [#<_n> LT 3]', 'o10 call [#<_n>*10] [1]', '#<_n> = [#<_n> + 1]', 'o20 endwhile',
    'o30 repeat [2]', 'G91 G0 Y5', 'o30 endrepeat', 'G90',
    'o40 if [#<_n> EQ 3]', 'G0 Z7', 'o40 else', 'G0 Z99', 'o40 endif', 'M2',
  ].join('\n'));
  const s = r.prog.segs;
  const last = (k) => s.p[(s.n - 1) * 6 + 3 + k];
  assert.equal(last(2), 7);
  assert.equal(last(1), 11);
  assert.equal(last(0), 20);
});

test('cutter compensation offsets the path by the tool radius', () => {
  const text = 'G21 G90\nT1 M6 (T1 D=10 flat end mill)\nS8000 M3\nG0 X-20 Y-20 Z5\nG1 Z-1 F100\nG41 D1 G1 X0 Y0 F500\nG1 X50\nG1 Y30\nG1 X0\nG1 Y0\nG40 G1 X-20 Y-20\nG0 Z5\nM30';
  const prog = parseGcode(text, { toolDia: () => 10 });
  const s = prog.segs;
  let maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < s.n; i++) if (s.type[i] !== RAPID) { maxX = Math.max(maxX, s.p[i * 6 + 3]); maxY = Math.max(maxY, s.p[i * 6 + 4]); }
  assert.ok(Math.abs(maxX - 45) < 1e-6 && Math.abs(maxY - 25) < 1e-6, `inside offset (${maxX}, ${maxY})`);
  const g = parseGcode('G21 G90\nG0 X-20 Y5 Z5\nG1 Z-1 F100\nG41 G1 X0 Y0 D1 F500\nG1 X20\nG3 X20 Y4 R2\nG1 X0\nG40 G1 X-20\nM30', { toolDia: () => 10 });
  assert.ok(g.issues.some((i) => /gouges/.test(i.msg)), 'tool bigger than the inside arc is reported');
});

test('lathe: diameter mode, G71 roughing, G70, G76, CSS and centre drilling', () => {
  const d = DEMOS.find((x) => x.id === 'lathe');
  const prog = parseGcode(d.text);
  assert.equal(prog.machine, 'lathe');
  const s = prog.segs;
  let minR = Infinity, minZ = Infinity;
  for (let i = 0; i < s.n; i++) if (s.type[i] !== RAPID && s.tool[i] === 1) minR = Math.min(minR, s.p[i * 6 + 5]);
  for (let i = 0; i < s.n; i++) if (s.tool[i] === 5) minZ = Math.min(minZ, s.p[i * 6 + 3]);
  assert.ok(minR >= 0 && minR < 11, `roughing reaches the profile (radius ${minR})`);
  assert.equal(minZ, -30); // G83 to Z-30 on the centre line
  const thread = [...s.code].filter((c, i) => c === 33 && s.tool[i] === 4).length;
  assert.ok(thread >= 5, 'G76 makes several threading passes');
  // constant surface speed: rpm rises as the diameter falls, capped by G50 S2500
  const rpms = [];
  for (let i = 0; i < s.n; i++) if (s.tool[i] === 1 && s.type[i] === FEED) rpms.push(Math.abs(s.rpm[i]));
  assert.ok(Math.max(...rpms) <= 2500 && Math.min(...rpms) < 2500);
});

test('lathe sim removes material and keeps a bore', () => {
  const sim = new LatheSim({ r: 25, rIn: 0, z0: -50, z1: 0 }, 200);
  sim.cutSeg(20, 2, 20, -30, { type: 'turn', dia: 0.8 }, 'od');
  sim.cutSeg(0, 5, 0, -20, { type: 'drill', dia: 10, angle: 118 }, 'axial');
  const at = (z) => Math.round((z + 50) / sim.dz);
  assert.ok(Math.abs(sim.outer[at(-10)] - 20) < 0.01);
  assert.equal(sim.outer[at(-40)], 25);
  assert.ok(Math.abs(sim.inner[at(-5)] - 5) < 0.01);
});

test('3D printer: extrusion vs travel, filament, hotend check', () => {
  const prog = parseGcode('M104 S200\nG28\nG92 E0\nG1 Z0.2 F3000\nG1 X10 Y0 E1 F1200\nG1 E0.5\nG0 X10 Y10\nG1 X0 Y10 E1.9');
  assert.equal(prog.machine, 'printer');
  const types = [...prog.segs.type];
  assert.ok(types.includes(FEED) && types.includes(TRAVEL));
  assert.ok(Math.abs(prog.filament - 2.4) < 1e-9, String(prog.filament));
  const cold = parseGcode('G28\nG92 E0\nG1 X10 E1 F1200\nG1 X20 E2\nG1 X30 E3');
  assert.ok(cold.issues.some((i) => /hotend temperature/.test(i.msg)));
});

test('laser: beam-on moves cut, beam-off moves travel', () => {
  const prog = parseGcode('; laser job\nG21 G90\nM4 S0\nG0 X0 Y0\nG1 X10 S800 F1000\nG1 X20 S0\nM5\nG1 X30');
  assert.equal(prog.machine, 'laser');
  assert.deepEqual([...prog.segs.type], [FEED, TRAVEL, TRAVEL]);
});

test('rotary A axis wraps around X in the part frame', () => {
  const prog = parseGcode('G21 G90\nG0 X0 Y0 Z20 A0\nG1 A90 F500\nM30');
  const s = prog.segs;
  const end = [...s.p.slice((s.n - 1) * 6 + 3, (s.n - 1) * 6 + 6)];
  assert.ok(Math.abs(end[1] - 20) < 1e-6 || Math.abs(end[1] + 20) < 1e-6, String(end));
  assert.ok(Math.abs(end[2]) < 1e-6);
  assert.ok(prog.rotary);
});

test('transforms: G68 rotation, G51.1 mirror, G16 polar, G10 work offsets', () => {
  const rot = parseGcode('G21 G90\nG0 X0 Y0 Z5\nG68 X0 Y0 R90\nG1 X10 Y0 F100\nM30');
  const e = [...rot.segs.p.slice(3, 6)];
  assert.ok(Math.abs(e[0]) < 1e-9 && Math.abs(e[1] - 10) < 1e-9, String(e));
  const mir = parseGcode('G21 G90\nG0 X0 Y0 Z5\nG51.1 X0\nG1 X10 Y3 F100\nM30');
  assert.ok(Math.abs(mir.segs.p[3] + 10) < 1e-9);
  const pol = parseGcode('G21 G90\nG0 X0 Y0 Z5\nG16\nG1 X10 Y90 F100\nG15\nM30');
  assert.ok(Math.abs(pol.segs.p[3]) < 1e-9 && Math.abs(pol.segs.p[4] - 10) < 1e-9);
  const wcs = parseGcode('G21 G90\nG10 L2 P1 X0 Y0 Z0\nG10 L2 P2 X100 Y0 Z0\nG54 G0 X0 Y0 Z5\nG55 G0 X0 Y0\nM30');
  assert.equal(wcs.segs.p[3], 100);
});

test('machine detection', () => {
  assert.equal(detectMachine('G21\nT0101\nG0 X20 Z2\nG1 Z-10 F0.2'), 'lathe');
  assert.equal(detectMachine('G28\nM104 S200\nG1 X1 E1'), 'printer');
  assert.equal(detectMachine('G21\nM4 S500\nG1 X10 Y10 F1000'), 'laser');
  assert.equal(detectMachine('G21\nG0 X1 Y1 Z1'), 'mill');
});

test('pipeline analyses a program the same way on the page and in the worker', async () => {
  const { analyzeText } = await import('../static/js/pipeline.js');
  const d = DEMOS.find((x) => x.id === 'macro');
  const cfg = {
    defaultUnits: 'mm', machineKind: 'auto', home: [0, 0, 50], dynamics: { rapidXY: 5000, rapidZ: 2000, accXY: 250, accZ: 100, toolChange: 5 },
    limits: MACHINE, stocks: { mill: d.stock, lathe: {}, laser: {}, printer: {} }, toolEdits: {},
  };
  const r = analyzeText(d.text, cfg);
  assert.equal(r.prog.machine, 'mill');
  assert.equal(r.tools.size, 2);
  assert.ok(r.prog.usesComp);
  assert.deepEqual(r.geo.filter((i) => i.sev !== 'info'), []);
  assert.equal(r.times.cum.length, r.prog.segs.n + 1);
  // results survive structured cloning (what postMessage does)
  const c = structuredClone(r);
  assert.equal(c.prog.segs.n, r.prog.segs.n);
});

test('reference lookup is machine-aware', async () => {
  const { lookupWord, G_CODES, M_CODES } = await import('../static/js/refdata.js');
  assert.match(lookupWord('G', 71, 'lathe').title, /Rough turning/);
  assert.match(lookupWord('G', 71, 'mill').title, /Millimetre/);
  assert.match(lookupWord('G', 1, 'mill').title, /Straight feed/);
  assert.match(lookupWord('M', 4, 'laser').title, /dynamic/);
  assert.match(lookupWord('G', 43.4, 'mill').title, /Tool centre point/);
  assert.match(lookupWord('X', 5, 'lathe').text, /diameter/);
  assert.ok(G_CODES.length > 90 && M_CODES.length > 30);
});

test('fuzz: random and mangled G-code never crashes the interpreter', async () => {
  const { analyzeText } = await import('../static/js/pipeline.js');
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const words = ['G0', 'G1', 'G2', 'G3', 'G4', 'G18', 'G20', 'G21', 'G28', 'G41', 'G40', 'G43', 'G52', 'G68', 'G51', 'G16', 'G71', 'G76', 'G81', 'G83', 'G84', 'G90', 'G91', 'G92', 'G93', 'G96', 'G12', 'G5', 'M3', 'M6', 'M98', 'M99', 'M30', 'G65', 'IF', 'GOTO', 'WHILE', 'DO1', 'END1', '#1=', '[#1+2]', 'o1', 'sub', 'call', 'X', 'Y', 'Z', 'I', 'J', 'K', 'R', 'F', 'S', 'T', 'P', 'Q', 'L', 'D', 'A', 'U', 'W', 'E', '(c)', ';c', 'X-#', '[', ']', '#'];
  const num = () => (rnd() < 0.2 ? '' : (rnd() < 0.5 ? '-' : '') + (rnd() * 200).toFixed(Math.floor(rnd() * 3)));
  const stocks = { mill: { units: 'mm', x: 100, y: 80, z: 12, originXY: 'll', originZ: 'top' }, lathe: { units: 'mm', x: 50, y: 0, z: 100, originZ: 'top' }, laser: { units: 'mm', x: 100, y: 100, z: 3, originXY: 'll', originZ: 'top' }, printer: { units: 'mm', x: 200, y: 200, z: 200, originXY: 'll', originZ: 'bottom' } };
  for (let k = 0; k < 300; k++) {
    const lines = [];
    for (let i = 0; i < 1 + rnd() * 20; i++) {
      const w = [];
      for (let j = 0; j < 1 + rnd() * 5; j++) { const x = pick(words); w.push(/^[A-Z]$/.test(x) ? x + num() : x); }
      lines.push(w.join(' '));
    }
    const text = lines.join('\n');
    const cfg = { maxMoves: 20000, timeBudget: 500, defaultUnits: 'mm', machineKind: pick(['auto', 'mill', 'lathe', 'laser', 'printer']), home: [0, 0, 50], dynamics: { rapidXY: 5000, rapidZ: 2000, accXY: 250, accZ: 100 }, limits: MACHINE, stocks, toolEdits: {} };
    let r;
    try { r = analyzeText(text, cfg); } catch (e) { assert.fail(`crashed on:\n${text}\n${e.stack}`); }
    for (let i = 0; i < r.prog.segs.n * 6; i++) assert.ok(Number.isFinite(r.prog.segs.p[i]), `non-finite coordinate for:\n${text}`);
  }
});
