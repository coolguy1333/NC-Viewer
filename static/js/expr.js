// Line lexer and macro-expression parser for G-code dialects:
//   Fanuc/Haas/Okuma custom macro B:  #1=[#2+3]  IF [#1 LT 5] GOTO 10  WHILE [..] DO1 / END1  G65 P9010 A1
//   LinuxCNC/Grbl-style:              #<name>=2  o100 sub / call / if / while / repeat ...
// Pure JavaScript, no DOM.

const FUNCS = new Set(['SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN', 'SQRT', 'SQR', 'ABS', 'ROUND', 'RND', 'FIX', 'FUP', 'LN', 'EXP', 'BIN', 'BCD', 'EXISTS', 'POW']);
const OWORDS = new Set(['sub', 'endsub', 'call', 'if', 'elseif', 'else', 'endif', 'while', 'endwhile', 'do', 'repeat', 'endrepeat', 'break', 'continue', 'return']);
const NUM = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const NUM_NOEXP = /(?:\d+\.?\d*|\.\d+)/y;

class Lexer {
  constructor(s) { this.s = s; this.i = 0; }
  ws() { const s = this.s; while (this.i < s.length && (s[this.i] === ' ' || s[this.i] === '\t' || s[this.i] === '\r')) this.i++; }
  peek() { this.ws(); return this.s[this.i]; }
  eat(ch) { if (this.peek() === ch) { this.i++; return true; } return false; }
  kw(word) {
    this.ws();
    const s = this.s.substr(this.i, word.length);
    if (s.toUpperCase() === word) { this.i += word.length; return true; }
    return false;
  }
  word() {
    this.ws();
    const m = /[A-Za-z]+/y;
    m.lastIndex = this.i;
    const r = m.exec(this.s);
    return r ? r[0].toUpperCase() : '';
  }
  number() {
    this.ws();
    NUM_NOEXP.lastIndex = this.i;
    const m = NUM_NOEXP.exec(this.s);
    if (!m) return null;
    this.i += m[0].length;
    return { k: 'num', v: parseFloat(m[0]), raw: m[0] };
  }
}

class ParseError extends Error {}

