// Tool library: tool types, defaults, and reading tool descriptions out of
// program comments (Fusion 360, Mastercam, HSM, SolidCAM style).
// All lengths are millimetres. Pure JS (no DOM) so Node tests can use it.

import { MM_PER_INCH } from './gcode.js';

export const TOOL_TYPES = {
  flat:       { label: 'Flat end mill',     flutes: 3, helix: 35, color: '#c9ced6' },
  ball:       { label: 'Ball end mill',     flutes: 2, helix: 30, color: '#c9ced6' },
  bull:       { label: 'Bull nose end mill', flutes: 4, helix: 35, color: '#c9ced6' },
  face:       { label: 'Face mill',         flutes: 5, helix: 0,  color: '#8a929e' },
  drill:      { label: 'Drill',             flutes: 2, helix: 30, color: '#d4a84a' },
  spot:       { label: 'Spot / center drill', flutes: 2, helix: 20, color: '#c9ced6' },
  chamfer:    { label: 'Chamfer mill / countersink', flutes: 3, helix: 0, color: '#c9ced6' },
  vbit:       { label: 'Engraving V-bit',   flutes: 2, helix: 0,  color: '#c9ced6' },
  tap:        { label: 'Tap',               flutes: 3, helix: 0,  color: '#d8b45a' },
  threadmill: { label: 'Thread mill',       flutes: 3, helix: 0,  color: '#c9ced6' },
  reamer:     { label: 'Reamer',            flutes: 6, helix: 5,  color: '#c9ced6' },
  boring:     { label: 'Boring bar',        flutes: 0, helix: 0,  color: '#9aa3ad' },
  turn:       { label: 'Lathe turning insert', flutes: 0, helix: 0, color: '#d8b45a', lathe: true },
  groove:     { label: 'Lathe groove / parting', flutes: 0, helix: 0, color: '#d8b45a', lathe: true },
  thread:     { label: 'Lathe threading insert', flutes: 0, helix: 0, color: '#d8b45a', lathe: true },
  nozzle:     { label: '3D printer nozzle', flutes: 0, helix: 0, color: '#c9a64a', printer: true },
  laser:      { label: 'Laser head',        flutes: 0, helix: 0, color: '#3a3f47', laser: true },
  plasma:     { label: 'Plasma torch',      flutes: 0, helix: 0, color: '#8a929e', laser: true },
};

/** Tool types that make sense on each machine (Tools panel list). */
export const MACHINE_TOOLS = {
  mill: ['flat', 'ball', 'bull', 'face', 'drill', 'spot', 'chamfer', 'vbit', 'tap', 'threadmill', 'reamer', 'boring'],
  lathe: ['turn', 'groove', 'thread', 'boring', 'drill', 'spot', 'tap', 'reamer'],
  laser: ['laser', 'plasma'],
  printer: ['nozzle'],
};
/** Lathe tools that work along the spindle axis (drills) or inside a bore. */
export const AXIAL_TOOLS = new Set(['drill', 'spot', 'tap', 'reamer', 'flat', 'ball', 'bull', 'chamfer', 'vbit', 'threadmill', 'face']);

// Which parameters each type uses (for the Tools panel).
export const TYPE_FIELDS = {
  flat: ['dia', 'flute', 'stickout', 'flutes'],
  ball: ['dia', 'flute', 'stickout', 'flutes'],
  bull: ['dia', 'cr', 'flute', 'stickout', 'flutes'],
  face: ['dia', 'flute', 'stickout', 'flutes'],
  drill: ['dia', 'angle', 'flute', 'stickout'],
  spot: ['dia', 'angle', 'flute', 'stickout'],
  chamfer: ['dia', 'angle', 'tip', 'flute', 'stickout', 'flutes'],
  vbit: ['dia', 'angle', 'tip', 'flute', 'stickout'],
  tap: ['dia', 'pitch', 'flute', 'stickout'],
  threadmill: ['dia', 'pitch', 'flute', 'stickout'],
  reamer: ['dia', 'flute', 'stickout'],
  boring: ['dia', 'flute', 'stickout'],
  turn: ['dia', 'angle', 'stickout'],
  groove: ['dia', 'flute', 'stickout'],
  thread: ['dia', 'pitch', 'stickout'],
  nozzle: ['dia'],
  laser: ['dia'],
  plasma: ['dia'],
};

/** Per-type labels where the generic one would mislead. */
export const TYPE_LABELS = {
  turn: { dia: 'Nose Ø (2 × R)', angle: 'Insert angle°', stickout: 'Holder length' },
  groove: { dia: 'Width', flute: 'Max depth', stickout: 'Holder length' },
  thread: { dia: 'Insert width', stickout: 'Holder length' },
  boring: { dia: 'Bar Ø' },
  nozzle: { dia: 'Nozzle Ø' },
  laser: { dia: 'Kerf width' },
  plasma: { dia: 'Kerf width' },
};

