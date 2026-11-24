// Tooltips written for students: every control explains what it does and why
// you'd use it. Hover (or focus with the keyboard, or press and hold on a touch
// screen) anything with a data-tip.

const TIPS = {
  // top bar
  btnOpen: 'Open a G-code file from your computer (.nc, .gcode, .tap, .ngc …). You can also drag a file onto the page.',
  btnPaste: 'Replace the program with whatever G-code is on your clipboard. You can also click in the editor and press Ctrl+V.',
  demoSelect: 'Load an example program for a mill, lathe, laser or 3D printer — a good way to see what each kind of G-code looks like.',
  btnSave: 'Download the program in the editor as a file (keeps your edits).',
  btnClear: 'Empty the editor to start a new program.',
  fileMenuBtn: 'More: save the program, start a new one, convert air moves to rapids, or show the quick start again.',
  viewMenuBtn: 'More views: back, left, and orthographic (true-size) mode.',
  btnConvert: 'Find slow G1 moves that only travel through the air and turn them into fast G0 rapids. Saves cycle time; you can undo it.',
  btnTour: 'Show the three-step quick start again.',
  btnRef: 'Open the G-code reference: what every G and M code, letter and macro command means, with examples.',
  verdict: 'The result of checking your program. Green = no problems found, yellow = warnings to look at, red = errors that would stop the machine or crash it. Click to jump to the list.',
  // program pane
  progMeta: 'Program size, units (mm or inch), the machine it was written for, and the estimated run time.',
  cvZ: 'Feed moves that stay at or above this height are only moving through the air. Leave empty to use just above the top of the stock.',
  cvGo: 'Turn the air moves into G0 rapids. A message with Undo appears afterwards.',
  // view
  btnProj: 'Switch between perspective (things further away look smaller, like a photo) and orthographic (true sizes, like a technical drawing).',
  // playback
  pbStart: 'Jump to the start of the program (Home key).',
  pbBack: 'Step back one line of G-code (← key).',
  pbPlay: 'Play or pause the simulation (Space). Watch the tool move and the material get cut.',
  pbFwd: 'Step forward one line of G-code (→ key). Great for following a program slowly.',
  pbEnd: 'Jump to the end: shows the finished part (End key).',
  pbSlider: 'Drag to move through the program. The editor jumps to the line being run.',
  pbTime: 'Time into the program / total estimated run time (using the program\'s feed rates and your machine settings).',
  pbSpeed: 'How fast the simulation plays compared with the real machine. 1× = real time.',
  // stock
  mMachine: 'What kind of machine the program is for. Auto-detect looks at the code (E words = 3D printer, X/Z with T0101 = lathe, laser power = laser…). Pick one if it guesses wrong.',
  stShape: 'Block = a rectangular piece. Round bar = a cylinder lying along X, for 4th-axis (A axis) work.',
  stUnits: 'Units for the stock sizes you type in. They don\'t have to match the program.',
  stMaterial: 'The material colour in the view. It doesn\'t change the checks.',
  stOriginXY: 'Where program zero (X0 Y0) is on the stock. This must match where you touch off on the real machine, or the part ends up in the wrong place.',
  stOriginZ: 'Where Z0 is. Most programs use the top of the stock, so cutting moves have negative Z.',
  stOX: 'X position of the stock\'s corner, measured from program zero.',
  stOY: 'Y position of the stock\'s corner, measured from program zero.',
  stOZ: 'Z position of the stock\'s bottom (or the back of a lathe bar), measured from program zero.',
  stFit: 'Make the stock just big enough for the cutting moves (plus the tool radius). Handy when you don\'t know the stock size.',
  stShow: 'Show or hide the stock in the 3D view.',
  stSim: 'Show the material being cut away as the program runs. The crash checks use this too.',
  stRes: 'How fine the material simulation is. Higher looks smoother but is slower on big programs.',
  // settings
  mUnits: 'Units for the machine settings below.',
  mRapidXY: 'How fast the machine moves in X and Y during G0 rapids. Check the machine\'s manual — it is used for the run-time estimate.',
  mRapidZ: 'How fast Z moves during rapids (often slower than X and Y).',
  mAccXY: 'How quickly X and Y speed up and slow down. Short moves never reach full speed, so this makes the time estimate realistic. 0 = instant.',
  mAccZ: 'How quickly Z speeds up and slows down.',
  mToolChange: 'Seconds for one tool change, added to the run time.',
  mMaxRpm: 'Fastest spindle speed your machine can do. Programs asking for more get a warning. 0 = don\'t check.',
  mMaxFeed: 'Fastest feed rate your machine allows. 0 = don\'t check.',
  mDefUnits: 'Units to assume if the program never says G20 (inch) or G21 (mm). A program should always say!',
  mHomeX: 'Where the machine goes on G28 (measured from program zero), so the move can be drawn.',
  mHomeY: 'Where the machine goes on G28 (measured from program zero).',
  mHomeZ: 'Where Z goes on G28 — usually high above the part.',
  mReset: 'Put all machine settings back to the defaults.',
  dColor: 'Colour the toolpath by move type (rapid/feed/arc/cycle), by tool, or by depth (blue = high, red = deep).',
  dFeeds: 'Show the cutting (or extruding) moves.',
  dRapids: 'Show rapid G0 moves and non-cutting travel moves.',
  dTool: 'Show the 3D tool model.',
  dHolder: 'Show the tool holder too (see-through). Useful to spot holder crashes.',
  dGrid: 'Show the floor grid. One square = 1 mm, 10 mm … depending on zoom.',
  dAxes: 'Show the X (red), Y (green) and Z (blue) arrows at program zero.',
  dFx: 'Chips (or laser sparks) fly while the tool is cutting.',
  dFollowTool: 'Keep the camera moving with the tool during playback.',
  dFollow: 'Scroll the editor to the line being run during playback.',
};

