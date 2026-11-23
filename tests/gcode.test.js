// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGcode, tokenizeLine, RAPID, FEED, ARC, DRILL } from '../static/js/gcode.js';
import { parseToolComment, toolFromHints, defaultTool, profileAt } from '../static/js/tools.js';
import { computeTimes, computeStats, verify } from '../static/js/analyze.js';
import { DEMOS } from '../static/js/demos.js';

const SAMPLE = DEMOS.find((d) => d.id === 'bracket').text;

const STOCK = { x0: 0, x1: 100, y0: 0, y1: 80, z0: -12, z1: 0 };
const MACHINE = { maxRpm: 24000, maxFeed: 10000 };

function run(text, stock = STOCK, opts = {}) {
  const prog = parseGcode(text, opts);
  const tools = new Map();
  for (const t of new Set([...prog.toolOrder, ...prog.segs.tool])) tools.set(t, toolFromHints(prog.toolHints.get(t), prog.units));
  const issues = [...prog.issues, ...verify(prog.segs, stock, tools, MACHINE)];
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

test('every demo verifies without errors or warnings', () => {
  for (const d of DEMOS) {
    const u = d.stock.units === 'in' ? 25.4 : 1;
    const X = d.stock.x * u, Y = d.stock.y * u, Z = d.stock.z * u;
    const x0 = d.stock.originXY === 'c' ? -X / 2 : 0, y0 = d.stock.originXY === 'c' ? -Y / 2 : 0;
    const r = run(d.text, { x0, x1: x0 + X, y0, y1: y0 + Y, z0: -Z, z1: 0 });
    const bad = r.issues.filter((i) => i.sev !== 'info');
    assert.deepEqual(bad, [], `${d.name}:\n${r.msgs.join('\n')}`);
  }
});