export const FIELD_LABELS = {
  dia: 'Diameter', cr: 'Corner radius', flute: 'Flute length', stickout: 'Stick-out',
  angle: 'Tip angle°', tip: 'Tip diameter', pitch: 'Thread pitch', flutes: 'Flutes',
};

/** Sensible tool for a type and diameter (mm). */
export function defaultTool(type = 'flat', dia = 6) {
  const t = { type, dia, cr: 0, angle: 0, tip: 0, pitch: 0, flutes: TOOL_TYPES[type]?.flutes ?? 2 };
  switch (type) {
    case 'drill': t.angle = 118; t.flute = dia * 6 + 3; break;
    case 'spot': t.angle = 90; t.flute = dia * 1.5; break;
    case 'chamfer': t.angle = 90; t.tip = Math.min(dia * 0.1, 1); t.flute = dia * 0.6; break;
    case 'vbit': t.angle = 60; t.tip = 0; t.flute = dia; break;
    case 'tap': t.pitch = metricCoarsePitch(dia); t.flute = dia * 2.2; break;
    case 'threadmill': t.pitch = metricCoarsePitch(dia * 1.3); t.flute = dia * 1.6; break;
    case 'face': t.flute = Math.max(4, dia * 0.1); break;
    case 'ball': t.cr = dia / 2; t.flute = dia * 3; break;
    case 'bull': t.cr = Math.min(1, dia * 0.1); t.flute = dia * 3; break;
    case 'reamer': t.flute = dia * 3; break;
    case 'boring': t.flute = dia * 3; break;
    case 'turn': t.angle = 80; t.flute = 0; break;
    case 'groove': t.flute = Math.max(3, dia * 4); break;
    case 'thread': t.pitch = 1.5; t.angle = 60; t.flute = 0; break;
    case 'nozzle': case 'laser': case 'plasma': t.flute = 0; break;
    default: t.flute = dia * 3;
  }
  if (type === 'turn' || type === 'groove' || type === 'thread') { t.stickout = 40; return t; }
  if (type === 'nozzle' || type === 'laser' || type === 'plasma') { t.stickout = 0; return t; }
  t.stickout = type === 'face' ? Math.max(30, dia * 0.6) : t.flute + Math.max(8, dia * 2);
  return t;
}

function metricCoarsePitch(d) {
  const table = [[1.6, 0.35], [2, 0.4], [2.5, 0.45], [3, 0.5], [4, 0.7], [5, 0.8], [6, 1], [8, 1.25], [10, 1.5], [12, 1.75], [16, 2], [20, 2.5], [24, 3]];
  let best = table[0];
  for (const row of table) if (Math.abs(row[0] - d) < Math.abs(best[0] - d)) best = row;
  return best[1];
}

const TYPE_WORDS = [
  [/nozzle|hotend|extruder/i, 'nozzle'],
  [/plasma|torch/i, 'plasma'],
  [/\blaser\b|\bdiode\b|\bco2\b|\bfiber\b/i, 'laser'],
  [/groov|parting|part[- ]off|cut[- ]?off/i, 'groove'],
  [/\bthread(?:ing)?\b(?!\s*mill)|\b1[16][ER]\b/i, 'thread'],
  [/\b[CDTVWSRK]N[MGPU][GMPAX]?\s*\d{3}|\bturn(?:ing)?\b|\bOD\s*(?:rough|finish|turn|profile)|\bfacing\b|\bface\s+tool/i, 'turn'],
  [/\btap\b|\btapping\b|\bm\d+(?:\.\d+)?\s*x\s*\d|\d+\s*-\s*\d+\s*(?:unc|unf|tap)/i, 'tap'],
  [/thread\s*mill/i, 'threadmill'],
  [/spot|cent(?:er|re)\s*drill|\bnc\s*drill/i, 'spot'],
  [/drill/i, 'drill'],
  [/ream/i, 'reamer'],
  [/chamfer|counter\s*sink|c-?sink|deburr/i, 'chamfer'],
  [/engrav|v-?\s?bit|v\s*cutter|v-?groove/i, 'vbit'],
  [/face\s*mill|shell\s*mill|fly\s*cut/i, 'face'],
  [/ball|\bbem\b|\bbnem\b/i, 'ball'],
  [/bull|corner\s*rad|radius\s*end|\bcr\s*=\s*0*\.?0*[1-9]/i, 'bull'],
  [/boring|bore\s*bar/i, 'boring'],
  [/end\s*mill|endmill|\bflat\b|\bfem\b|\bem\b|slot\s*mill|router\s*bit|upcut|downcut|compression|o-?flute|mill/i, 'flat'],
];

/**
 * Read a tool description from comment text.
 * @param {string} text comment text
 * @param {'mm'|'in'} units program units (numbers without a unit use these)
 * @returns {null | object} partial tool (mm) and `source`
 */