const VIEW_TIPS = {
  iso: 'Isometric view: from the front-right, above. Good for seeing everything at once.',
  top: 'Look straight down (XY plane) — like looking at a drawing of the part from above.',
  front: 'Look from the front (XZ plane). Shows depths.',
  right: 'Look from the side (YZ plane).',
  back: 'Look from the back.',
  left: 'Look from the left side.',
  fit: 'Zoom to fit the whole toolpath and stock. Tip: drag to rotate, right-drag to pan, scroll to zoom.',
};

const TAB_TIPS = {
  stock: 'Set the size of the raw material and where program zero is.',
  tools: 'The tools the program uses. Sizes are read from comments; fix them here if they are wrong.',
  stats: 'Numbers about the program: run time, distances, sizes, per-tool times.',
  settings: 'Machine speeds and limits, and display options.',
};

export const STOCK_TIPS = {
  mill: { stX: 'Size of the block in X (left to right).', stY: 'Size of the block in Y (front to back).', stZ: 'Thickness of the block (Z).' },
  round: { stX: 'Length of the bar along X.', stY: 'Diameter of the bar.', stZ: '' },
  lathe: { stX: 'Diameter of the bar in the chuck.', stY: 'Diameter of a hole already through the bar (0 for a solid bar).', stZ: 'How much bar sticks out of the chuck.' },
  laser: { stX: 'Sheet size in X.', stY: 'Sheet size in Y.', stZ: 'Sheet thickness. The laser/torch cuts all the way through.' },
  printer: { stX: 'Bed size in X.', stY: 'Bed size in Y.', stZ: 'Tallest print the printer can make.' },
};

export const STAT_TIPS = {
  Machine: 'The type of machine this program is for.',
  Units: 'G20 = inches, G21 = millimetres.',
  Lines: 'Lines of text in the program.',
  'Moves drawn': 'Straight pieces the toolpath is drawn with (arcs are split into many small pieces).',
  'Arc moves': 'Number of G2/G3 arc commands run.',
  'Tool changes': 'How many times the tool is changed.',
  'Estimated run time': 'How long the program should take on the machine, using its feed rates plus your rapid speed, acceleration and tool-change time.',
  'Cutting time': 'Time spent cutting (feed moves).',
  'Printing time': 'Time spent extruding.',
  'Rapid time': 'Time spent on rapid moves through the air.',
  'Travel time': 'Time spent moving without cutting/extruding.',
  Dwell: 'Total time of pauses (G4 and dwell in cycles).',
  'Cutting distance': 'Total length of all cutting moves.',
  'Extrusion path': 'Total length of all extruding moves.',
  'Rapid distance': 'Total length of rapid moves.',
  'Travel distance': 'Total length of non-cutting moves.',
  Layers: 'Number of different heights where plastic is laid down.',
  'Filament used': 'Length of filament pushed through the nozzle.',
  Retractions: 'Times the filament is pulled back to stop stringing.',
  Features: 'Advanced G-code features this program uses.',
  'Rotary axes': 'The program turns the part with A, B or C axes.',
  X: 'Smallest and largest X reached.',
  Y: 'Smallest and largest Y reached.',
  Z: 'Lowest and highest Z reached.',
  'X (Ø)': 'Smallest and largest diameter reached.',
};

