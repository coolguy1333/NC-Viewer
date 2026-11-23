# NC Viewer

A browser-based G-code / NC viewer and verifier for 3-axis mills and routers.
Paste or open a program, enter your stock size, and it checks the code and
shows it cutting in 3D with real tool models.

Everything runs in the browser (plain HTML/JS + vendored three.js). No build
step, no external services.

## Features

- **Paste, open, or drop** `.nc`, `.ngc`, `.gcode`, `.tap`, `.cnc`, `.mpf`, … files. The editor
  is syntax-highlighted and editable; changes re-check automatically.
- **Stock / material size**: length, width, thickness (mm or inch), where program zero is
  (any corner, center, or a custom position; Z0 on top or bottom), and material.
  **Fit stock to toolpath** sizes it for you. A `(STOCK 100 X 80 X 12)` comment is read
  automatically when you open a file.
- **3D view**: toolpath colored by move type or tool, translucent stock or a live
  **material-removal simulation**, grid and axes, Iso/Top/Front/Right views,
  perspective/orthographic, click a toolpath line to jump to its code.
- **Tools**: flat, ball and bull-nose end mills, face mills, drills, spot drills,
  chamfer mills/countersinks, engraving V-bits, taps, thread mills, reamers and boring bars,
  each with a 3D model (fluted bodies, drill points, threads, inserts) and holder.
  Tools are read from program comments (Fusion 360, Mastercam, `D=6.`, `1/4 FLAT ENDMILL`,
  `M6x1 TAP`, `1/4-20 TAP`, …) and can be edited in the **Tools** tab.
- **Playback**: play/pause, step line by line, scrub, 1×–1000× real time; the running line
  is highlighted in the editor. Estimated run time per tool.

## What "verify" checks

| Kind | Checks |
| --- | --- |
| Syntax | unknown/malformed words, unclosed comments, duplicate words, G codes from the same modal group on one line, macros (`#`) not supported |
| Program | units (G20/G21) set before moving, end code (M30/M2), code after the end, M6 without T, G43 H that doesn't match the tool, a tool change without G43, cutter comp without D, units changing mid-program |
| Motion | feed moves without F, arcs without I/J/K or R, arc end point not on the circle, R arcs that can't reach, canned cycles missing R/Z/Q or with Z above R |
| Crash (needs stock) | **rapid (G0) moves through material**, cutting with the spindle off, drills/taps/reamers moving sideways in material, cutting deeper than the flute length, **holder hitting the stock**, cutting below the stock bottom, no move touching the stock |
| Tools | tap feed ≠ pitch × rpm, tap without G84/G74, G84 with a non-tap tool, reverse spindle while cutting |
| Machine | spindle speed and feed above your machine's limits (Settings tab) |

Crash checks run on a height-map simulation of the stock, so a rapid inside an already
cut pocket isn't flagged but a rapid through uncut material is.

Not simulated: cutter compensation (the programmed path is shown), rotary axes, subprograms
(M98), macros, and machine-coordinate moves (G53/G28 home).

## Hosting with WebManager

Two ways, both from this repository:

- **Static site (simplest)** — in WebManager **Sources**, connect this repo and tick the
  `static` folder (it has `index.html`). No server process needed.
- **App** — the repo root has a `Dockerfile` and `webmanager.json` (health check
  `/api/health`, 64 MB), so **Deploy as an app** works too. `server.py` is a tiny
  standard-library server for `static/`.

## Run locally

```bash
python3 server.py          # http://localhost:8080  (PORT=... to change)
npm test                   # parser / verifier tests (Node 18+, no dependencies)
```

## Layout

```
server.py            stdlib static server + /api/health (for app hosting)
Dockerfile           WebManager app image
webmanager.json      WebManager app settings
static/              the whole app (deployable as a static site)
  index.html
  css/style.css
  js/gcode.js        G-code parser (modal state, arcs, canned cycles)
  js/analyze.js      timing, stats, verification
  js/sim.js          height-map material removal
  js/tools.js        tool types, comment parsing, cutting profiles
  js/toolmesh.js     3D tool models
  js/viewer.js       three.js scene
  js/editor.js       highlighted code editor
  js/main.js         UI wiring
  vendor/three/      three.js r170 (MIT)
tests/               node --test
```
