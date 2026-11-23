// G-code reference page: renders refdata.js with search and a machine filter.
import { G_CODES, M_CODES, WORDS, MACRO, GLOSSARY, MACHINE_NAMES, MACHINE_KEY } from './refdata.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function card({ id, code, name, text, machines, example }) {
  const tags = machines ? [...machines].map((k) => `<span class="tag t-${k}">${MACHINE_NAMES[k]}</span>`).join('') : '';
  return `<article class="item" id="${esc(id)}" data-m="${machines || ''}" data-search="${esc(`${code} ${name} ${text} ${example || ''}`.toLowerCase())}">
    <div class="code">${esc(code)}</div>
    <div class="body"><h3>${esc(name)}</h3><p>${esc(text)}</p>${example ? `<pre>${esc(example)}</pre>` : ''}<div class="tags">${tags}</div></div>
  </article>`;
}

const anchor = (code, m) => `${code}${m.length < 4 ? `-${m}` : ''}`;
$('gList').innerHTML = G_CODES.map(([code, m, name, text, example]) => card({ id: anchor(code, m), code, name, text, machines: m, example })).join('');
$('mList').innerHTML = M_CODES.map(([code, m, name, text]) => card({ id: anchor(code, m), code, name, text, machines: m })).join('');
$('wList').innerHTML = WORDS.map(([L, name, text]) => card({ id: `word-${L}`, code: L, name, text })).join('');
$('xList').innerHTML = MACRO.map(([code, name, text, example], i) => card({ id: `macro-${i}`, code, name, text, example })).join('');
$('glList').innerHTML = GLOSSARY.map(([name, text], i) => card({ id: `term-${i}`, code: '•', name, text })).join('');

let machine = '';
function filter() {
  const q = $('q').value.trim().toLowerCase();
  let shown = 0;
  for (const el of document.querySelectorAll('.item')) {
    const okM = !machine || !el.dataset.m || el.dataset.m.includes(machine);
    const okQ = !q || q.split(/\s+/).every((w) => el.dataset.search.includes(w) || el.querySelector('.code').textContent.toLowerCase() === w);
    el.hidden = !(okM && okQ);
    if (!el.hidden) shown++;
  }
  for (const sec of document.querySelectorAll('main section')) {
    if (sec.id === 'basics') { sec.hidden = !!q; continue; }
    sec.hidden = ![...sec.querySelectorAll('.item')].some((el) => !el.hidden);
  }
  $('none').hidden = shown > 0;
}
$('q').addEventListener('input', filter);
for (const b of document.querySelectorAll('.chips button')) {
  b.addEventListener('click', () => {
    machine = b.dataset.m;
    document.querySelectorAll('.chips button').forEach((x) => x.classList.toggle('on', x === b));
    const u = new URL(location.href);
    if (machine) u.searchParams.set('m', Object.keys(MACHINE_KEY).find((k) => MACHINE_KEY[k] === machine));
    else u.searchParams.delete('m');
    history.replaceState(null, '', u);
    filter();
  });
}

// ?m=lathe#G71 from the viewer: filter to the machine and jump to the code
const pm = new URLSearchParams(location.search).get('m');
if (pm && MACHINE_KEY[pm]) document.querySelector(`.chips button[data-m="${MACHINE_KEY[pm]}"]`)?.click();
function jump() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (!h) return;
  let el = document.getElementById(h);
  if (!el || el.hidden) {
    // G71 → the entry for the chosen machine (G71-l), else any G71 entry
    const items = [...document.querySelectorAll('.item')].filter((x) => x.id === h || x.id.startsWith(`${h}-`));
    el = items.find((x) => !x.hidden) || items[0] || el;
  }
  if (!el) return;
  el.hidden = false;
  el.scrollIntoView({ block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
}
window.addEventListener('hashchange', jump);
jump();