export const FIELD_TIPS = {
  dia: 'Cutting diameter of the tool. It sets how wide the cut is and the cutter compensation offset.',
  cr: 'Radius on the corners of a bull-nose end mill.',
  flute: 'Length of the cutting part. Cutting deeper than this rubs the shank (warning).',
  stickout: 'How far the tool sticks out of the holder. Cutting deeper than this crashes the holder (error).',
  angle: 'Point angle (drills 118°, spot drills 90°), chamfer/V-bit angle, or lathe insert angle (80° C, 55° D, 35° V).',
  tip: 'Small flat on the tip of a chamfer mill or V-bit.',
  pitch: 'Thread pitch: distance from one thread to the next. A tap\'s feed must be pitch × rpm.',
  flutes: 'Number of cutting edges.',
};

// ------------------------------------------------- verification explanations
const ISSUE_HELP = [
  [/Rapid move \(G0\) cuts/, 'G0 moves at full speed and is not meant to cut. Moving into material like this breaks the tool or the machine. Retract first, or use G1 with a feed rate.'],
  [/spindle off/, 'The tool is cutting but the spindle isn\'t turning — the tool would snap. Add S… M3 before cutting (and after every tool change).'],
  [/moves sideways while in material/, 'Drills, taps and reamers only cut at their tip and break if pushed sideways. Retract before moving in X/Y, or use an end mill.'],
  [/holder hits the stock/, 'The tool doesn\'t stick out far enough for this depth, so the holder would smash into the part. Use a longer tool or less depth.'],
  [/flute length/, 'Only the fluted part of the tool cuts. Going deeper than the flutes rubs the shank, overheats and can break the tool.'],
  [/below the bottom of the stock/, 'The tool goes lower than the stock — into the vise, table or spoilboard. Check the stock thickness and Z zero.'],
  [/No cutting move touches the stock/, 'Nothing is cut, so the stock size or program zero setting probably doesn\'t match the program. Try "Fit stock to toolpath".'],
  [/no feed rate|no lead \(F\)|needs F/, 'Feed moves need F (how fast to cut). Without it most controls alarm. Add F to the first G1/G2/G3 line.'],
  [/No units/, 'Without G20 or G21 the machine uses whatever units it was last in — a 25× size mistake waiting to happen. Put G21 (mm) or G20 (inch) at the top.'],
  [/no end code/, 'Finish with M30 (or M2) so the machine stops the spindle and resets properly.'],
  [/never run/, 'Lines after M30 are ignored by the machine (unless they are subprograms).'],
  [/same modal group/, 'These two codes contradict each other (e.g. G0 and G1 on one line). Keep only one.'],
  [/appears twice/, 'A letter can only appear once on a line. Split the line or remove the extra word.'],
  [/not on the circle|radius mismatch/, 'The arc\'s end point isn\'t the same distance from the centre as the start. Check the I/J/K values — the control will alarm.'],
  [/needs I\/J\/K|has no I\/J\/K/, 'An arc needs its centre (I J K) or a radius (R). If you meant a straight move, add G1.'],
  [/too small to reach/, 'The radius R is shorter than half the distance between the start and end points, so no arc can join them.'],
  [/needs R \(retract plane\)/, 'Canned cycles need R: the height where the tool switches from rapid to feed, just above the part.'],
  [/needs Z \(hole bottom\)/, 'The cycle needs Z: how deep to drill.'],
  [/peck depth Q/, 'G83/G73 need Q: how deep each peck goes before clearing chips.'],
  [/above the R plane/, 'The hole bottom (Z) is higher than R, so there is nothing to drill.'],
  [/G43 H.*does not match/, 'G43 should use the length offset of the tool in the spindle (H5 for T5). The wrong H means the wrong Z height — a crash risk.'],
  [/No G43 tool length offset/, 'Each tool has a different length. Without G43 H after a tool change, Z heights are wrong for the new tool.'],
  [/Spindle started .* no speed/, 'M3/M4 starts the spindle at speed S. Give an S value first (e.g. S8000 M3).'],
  [/Tap feed/, 'A tap moves exactly one pitch per turn, so feed must equal pitch × rpm. Otherwise the tap strips the thread or snaps.'],
  [/without a tapping cycle/, 'Taps should be used with G84 (or G74), which reverses the spindle to back the tap out.'],
  [/gouges/, 'With cutter compensation the tool can\'t fit into a corner or arc smaller than its radius — it would cut into the part. Use a smaller tool or a bigger radius.'],
  [/Cutter compensation radius unknown/, 'Set the tool diameter in the Tools tab so the offset path can be drawn.'],
  [/crosses the spindle centre/, 'On a lathe the tool should not go past the centre line (X below 0) — it would be cutting upside down.'],
  [/G96 .* without a spindle limit/, 'With constant surface speed the rpm goes up as the diameter shrinks — to dangerous speeds near the centre. Add G50 S… to cap it.'],
  [/spindle speed .* above|above the machine maximum/i, 'Your machine can\'t go that fast (see Settings).'],
  [/outside the build volume/, 'The print head would move past the edge of the bed or above the top of the printer.'],
  [/below the bed/, 'The nozzle would be pressed into the bed.'],
  [/hotend temperature|below the usual minimum/, 'Plastic only flows when hot. Heat the nozzle with M109 S… before extruding, or the extruder grinds the filament.'],
  [/First layer/, 'The first layer should be squashed onto the bed at about 0.1–0.4 mm for it to stick.'],
  [/off the edge of the sheet/, 'The cut goes past the edge of the sheet — check the sheet size and program zero.'],
  [/laser\/torch is never on/, 'Feed moves only cut when the beam is on: M3 or M4 with an S power above 0.'],
  [/Macro alarm/, 'The program deliberately stopped itself with #3000 — usually a safety check in a macro failed.'],
  [/GOTO|WHILE|END\d|endif|endwhile|endsub/, 'A macro jump or loop doesn\'t have its matching label or end. The control would alarm here.'],
  [/endless loop/, 'The program never finishes — check loop conditions and that loop counters change.'],
  [/not in this file/, 'The called subprogram lives in another file on the machine, so it can\'t be shown here.'],
  [/runs into subprogram/, 'Without M30 the main program carries on into the subprogram code below it.'],
  [/unknown position/, 'The first moves don\'t say where the tool starts, so the viewer can\'t draw them. Start with a G0 to a full X Y Z position.'],
  [/Unknown G-code/, 'Not a standard G code. It may belong to one control brand — check the manual.'],
  [/machine-specific/, 'This code exists on some controls only and doesn\'t change the drawn toolpath.'],
  [/has no (size|description)/, 'The program\'s comments don\'t say what this tool is, so a guess is used. Set the real tool in the Tools tab for accurate checks.'],
  [/Rotary axes/, 'The part turns, so the path is drawn as it would look on the part.'],
];