export function parseToolComment(text, units = 'mm') {
  if (!text) return null;
  const s = text.replace(/\s+/g, ' ');
  const u = units === 'in' ? MM_PER_INCH : 1;
  let type = null;
  for (const [re, ty] of TYPE_WORDS) if (re.test(s)) { type = ty; break; }

  const out = {};
  let m;
  // Thread designations first (they also carry diameter and pitch).
  if ((m = /\bM(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)/.exec(s))) {
    out.dia = +m[1]; out.pitch = +m[2];
  } else if ((m = /(?:^|[^\w.\/])(#\d+|\d+\/\d+|\d*\.\d+|\d+)\s*-\s*(\d+)\s*(?:UNC|UNF|UNEF|UN|NPT|tap)?/i.exec(s)) && /tap|unc|unf|thread/i.test(s)) {
    const d = m[1].startsWith('#') ? unifiedNumber(+m[1].slice(1)) : fraction(m[1]);
    if (d) { out.dia = d * MM_PER_INCH; out.pitch = MM_PER_INCH / +m[2]; }
  }
  if (out.dia === undefined) {
    if ((m = /\bD(?:IA(?:METER)?)?\s*[=:]\s*(\d*\.?\d+)\s*(mm|in|")?/i.exec(s)) || (m = /(?:Ø|⌀|\bDIA(?:METER)?\.?)\s*(\d*\.?\d+)\s*(mm|in|")?/i.exec(s))) {
      out.dia = +m[1] * (m[2] ? (m[2].toLowerCase() === 'mm' ? 1 : MM_PER_INCH) : u);
    } else if ((m = /(?:^|[^\w.\/])(\d+\s+\d+\/\d+|\d+\/\d+)\s*(?:"|in(?:ch)?\b)?/.exec(s))) {
      out.dia = fraction(m[1]) * MM_PER_INCH;
    } else if ((m = /(?:^|[^\w.])(\d*\.?\d+)\s*mm\b/i.exec(s))) {
      out.dia = +m[1];
    } else if ((m = /(?:^|[^\w.])(\d*\.\d+|\d+)\s*(?:"|in(?:ch)?\b)/i.exec(s))) {
      out.dia = +m[1] * MM_PER_INCH;
    } else if (type && (m = /(?:^|[\s(|,])(\d*\.\d+|\d+\.?)\s+(?:[A-Z]+\s+)*(?:end\s*mill|endmill|drill|ball|bull|flat|ream|tap|chamfer|spot|face|mill|engrav|v-?bit)/i.exec(s))) {
      out.dia = +m[1] * u;
    }
  }
  if ((m = /\bCR\s*=\s*(\d*\.?\d+)/i.exec(s))) out.cr = +m[1] * u;
  if ((m = /\b(?:TAPER|ANGLE|TIP\s*ANGLE)\s*=?\s*(\d+(?:\.\d+)?)\s*(?:DEG|°)?/i.exec(s)) || (m = /(\d+(?:\.\d+)?)\s*(?:DEG\b|°)/i.exec(s))) {
    const a = +m[1];
    if (a > 0 && a < 180) out.taper = a;
  }
  if ((m = /\b(\d)\s*(?:FL\b|FLT\b|FLUTES?\b|F\b)/i.exec(s))) out.flutes = +m[1];
  if ((m = /\b(?:FLUTE|LOC|CUT(?:TING)?\s*LEN(?:GTH)?)\s*[=:]?\s*(\d*\.?\d+)/i.exec(s))) out.flute = +m[1] * u;
  if ((m = /\bPITCH\s*[=:]?\s*(\d*\.?\d+)/i.exec(s)) || (m = /(\d*\.?\d+)\s*(?:mm\s*)?PITCH/i.exec(s))) out.pitch = +m[1] * u;
  else if ((m = /(\d+)\s*TPI\b/i.exec(s))) out.pitch = MM_PER_INCH / +m[1];

  // ISO turning insert: CNMG 432 (inch, nose in 1/64") or CNMG120408 (metric, nose in 0.1 mm)
  if ((m = /\b([CDTVWSRK])N[MGPU][GMPAX]?\s*(\d{6}|\d{3})/i.exec(s))) {
    type = type || 'turn';
    out.angle = { C: 80, D: 55, T: 60, V: 35, W: 80, S: 90, R: 180, K: 55 }[m[1].toUpperCase()];
    const nose = m[2].length === 6 ? +m[2].slice(4) / 10 : (+m[2].slice(2) / 64) * MM_PER_INCH;
    out.dia = Math.max(0.1, nose * 2);
  }
  if (type === 'nozzle' && (m = /(\d*\.\d+)\s*(?:mm)?/.exec(s))) out.dia = +m[1];
  if (!type && out.dia === undefined) return null;
  if (!type) type = out.cr > 0 ? 'bull' : 'flat';
  if (type === 'flat' && out.cr > 0) type = Math.abs(out.cr * 2 - (out.dia ?? 0)) < 1e-3 ? 'ball' : 'bull';
  return { type, ...out, source: text.trim() };
}

function fraction(str) {
  const parts = str.trim().split(/\s+/);
  let v = 0;
  for (const p of parts) {
    if (p.includes('/')) {
      const [a, b] = p.split('/').map(Number);
      if (!b) return 0;
      v += a / b;
    } else v += +p;
  }
  return v;
}

function unifiedNumber(n) {
  return 0.06 + 0.013 * n; // #0 = 0.060", #10 = 0.190"
}

/** Build a full tool from a parsed comment (or defaults when none). */
export function toolFromHints(hints, units, machine = 'mill') {
  let best = null;
  for (const h of hints || []) {
    const p = parseToolComment(h.text, units);
    if (p && (!best || score(p) > score(best))) best = p;
  }
  if (best && !MACHINE_TOOLS[machine]?.includes(best.type)) {
    // e.g. "flat" on a lathe: keep the size, use a type that exists on this machine
    if (machine === 'lathe' && !AXIAL_TOOLS.has(best.type)) best = { ...best, type: 'turn' };
    else if (machine === 'laser') best = { ...best, type: /plasma|torch/i.test(best.source) ? 'plasma' : 'laser', dia: best.type === 'laser' || best.type === 'plasma' ? best.dia : undefined };
    else if (machine === 'printer') best = { ...best, type: 'nozzle', dia: best.type === 'nozzle' ? best.dia : undefined };
    else if (machine === 'mill') best = { ...best, type: best.type === 'thread' ? 'threadmill' : 'flat' };
  }
  const fallback = { mill: ['flat', units === 'in' ? 6.35 : 6], lathe: ['turn', 0.8], laser: ['laser', 0.15], printer: ['nozzle', 0.4] }[machine] || ['flat', 6];
  if (!best) return { ...defaultTool(fallback[0], fallback[1]), source: '', guessed: machine === 'mill' || machine === 'lathe' };
  if (best.dia === undefined && best.type === fallback[0]) best.dia = fallback[1];
  const fallbackDia = best.type === 'turn' ? 0.8 : best.type === 'groove' ? 3 : best.type === 'thread' ? 3 : fallback[1];
  const t = defaultTool(best.type, best.dia ?? fallbackDia);
  if (best.cr !== undefined && best.type === 'bull') t.cr = best.cr;
  if (best.flutes) t.flutes = best.flutes;
  if (best.pitch) t.pitch = best.pitch;
  if (best.flute) {
    t.flute = best.flute;
    t.stickout = Math.max(t.stickout, t.flute + 5);
  }
  if (best.angle && best.type === 'turn') t.angle = best.angle;
  if (best.type === 'thread') t.dia = 3; // the size in a thread callout is the thread, not the insert
  if (best.taper) {
    if (best.type === 'drill' || best.type === 'spot') t.angle = best.taper;
    else if (best.type === 'chamfer' || best.type === 'vbit') t.angle = best.taper <= 60 && best.type === 'chamfer' ? best.taper * 2 : best.taper;
  }
  t.source = best.source;
  t.guessed = best.dia === undefined && !(best.type in { nozzle: 1, laser: 1, plasma: 1, thread: 1 });
  return t;
}

function score(p) {
  return (p.dia !== undefined ? 2 : 0) + (p.type ? 1 : 0) + (p.pitch ? 0.5 : 0);
}

/**
 * Height of the tool's cutting surface above its tip at radius r (mm).
 * Infinity outside the cutting radius.
 */
export function profileAt(tool, r) {
  const R = tool.dia / 2;
  if (r > R + 1e-9) return Infinity;
  switch (tool.type) {
    case 'ball': {
      const v = R * R - r * r;
      return R - Math.sqrt(Math.max(0, v));
    }
    case 'bull': {
      const cr = Math.min(tool.cr || 0, R);
      if (r <= R - cr) return 0;
      const d = r - (R - cr);
      return cr - Math.sqrt(Math.max(0, cr * cr - d * d));
    }
    case 'drill':
    case 'spot': {
      const half = ((tool.angle || 118) * Math.PI) / 360;
      return r / Math.tan(half);
    }
    case 'chamfer':
    case 'vbit': {
      const half = ((tool.angle || 90) * Math.PI) / 360;
      const tipR = (tool.tip || 0) / 2;
      return r <= tipR ? 0 : (r - tipR) / Math.tan(half);
    }
    default:
      return 0;
  }
}

/** Tool types that must not move sideways while in material. */
export const PLUNGE_ONLY = new Set(['drill', 'tap', 'reamer']);
