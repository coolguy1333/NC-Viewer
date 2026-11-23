# NC Viewer

A browser-based G-code / NC viewer and verifier for mills and routers (3–5 axis), lathes,
lasers / plasma cutters and 3D printers. Paste or open a program, enter your stock size, and it
checks the code and shows it running in 3D with real tool models.

Everything runs in the browser (plain HTML/JS + vendored three.js). No build step, no external
services.

## Features

- **Paste, open, or drop** G-code (`.nc`, `.ngc`, `.gcode`, `.tap`, `.cnc`, `.mpf`, …) or load one of
  11 demos. The editor is highlighted and re-checks as you type.
- **Any machine**: mills and routers (3-axis plus 4th/5th-axis rotary), **lathes**, **lasers / plasma**
  and **3D printers**. The machine is auto-detected, or pick it in the Stock tab.
- **Stock / material size** per machine: block or round bar (mill), bar diameter, length and bore
  (lathe, drawn in a chuck), sheet (laser), bed and build height (printer); where program zero is;
  material. **Fit stock to toolpath** sizes it for you; a `(STOCK 100 X 80 X 12)` comment is read
  when you open a file.
- **3D view**: Iso/Top/Front/Right/Back/Left, perspective/orthographic, color by move type, tool or
  depth, live **material removal** (height map on mills and lasers, revolved profile on lathes),
  chips/sparks, camera follow, click a toolpath line to jump to its code.
- **Tools** with 3D models: end mills (flat, ball, bull), face mills, drills, spot drills, chamfer
  mills, V-bits, taps, thread mills, reamers, boring bars, lathe turning/grooving/threading
  inserts (ISO codes like `CNMG 120408` are read), printer nozzle, laser head, plasma torch.
  Read from program comments and editable in the Tools tab.
- **Playback** 1×–1000×, step by line, scrub; the running line is highlighted in the editor.
- **Run time** from the program feeds plus rapid XY/Z rates, acceleration and tool-change time
  (Settings).
- **Convert air moves to G0** (with Undo) shows the time saved.

## G-code the interpreter runs

| Area | Supported |
| --- | --- |
| Motion | G0 G1 G2 G3 (IJK or R, helical, multi-turn P), G5/G5.1 splines, G12/G13 circle pockets, G33 threading, G38.x probing, G17/G18/G19 planes |
| Cycles (mill) | G73 G74 G76 G81–G89 with G98/G99, L/K repeats, G91 incremental |
| Cycles (lathe) | G70 G71 G72 G73 (P/Q profiles), G74 G75 peck/groove, G76 threading (Fanuc two-block and LinuxCNC), G90 G92 G94, G32; X in diameter, U/W incremental, G96/G97 constant surface speed with G50 limit |
| Coordinates | G20/G21, G90/G91, G90.1/G91.1, G54–G59 and G54.1 with G10 L2/L20 offsets, G52, G92, G53, G28/G30 to a set home, G16 polar, G68 rotation, G51 scaling, G51.1 mirror, G7/G8 |
| Compensation | G41/G42 cutter compensation (offset path, gouge warning), G41.1/G42.1, G43/G44/G49, G43.4/G234 TCP |
| Rotary | A/B/C axes, drawn in the part frame (rotary table centred on program zero) |
| Macros | Fanuc/Haas macro B: `#` variables, expressions and functions, IF…GOTO, IF…THEN, WHILE…DO/END, GOTO, G65 with arguments, `#3000` alarms, position and offset system variables; LinuxCNC o-words: sub/call/return, if/elseif/else, while, do-while, repeat, break/continue, named `#<params>` |
| Subprograms | M98 P L, M97 (Haas), M99, nested 16 deep |
| 3D printers | E absolute/relative (M82/M83), G92 E, retractions (also G10/G11), temperatures (M104/M109/M140/M190), layers, filament use |
| Lasers / plasma | M3/M4/M5 with S power, beam-off travel, through-cut simulation |

## What "verify" checks

| Kind | Checks |
| --- | --- |
| Syntax | unknown/malformed words, unclosed comments, duplicate words, G codes from the same modal group on one line, bad expressions, missing GOTO labels / END / endif |
| Program | units set before moving, end code, code after the end, M6 without T, G43 H mismatch, missing G43 after a tool change, missing subprograms, endless loops, macro alarms |
| Motion | feed moves without F, arcs without I/J/K or R, arc end point off the circle, unreachable R arcs, cycle R/Z/Q problems, cutter-compensation gouges |
| Mill crash checks | **rapids through material**, cutting with the spindle off, drills/taps moving sideways, cutting deeper than the flute length, **holder hitting the stock**, cutting below the stock, tap feed ≠ pitch × rpm |
| Lathe | rapids into the part, cutting with the spindle off, crossing the centre line, G96 without a spindle limit |
| Laser / printer | cuts off the sheet, beam never on; moves outside the build volume, extruding below the bed, extruding before the hotend is heated, first-layer height |
| Machine | spindle speed and feed above your limits |

Not simulated: tool-nose radius compensation on lathes, lathe live tooling (C axis), G68.2 tilted
planes, G66 modal macros, subprograms in other files. Rotary jobs are drawn, but material removal is
off for them.

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
npm test                   # interpreter / verifier tests (Node 18+, no dependencies)
```

## Layout

```
server.py            stdlib static server + /api/health (for app hosting)
Dockerfile           WebManager app image
webmanager.json      WebManager app settings
static/              the whole app (deployable as a static site)
  index.html
  css/style.css
  js/expr.js         line lexer + macro expression parser
  js/gcode.js        G-code interpreter (all machines, macros, cycles, compensation)
  js/analyze.js      timing, stats, verification
  js/sim.js          material removal (height map; lathe profile)
  js/tools.js        tool types, comment parsing, cutting profiles
  js/toolmesh.js     3D tool models
  js/viewer.js       three.js scene
  js/editor.js       highlighted code editor
  js/main.js         UI wiring
  js/demos.js        demo programs
  vendor/three/      three.js r170 (MIT)
tests/               node --test
```