export function explainIssue(msg) {
  for (const [re, text] of ISSUE_HELP) if (re.test(msg)) return text;
  return '';
}

// ------------------------------------------------------------- the tooltip
let tipEl = null;
let showTimer = 0;
let hideTimer = 0;
let current = null;

function ensureTip() {
  if (tipEl) return tipEl;
  tipEl = document.createElement('div');
  tipEl.className = 'tip';
  tipEl.setAttribute('role', 'tooltip');
  tipEl.id = 'tip';
  document.body.appendChild(tipEl);
  return tipEl;
}

/** Show a tip near a point or element. `content` is text or {title, text, foot}. */
export function showTip(content, x, y, anchor) {
  const el = ensureTip();
  el.innerHTML = '';
  if (typeof content === 'string') el.textContent = content;
  else {
    if (content.title) { const b = document.createElement('b'); b.textContent = content.title; el.appendChild(b); }
    if (content.text) { const p = document.createElement('div'); p.textContent = content.text; el.appendChild(p); }
    if (content.foot) { const f = document.createElement('small'); f.textContent = content.foot; el.appendChild(f); }
  }
  el.classList.add('on');
  const r = anchor ? anchor.getBoundingClientRect() : { left: x, right: x, top: y, bottom: y, width: 0 };
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
  let top = r.bottom + 8;
  if (top + h > innerHeight - 8) top = r.top - h - 8;
  if (!anchor) { left = Math.min(Math.max(8, x + 12), innerWidth - w - 8); top = y + 18; if (top + h > innerHeight - 8) top = y - h - 10; }
  el.style.left = `${left}px`;
  el.style.top = `${Math.max(8, top)}px`;
}