// ------------------------------------------------------------ expressions
function expr(L) { return orExpr(L); }
function orExpr(L) {
  let a = andExpr(L);
  for (;;) {
    if (L.kw('OR')) a = { k: 'bin', op: 'OR', a, b: andExpr(L) };
    else if (L.kw('XOR')) a = { k: 'bin', op: 'XOR', a, b: andExpr(L) };
    else return a;
  }
}
function andExpr(L) {
  let a = cmpExpr(L);
  while (L.kw('AND')) a = { k: 'bin', op: 'AND', a, b: cmpExpr(L) };
  return a;
}
function cmpExpr(L) {
  let a = addExpr(L);
  for (;;) {
    let op = null;
    for (const w of ['EQ', 'NE', 'GT', 'GE', 'LT', 'LE']) if (L.kw(w)) { op = w; break; }
    if (!op) {
      // C-style comparisons some controls accept
      L.ws();
      const two = L.s.substr(L.i, 2);
      const map = { '==': 'EQ', '!=': 'NE', '<>': 'NE', '>=': 'GE', '<=': 'LE' };
      if (map[two]) { L.i += 2; op = map[two]; }
      else if (L.s[L.i] === '>' || L.s[L.i] === '<') { op = L.s[L.i] === '>' ? 'GT' : 'LT'; L.i++; }
    }
    if (!op) return a;
    a = { k: 'bin', op, a, b: addExpr(L) };
  }
}
function addExpr(L) {
  let a = mulExpr(L);
  for (;;) {
    const c = L.peek();
    if (c === '+' || c === '-') { L.i++; a = { k: 'bin', op: c, a, b: mulExpr(L) }; } else return a;
  }
}
function mulExpr(L) {
  let a = powExpr(L);
  for (;;) {
    const c = L.peek();
    if (c === '*' && L.s[L.i + 1] !== '*') { L.i++; a = { k: 'bin', op: '*', a, b: powExpr(L) }; }
    else if (c === '/') { L.i++; a = { k: 'bin', op: '/', a, b: powExpr(L) }; }
    else if (L.kw('MOD')) a = { k: 'bin', op: 'MOD', a, b: powExpr(L) };
    else return a;
  }
}
function powExpr(L) {
  const a = unary(L);
  L.ws();
  if (L.s.substr(L.i, 2) === '**') { L.i += 2; return { k: 'bin', op: '**', a, b: powExpr(L) }; }
  return a;
}
function unary(L) {
  const c = L.peek();
  if (c === '-') { L.i++; return { k: 'neg', a: unary(L) }; }
  if (c === '+') { L.i++; return unary(L); }
  return primary(L);
}
function primary(L) {
  const c = L.peek();
  if (c === '[' || c === '(') {
    L.i++;
    const e = expr(L);
    if (!L.eat(c === '[' ? ']' : ')')) throw new ParseError(`Missing "${c === '[' ? ']' : ')'}"`);
    return e;
  }
  if (c === '#') {
    L.i++;
    if (L.peek() === '<') return { k: 'name', n: nameRef(L) };
    return { k: 'var', idx: primary(L) };
  }
  if (c && /[\d.]/.test(c)) {
    const n = L.number();
    if (n) return n;
  }
  const save = L.i;
  const w = L.word();
  if (FUNCS.has(w)) {
    L.i += w.length;
    if (w === 'EXISTS') {
      if (!L.eat('[')) throw new ParseError('EXISTS needs [#<name>]');
      L.eat('#');
      const n = L.peek() === '<' ? nameRef(L) : null;
      L.eat(']');
      return { k: 'exists', n };
    }
    if (!L.eat('[')) throw new ParseError(`${w} needs [ ]`);
    const a = expr(L);
    let b = null;
    if (L.eat(',')) b = expr(L);
    if (!L.eat(']')) throw new ParseError(`Missing "]" after ${w}`);
    if (w === 'ATAN' && !b && L.peek() === '/' ) {
      // LinuxCNC two-argument form ATAN[y]/[x]
      const save2 = L.i;
      L.i++;
      if (L.peek() === '[') { L.i++; b = expr(L); if (!L.eat(']')) throw new ParseError('Missing "]"'); } else L.i = save2;
    }
    return { k: 'fn', f: w, a, b };
  }
  L.i = save;
  throw new ParseError(c ? `Unexpected "${c}" in expression` : 'Expression ends early');
}
function nameRef(L) {
  L.eat('<');
  const j = L.s.indexOf('>', L.i);
  if (j < 0) throw new ParseError('Missing ">" after #<name');
  const n = L.s.slice(L.i, j).replace(/\s+/g, '').toLowerCase();
  L.i = j + 1;
  return n;
}

/** A word value: number, #var, [expr], or a signed one of those. */
function wordValue(L) {
  L.ws();
  const c = L.s[L.i];
  if (c === '+' || c === '-') {
    const save = L.i;
    NUM.lastIndex = L.i;
    const m = /[+-]\s*(?:\d+\.?\d*|\.\d+)/y;
    m.lastIndex = L.i;
    const r = m.exec(L.s);
    if (r) { L.i += r[0].length; const raw = r[0].replace(/\s+/g, ''); return { k: 'num', v: parseFloat(raw), raw }; }
    L.i = save + 1;
    const inner = wordValue(L);
    return c === '-' ? { k: 'neg', a: inner } : inner;
  }
  if (c === '#' || c === '[') return primary(L);
  if (c && /[\d.]/.test(c)) {
    const n = L.number();
    if (n) return n;
  }
  const save = L.i;
  const w = L.word();
  if (FUNCS.has(w)) { L.i = save; return primary(L); }
  L.i = save;
  return null;
}

// ---------------------------------------------------------------- lines
/**
 * Parse one line into words, comments, assignments and control statements.
 */
