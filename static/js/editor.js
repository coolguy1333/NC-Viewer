// Plain <textarea> editor with a virtualised highlight layer behind it
// (syntax colours, line numbers, issue markers, current line).

const esc = (s) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
const TOKEN = /(\([^)]*\)?|;.*$)|([A-Za-z])(\s*[+-]?(?:\d+\.?\d*|\.\d+))?|([^A-Za-z(;]+)/g;
const CLASS = { G: 'g', M: 'm', X: 'ax', Y: 'ax', Z: 'ax', I: 'arc', J: 'arc', K: 'arc', R: 'arc', F: 'f', S: 'f', T: 't', H: 't', D: 't', N: 'n', O: 'n', P: 'p', Q: 'p', L: 'p' };

function highlight(line) {
  if (line.length > 2000) return esc(line);
  let out = '';
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(line))) {
    if (m[0] === '') { TOKEN.lastIndex++; continue; }
    if (m[1]) out += `<span class="c-cmt">${esc(m[1])}</span>`;
    else if (m[2]) {
      const cls = CLASS[m[2].toUpperCase()] || 'o';
      out += `<span class="c-${cls}">${esc(m[0])}</span>`;
    } else out += esc(m[0]);
  }
  return out;
}

export class CodeEditor {
  constructor(root, { onChange, onCaretLine } = {}) {
    root.classList.add('editor');
    root.innerHTML = `
      <div class="ed-gutter" aria-hidden="true"><div class="ed-gutter-inner"></div></div>
      <div class="ed-main">
        <div class="ed-hl" aria-hidden="true"><div class="ed-hl-inner"></div></div>
        <textarea class="ed-text" spellcheck="false" wrap="off" autocomplete="off" autocorrect="off" autocapitalize="off"
          aria-label="G-code program" placeholder="Paste G-code here, open a file, or drop one on the page…"></textarea>
      </div>`;
    this.ta = root.querySelector('textarea');
    this.hl = root.querySelector('.ed-hl-inner');
    this.gutter = root.querySelector('.ed-gutter-inner');
    this.lines = [''];
    this.marks = new Map();
    this.active = -1;
    this.selected = -1;
    this.onChange = onChange;
    this.onCaretLine = onCaretLine;
    this.lh = 18;
    let timer = 0;
    this.ta.addEventListener('input', () => {
      this.lines = this.ta.value.split('\n');
      this.render();
      clearTimeout(timer);
      timer = setTimeout(() => this.onChange?.(this.ta.value), 350 + Math.min(1500, this.lines.length / 150)); // re-check sooner on short programs
    });
    this.ta.addEventListener('scroll', () => this.render(), { passive: true });
    const caret = () => {
      const l = this.caretLine();
      if (l !== this._lastCaret) {
        this._lastCaret = l;
        this.onCaretLine?.(l);
      }
    };
    this.ta.addEventListener('click', () => { this._lastCaret = -1; caret(); });
    this.ta.addEventListener('keyup', (e) => { if (e.key.startsWith('Arrow') || e.key.startsWith('Page') || e.key === 'Home' || e.key === 'End' || e.key === 'Enter') caret(); });
    new ResizeObserver(() => this.render()).observe(this.ta);
    requestAnimationFrame(() => {
      const lh = parseFloat(getComputedStyle(this.ta).lineHeight);
      if (lh > 0) this.lh = lh;
      this.render();
    });
  }

  get value() { return this.ta.value; }

  setText(text) {
    this.ta.value = text;
    this.lines = this.ta.value.split('\n');
    this.ta.scrollTop = 0;
    this.ta.scrollLeft = 0;
    this.render();
  }

  caretLine() {
    const v = this.ta.value;
    const end = this.ta.selectionStart;
    let n = 0;
    for (let i = v.indexOf('\n'); i >= 0 && i < end; i = v.indexOf('\n', i + 1)) n++;
    return n;
  }

  setMarks(marks) { this.marks = marks; this.render(); }

  setActive(line, scroll) {
    if (line === this.active && !scroll) return;
    this.active = line;
    if (scroll) this.ensureVisible(line);
    this.render();
  }

  setSelected(line) { this.selected = line; this.render(); }

  ensureVisible(line) {
    const top = line * this.lh, h = this.ta.clientHeight;
    if (top < this.ta.scrollTop + this.lh || top > this.ta.scrollTop + h - this.lh * 2) {
      this.ta.scrollTop = Math.max(0, top - h / 3);
    }
  }

  /** Scroll to a line and put the caret at its start. */
  goToLine(line, focus = false) {
    const v = this.ta.value;
    let pos = 0;
    for (let i = 0; i < line && pos >= 0; i++) pos = v.indexOf('\n', pos) + 1 || -1;
    if (pos < 0) pos = v.length;
    if (focus) this.ta.focus({ preventScroll: true });
    this.ta.setSelectionRange(pos, pos);
    this._lastCaret = line;
    this.selected = line;
    this.ta.scrollTop = Math.max(0, line * this.lh - this.ta.clientHeight / 3);
    this.render();
  }

  render() {
    const ta = this.ta;
    const lh = this.lh;
    const top = ta.scrollTop;
    const first = Math.max(0, Math.floor(top / lh) - 2);
    const count = Math.ceil(ta.clientHeight / lh) + 5;
    const last = Math.min(this.lines.length, first + count);
    let code = '', nums = '';
    for (let l = first; l < last; l++) {
      const sev = this.marks.get(l);
      let cls = 'ln';
      if (l === this.active) cls += ' active';
      if (l === this.selected) cls += ' sel';
      if (sev) cls += ' mk-' + sev;
      code += `<div class="${cls}">${highlight(this.lines[l]) || ' '}</div>`;
      nums += `<div class="${cls}">${sev ? `<i class="dot ${sev}"></i>` : ''}${l + 1}</div>`;
    }
    const y = first * lh - top;
    this.hl.innerHTML = code;
    this.hl.style.transform = `translate(${-ta.scrollLeft}px, ${y}px)`;
    this.gutter.innerHTML = nums;
    this.gutter.style.transform = `translateY(${y}px)`;
    if (this._widthFor !== this.lines) {
      // Width of the longest line, without forcing a layout of the textarea.
      this._widthFor = this.lines;
      let max = 0;
      for (const l of this.lines) if (l.length > max) max = l.length;
      if (!this.charW) {
        const c = document.createElement('canvas').getContext('2d');
        c.font = getComputedStyle(ta).font;
        this.charW = c.measureText('0000000000').width / 10 || 8;
      }
      this.hl.style.minWidth = Math.ceil(max * this.charW + 40) + 'px';
    }
  }
}