export function hideTip() {
  clearTimeout(showTimer);
  current = null;
  tipEl?.classList.remove('on');
}

function tipTarget(node) {
  const el = node?.closest?.('[data-tip], [title]');
  if (!el) return null;
  if (el.hasAttribute('title')) {
    // use our tooltip instead of the browser's
    if (!el.dataset.tip) el.dataset.tip = el.getAttribute('title');
    if (!el.hasAttribute('aria-label') && !el.textContent.trim()) el.setAttribute('aria-label', el.getAttribute('title'));
    el.removeAttribute('title');
  }
  return el.dataset.tip ? el : null;
}

export function setTip(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  const target = el.closest('label') || el;
  if (text) target.dataset.tip = text;
  else delete target.dataset.tip;
}

export function initTips() {
  for (const [id, text] of Object.entries(TIPS)) setTip(id, text);
  document.querySelectorAll('[data-view]').forEach((b) => { b.dataset.tip = VIEW_TIPS[b.dataset.view] || ''; b.removeAttribute('title'); });
  document.querySelectorAll('.tabs [data-tab]').forEach((b) => { b.dataset.tip = TAB_TIPS[b.dataset.tab] || ''; });
  document.querySelectorAll('.chip.err').forEach((c) => { c.dataset.tip = 'Errors: the control would alarm or the machine would crash. Untick to hide them.'; });
  document.querySelectorAll('.chip.warn').forEach((c) => { c.dataset.tip = 'Warnings: probably a mistake, or risky. Untick to hide them.'; });
  document.querySelectorAll('.chip.info').forEach((c) => { c.dataset.tip = 'Notes: things worth knowing that are not mistakes. Untick to hide them.'; });
  const hud = document.getElementById('hud');
  if (hud) hud.dataset.tip = 'Where the tool is right now, the line being run, the move type, the feed and the spindle.';
  const legend = document.getElementById('legend');
  if (legend) legend.dataset.tip = 'What the toolpath colours mean.';
  document.querySelectorAll('[title]').forEach((el) => tipTarget(el));

  document.addEventListener('mouseover', (e) => {
    const el = tipTarget(e.target);
    if (el === current) return;
    clearTimeout(showTimer);
    if (!el) { if (current) hideTip(); return; }
    current = el;
    showTimer = setTimeout(() => { if (current === el) showTip(el.dataset.tip, 0, 0, el); }, 350);
  });
  document.addEventListener('mouseout', (e) => {
    if (current && !current.contains(e.relatedTarget)) hideTip();
  });
  document.addEventListener('focusin', (e) => {
    // keyboard users only: a mouse click shouldn't pop a tip
    let kb = true;
    try { kb = e.target.matches(':focus-visible'); } catch { /* old browser */ }
    const el = tipTarget(e.target);
    if (kb && el && el.tagName !== 'TEXTAREA') { current = el; showTip(el.dataset.tip, 0, 0, el); }
  });
  document.addEventListener('focusout', hideTip);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
  window.addEventListener('scroll', hideTip, true);
  // touch: press and hold
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') { hideTip(); return; }
    const el = tipTarget(e.target);
    clearTimeout(showTimer);
    if (!el) return;
    showTimer = setTimeout(() => { current = el; showTip(el.dataset.tip, 0, 0, el); clearTimeout(hideTimer); hideTimer = setTimeout(hideTip, 4000); }, 450);
  });
  document.addEventListener('pointerup', (e) => { if (e.pointerType === 'touch') clearTimeout(showTimer); });
}