export function parseLine(s) {
  const r = { words: [], comments: [], assigns: [], errors: [], blockDelete: false, n: null, oword: null, ctl: null, prog: null };
  const L = new Lexer(s);
  L.ws();
  if (s[L.i] === '/') { r.blockDelete = true; L.i++; }
  // leading N label
  L.ws();
  {
    const m = /[Nn]\s*(\d+)/y;
    m.lastIndex = L.i;
    const x = m.exec(s);
    if (x) { r.n = +x[1]; L.i += x[0].length; }
  }
  L.ws();
  // LinuxCNC o-word or Fanuc program number
  if (s[L.i] === 'o' || s[L.i] === 'O' || s[L.i] === ':') {
    const m = /[oO:]\s*(\d+|<[^>]*>)/y;
    m.lastIndex = L.i;
    const x = m.exec(s);
    if (x) {
      const after = x[0].length + L.i;
      const kwm = /\s*([A-Za-z]+)/y;
      kwm.lastIndex = after;
      const k = kwm.exec(s);
      const id = x[1].startsWith('<') ? x[1].slice(1, -1).replace(/\s+/g, '').toLowerCase() : String(+x[1]);
      if (k && OWORDS.has(k[1].toLowerCase()) && s[L.i] !== ':') {
        L.i = after + k[0].length;
        const kw = k[1].toLowerCase();
        const o = { id, kw, cond: null, args: [] };
        try {
          if (kw === 'if' || kw === 'elseif' || kw === 'while' || kw === 'repeat' || kw === 'return') {
            if (L.peek() === '[') o.cond = primary(L);
          } else if (kw === 'call') {
            while (L.peek() === '[') o.args.push(primary(L));
          }
        } catch (e) { r.errors.push(e.message); }
        r.oword = o;
        collectComments(s, L.i, r);
        return r;
      }
      if (!x[1].startsWith('<')) {
        r.prog = +x[1];
        L.i = after;
      }
    }
  }

  while (L.i < s.length) {
    L.ws();
    if (L.i >= s.length) break;
    const c = s[L.i];
    if (c === '(') {
      const j = s.indexOf(')', L.i + 1);
      if (j < 0) { r.errors.push('Comment "(" is never closed with ")"'); r.comments.push(s.slice(L.i + 1)); break; }
      r.comments.push(s.slice(L.i + 1, j));
      L.i = j + 1;
      continue;
    }
    if (c === ';') { r.comments.push(s.slice(L.i + 1)); break; }
    if (c === '%') { L.i++; continue; }
    if (c === ')') { r.errors.push('")" has no matching "("'); L.i++; continue; }
    try {
      if (c === '#') {
        // assignment  #n = expr   or  #<name> = expr
        L.i++;
        const target = L.peek() === '<' ? { k: 'name', n: nameRef(L) } : { k: 'var', idx: primary(L) };
        if (!L.eat('=')) throw new ParseError('"#" variable without "=" (assignment expected)');
        r.assigns.push({ target, e: expr(L) });
        continue;
      }
      const up = s.substr(L.i, 6).toUpperCase();
      if (up.startsWith('IF') && /^IF\s*\[/.test(s.substr(L.i, 20).toUpperCase())) {
        L.i += 2;
        const cond = primary(L);
        if (L.kw('GOTO')) r.ctl = { kind: 'ifgoto', cond, target: expr(L) };
        else if (L.kw('THEN')) {
          r.ctl = { kind: 'ifthen', cond };
          // THEN #1 = ... (handled as conditional assignment)
          const rest = parseLine(s.slice(L.i));
          r.ctl.assigns = rest.assigns;
          r.ctl.words = rest.words;
          r.errors.push(...rest.errors);
          r.comments.push(...rest.comments);
          return r;
        } else throw new ParseError('IF [...] must be followed by GOTO or THEN');
        continue;
      }
      if (up.startsWith('GOTO')) { L.i += 4; r.ctl = { kind: 'goto', target: expr(L) }; continue; }
      if (up.startsWith('WHILE') && /^WHILE\s*\[/.test(s.substr(L.i, 20).toUpperCase())) {
        L.i += 5;
        const cond = primary(L);
        if (!L.kw('DO')) throw new ParseError('WHILE [...] needs DO n');
        const m = L.number();
        r.ctl = { kind: 'while', cond, m: m ? m.v : 1 };
        continue;
      }
      if (/^END\s*\d/.test(up)) { L.i += 3; const m = L.number(); r.ctl = { kind: 'end', m: m.v }; continue; }
      if (/^DO\s*\d/.test(up) && !r.ctl) { L.i += 2; const m = L.number(); r.ctl = { kind: 'do', m: m.v }; continue; }
      const letter = c.toUpperCase();
      if (letter >= 'A' && letter <= 'Z') {
        L.i++;
        const v = wordValue(L);
        if (!v) { r.errors.push(`"${letter}" has no number after it`); continue; }
        r.words.push({ l: letter, e: v, raw: v.k === 'num' ? v.raw : null });
        continue;
      }
      r.errors.push(`Unexpected character "${c}"`);
      L.i++;
    } catch (e) {
      r.errors.push(e instanceof ParseError ? e.message : String(e.message || e));
      break;
    }
  }
  return r;
}

function collectComments(s, i, r) {
  const rest = s.slice(i);
  const re = /\(([^)]*)\)|;(.*)$/g;
  let m;
  while ((m = re.exec(rest))) r.comments.push(m[1] ?? m[2]);
}

// ------------------------------------------------------------ evaluation
const D2R = Math.PI / 180;

/**
 * Evaluate an expression node. `vars` supplies get(n), getName(n).
 * Returns a number or null (Fanuc "vacant").
 */
export function evaluate(node, vars) {
  switch (node.k) {
    case 'num': return node.v;
    case 'var': {
      const i = evaluate(node.idx, vars);
      if (i === null) return null;
      return vars.get(Math.round(i));
    }
    case 'name': return vars.getName(node.n);
    case 'exists': return node.n !== null && vars.getName(node.n) !== null ? 1 : 0;
    case 'neg': { const v = evaluate(node.a, vars); return v === null ? null : -v; }
    case 'fn': {
      const a = evaluate(node.a, vars) ?? 0;
      const b = node.b ? evaluate(node.b, vars) ?? 0 : null;
      switch (node.f) {
        case 'SIN': return Math.sin(a * D2R);
        case 'COS': return Math.cos(a * D2R);
        case 'TAN': return Math.tan(a * D2R);
        case 'ASIN': return Math.asin(a) / D2R;
        case 'ACOS': return Math.acos(a) / D2R;
        case 'ATAN': {
          const r = b === null ? Math.atan(a) / D2R : Math.atan2(a, b) / D2R;
          return r < 0 && b !== null ? r + 360 : r;
        }
        case 'SQRT': case 'SQR': return Math.sqrt(a);
        case 'ABS': return Math.abs(a);
        case 'ROUND': case 'RND': return Math.round(a);
        case 'FIX': return Math.floor(a);
        case 'FUP': return Math.ceil(a);
        case 'LN': return Math.log(a);
        case 'EXP': return Math.exp(a);
        case 'POW': return Math.pow(a, b ?? 1);
        case 'BIN': case 'BCD': return a;
        default: return null;
      }
    }
    case 'bin': {
      const ra = evaluate(node.a, vars), rb = evaluate(node.b, vars);
      if (node.op === 'EQ') return (ra === null || rb === null) ? (ra === rb ? 1 : 0) : (Math.abs(ra - rb) < 1e-9 ? 1 : 0);
      if (node.op === 'NE') return (ra === null || rb === null) ? (ra !== rb ? 1 : 0) : (Math.abs(ra - rb) >= 1e-9 ? 1 : 0);
      const a = ra ?? 0, b = rb ?? 0;
      switch (node.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return b === 0 ? NaN : a / b;
        case 'MOD': return b === 0 ? NaN : a - b * Math.floor(a / b);
        case '**': return Math.pow(a, b);
        case 'GT': return a > b ? 1 : 0;
        case 'GE': return a >= b ? 1 : 0;
        case 'LT': return a < b ? 1 : 0;
        case 'LE': return a <= b ? 1 : 0;
        case 'AND': return a && b ? 1 : 0;
        case 'OR': return a || b ? 1 : 0;
        case 'XOR': return (!!a) !== (!!b) ? 1 : 0;
        default: return null;
      }
    }
    default: return null;
  }
}

/** True when the node is a plain number (no variables). */
export const isLiteral = (node) => node && node.k === 'num';
