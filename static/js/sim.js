// Height-map material removal for 3-axis cutting. Pure JS (no DOM).
import { profileAt } from './tools.js';

export class StockSim {
  /**
   * @param {{x0:number,x1:number,y0:number,y1:number,z0:number,z1:number}} box stock in mm
   * @param {number} cells grid cells along the longer side
   */
  constructor(box, cells = 300) {
    this.box = box;
    const w = Math.max(box.x1 - box.x0, 1e-3);
    const h = Math.max(box.y1 - box.y0, 1e-3);
    const cell = Math.max(w, h) / cells;
    this.nx = Math.max(2, Math.ceil(w / cell) + 1);
    this.ny = Math.max(2, Math.ceil(h / cell) + 1);
    this.dx = w / (this.nx - 1);
    this.dy = h / (this.ny - 1);
    this.h = new Float32Array(this.nx * this.ny).fill(box.z1);
    this.step = Math.min(this.dx, this.dy) * 0.95;
    this.kernels = new Map();
    this.markAll();
  }

  reset() {
    this.h.fill(this.box.z1);
    this.markAll();
  }

  markAll() {
    this.dirty = { i0: 0, i1: this.nx - 1, j0: 0, j1: this.ny - 1 };
    this.throughChanged = true;
  }

  takeDirty() {
    const d = this.dirty;
    this.dirty = null;
    return d;
  }

  kernel(tool) {
    const k = `${tool.type}|${tool.dia}|${tool.cr}|${tool.angle}|${tool.tip}`;
    let K = this.kernels.get(k);
    if (K) return K;
    const R = Math.max(tool.dia / 2, 1e-3);
    const ri = Math.ceil(R / this.dx), rj = Math.ceil(R / this.dy);
    // Row-major runs: each kernel row is one contiguous span of cells.
    const rowDj = [], rowI0 = [], rowI1 = [], rowOff = [], dz = [];
    for (let j = -rj; j <= rj; j++) {
      let first = null;
      for (let i = -ri; i <= ri; i++) {
        const z = profileAt(tool, Math.hypot(i * this.dx, j * this.dy));
        if (!Number.isFinite(z)) continue;
        if (first === null) { first = i; rowDj.push(j); rowI0.push(i); rowOff.push(dz.length); }
        dz.push(z);
        rowI1[rowDj.length - 1] = i;
      }
    }
    if (!dz.length) { rowDj.push(0); rowI0.push(0); rowI1.push(0); rowOff.push(0); dz.push(0); }
    K = { rowDj: Int32Array.from(rowDj), rowI0: Int32Array.from(rowI0), rowI1: Int32Array.from(rowI1), rowOff: Int32Array.from(rowOff), dz: Float32Array.from(dz), R, ri, rj };
    this.kernels.set(k, K);
    return K;
  }

  /** Cut along a straight move. Returns the deepest material removed (mm). */
  cutSeg(x0, y0, z0, x1, y1, z1, K) {
    const b = this.box;
    if (z0 >= b.z1 && z1 >= b.z1) return 0;
    const R = K.R;
    if (Math.max(x0, x1) + R < b.x0 || Math.min(x0, x1) - R > b.x1 || Math.max(y0, y1) + R < b.y0 || Math.min(y0, y1) - R > b.y1) return 0;
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1e-9) return this.stamp(x1, y1, Math.min(z0, z1), K);
    const n = Math.max(1, Math.ceil(len / this.step));
    let rem = 0;
    // k = 0 is the previous move's end point, which has already been cut.
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const r = this.stamp(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t, K);
      if (r > rem) rem = r;
    }
    return rem;
  }

  stamp(x, y, z, K) {
    const b = this.box;
    if (z >= b.z1) return 0;
    const nx = this.nx, ny = this.ny, h = this.h;
    const ci = Math.round((x - b.x0) / this.dx);
    const cj = Math.round((y - b.y0) / this.dy);
    if (ci + K.ri < 0 || ci - K.ri >= nx || cj + K.rj < 0 || cj - K.rj >= ny) return 0;
    const { rowDj, rowI0, rowI1, rowOff, dz } = K;
    const floor = b.z0 + 1e-4;
    let rem = 0;
    for (let r = 0, nr = rowDj.length; r < nr; r++) {
      const j = cj + rowDj[r];
      if (j < 0 || j >= ny) continue;
      let i0 = ci + rowI0[r], i1 = ci + rowI1[r], off = rowOff[r];
      if (i0 < 0) { off -= i0; i0 = 0; }
      if (i1 >= nx) i1 = nx - 1;
      const base = j * nx;
      for (let i = i0; i <= i1; i++, off++) {
        const idx = base + i;
        const v = z + dz[off];
        const cur = h[idx];
        if (v < cur) {
          if (cur - v > rem) rem = cur - v;
          if (v <= floor && cur > floor) this.throughChanged = true;
          h[idx] = v;
        }
      }
    }
    if (rem > 0) {
      const i0 = Math.max(0, ci - K.ri), i1 = Math.min(nx - 1, ci + K.ri);
      const j0 = Math.max(0, cj - K.rj), j1 = Math.min(ny - 1, cj + K.rj);
      const d = this.dirty;
      if (!d) this.dirty = { i0, i1, j0, j1 };
      else {
        if (i0 < d.i0) d.i0 = i0;
        if (i1 > d.i1) d.i1 = i1;
        if (j0 < d.j0) d.j0 = j0;
        if (j1 > d.j1) d.j1 = j1;
      }
    }
    return rem;
  }
}
