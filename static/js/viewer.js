// three.js scene: toolpath, stock (box or material-removal mesh), tool, grid.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { RAPID, FEED, ARC, DRILL, TRAVEL } from './gcode.js';
import { buildToolMesh } from './toolmesh.js';

export const PATH_COLORS = {
  [RAPID]: new THREE.Color('#ff8c42'),
  [FEED]: new THREE.Color('#4fa3ff'),
  [ARC]: new THREE.Color('#8f9bff'),
  [DRILL]: new THREE.Color('#ff7ad9'),
  [TRAVEL]: new THREE.Color('#8a94a6'),
};
const isNonCut = (t) => t === RAPID || t === TRAVEL;
const TOOL_PALETTE = ['#4fc3f7', '#ff8a65', '#81c784', '#ba68c8', '#ffd54f', '#4db6ac', '#f06292', '#9575cd', '#aed581', '#64b5f6'];
export const toolColor = (i) => TOOL_PALETTE[((i % TOOL_PALETTE.length) + TOOL_PALETTE.length) % TOOL_PALETTE.length];

/** Shallow → deep: cyan, green, yellow, orange, red. */
export function depthColor(f, out = new THREE.Color()) {
  f = Math.min(1, Math.max(0, f || 0));
  return out.setHSL((190 - 190 * f) / 360, 0.85, 0.58);
}

export const MATERIALS = {
  aluminum: { label: 'Aluminum', color: '#b9c0c9', cut: '#e3e8ee', metal: 0.55, rough: 0.38 },
  steel: { label: 'Steel', color: '#8d939b', cut: '#c3c8cf', metal: 0.6, rough: 0.4 },
  stainless: { label: 'Stainless', color: '#a7adb5', cut: '#d6dbe1', metal: 0.6, rough: 0.33 },
  brass: { label: 'Brass', color: '#c9a64a', cut: '#e8cd7a', metal: 0.6, rough: 0.35 },
  copper: { label: 'Copper', color: '#c27a4f', cut: '#e3a27c', metal: 0.6, rough: 0.35 },
  plastic: { label: 'Plastic (Delrin/HDPE)', color: '#e9e6dc', cut: '#f7f5ee', metal: 0, rough: 0.6 },
  polycarb: { label: 'Polycarbonate', color: '#9fc6d9', cut: '#c9e3ef', metal: 0, rough: 0.25 },
  wood: { label: 'Wood', color: '#b98a57', cut: '#d9b27f', metal: 0, rough: 0.85 },
  mdf: { label: 'MDF', color: '#9c7d5a', cut: '#b99a74', metal: 0, rough: 0.9 },
  foam: { label: 'Foam / tooling board', color: '#d97b4a', cut: '#eb9d72', metal: 0, rough: 0.95 },
};

export class Viewer {
  constructor(container) {
    this.container = container;
    const renderer = (this.renderer = new THREE.WebGLRenderer({ antialias: true }));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    const scene = (this.scene = new THREE.Scene());
    scene.background = new THREE.Color('#14181f');
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.55;

    this.persp = new THREE.PerspectiveCamera(40, 1, 0.1, 100000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -100000, 100000);
    for (const c of [this.persp, this.ortho]) c.up.set(0, 0, 1);
    this.camera = this.persp;
    this.persp.position.set(150, -200, 150);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.screenSpacePanning = true;

    scene.add(new THREE.HemisphereLight(0xdfe8f5, 0x30343c, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(1, -1.4, 2.2);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xbcd0ff, 0.5);
    fill.position.set(-2, 1.5, 0.8);
    scene.add(fill);

    this.gridGroup = new THREE.Group();
    this.axesGroup = new THREE.Group();
    this.stockGroup = new THREE.Group();
    this.pathGroup = new THREE.Group();
    this.toolGroup = new THREE.Group();
    this.hlGroup = new THREE.Group();
    scene.add(this.gridGroup, this.axesGroup, this.stockGroup, this.pathGroup, this.hlGroup, this.toolGroup);

    this.hlMat = new LineMaterial({ color: 0xffffff, linewidth: 3, depthTest: false, transparent: true });
    this.partialLine = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3)), new THREE.LineBasicMaterial({ color: 0xffffff }));
    this.partialLine.frustumCulled = false;
    this.pathGroup.add(this.partialLine);

    this.bounds = new THREE.Box3(new THREE.Vector3(-50, -50, -10), new THREE.Vector3(50, 50, 10));
    this.chips = new Chips();
    scene.add(this.chips.points);
    this.onFrame = null;
    this.toolSpin = 0;
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(container);
    this.resize();
    let last = performance.now();
    renderer.setAnimationLoop((now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (this.onFrame) this.onFrame(dt);
      if (this.toolSpin && this.toolInner) {
        const k = this.toolInner.children[0];
        if (k) k.rotation.z += this.toolSpin * dt;
      }
      this.chips.update(dt);
      this.controls.update();
      renderer.render(scene, this.camera);
    });
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this._orthoFrustum();
    this.hlMat.resolution.set(w, h);
  }

  _orthoFrustum() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    const size = this.bounds.getSize(new THREE.Vector3()).length() || 100;
    const half = size * 0.6;
    this.ortho.left = (-half * w) / h;
    this.ortho.right = (half * w) / h;
    this.ortho.top = half;
    this.ortho.bottom = -half;
    this.ortho.updateProjectionMatrix();
  }

  setProjection(ortho) {
    const from = this.camera;
    const to = ortho ? this.ortho : this.persp;
    if (from === to) return;
    const target = this.controls.target.clone();
    to.position.copy(from.position);
    to.quaternion.copy(from.quaternion);
    if (ortho) {
      this._orthoFrustum();
      const dist = from.position.distanceTo(target);
      const size = this.bounds.getSize(new THREE.Vector3()).length() || 100;
      this.ortho.zoom = (size * 1.2) / Math.max(1e-3, 2 * dist * Math.tan((this.persp.fov * Math.PI) / 360));
      this.ortho.updateProjectionMatrix();
    }
    this.camera = to;
    this.controls.dispose();
    this.controls = new OrbitControls(to, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.screenSpacePanning = true;
    this.controls.target.copy(target);
  }

  // ------------------------------------------------------------- toolpath
  setPath(segs, { colorBy = 'type', showRapids = true, showFeeds = true } = {}) {
    for (const o of [this.pathAll, this.pathDone]) {
      if (o) { this.pathGroup.remove(o); o.geometry.dispose(); o.material.dispose(); }
    }
    this.segs = segs;
    const n = segs.n;
    const pos = new Float32Array(n * 6);
    const col = new Float32Array(n * 8);
    const c = new THREE.Color();
    let zHi = -Infinity, zLo = Infinity;
    if (colorBy === 'depth') {
      for (let i = 0; i < n; i++) {
        if (isNonCut(segs.type[i])) continue;
        for (const k of [2, 5]) { const z = segs.p[i * 6 + k]; if (z > zHi) zHi = z; if (z < zLo) zLo = z; }
      }
      if (!(zHi > zLo)) { zHi = zLo + 1; }
    }
    this.depthRange = colorBy === 'depth' ? [zLo, zHi] : null;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 6; k++) pos[i * 6 + k] = segs.p[i * 6 + k];
      const t = segs.type[i];
      const a = isNonCut(t) ? (showRapids ? (t === TRAVEL ? 0.45 : 0.75) : 0) : (showFeeds ? 1 : 0);
      for (const [v, zk] of [[0, 2], [4, 5]]) {
        if (isNonCut(t)) c.copy(PATH_COLORS[t]);
        else if (colorBy === 'tool') c.set(toolColor(segs.tool[i]));
        else if (colorBy === 'depth') depthColor((zHi - segs.p[i * 6 + zk]) / (zHi - zLo), c);
        else c.copy(PATH_COLORS[t]);
        col[i * 8 + v] = c.r; col[i * 8 + v + 1] = c.g; col[i * 8 + v + 2] = c.b; col[i * 8 + v + 3] = a;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
    geo.computeBoundingBox();
    this.pathAll = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.22, depthWrite: false }));
    this.pathDone = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 1 }));
    this.pathAll.frustumCulled = this.pathDone.frustumCulled = false;
    this.pathAll.renderOrder = 1;
    this.pathDone.renderOrder = 2;
    this.pathGroup.add(this.pathAll, this.pathDone);
    this.showRapids = showRapids;
    this.showFeeds = showFeeds;
    this.pathBox = n ? geo.boundingBox.clone() : null;
    this.setProgress(n, 0, null);
  }

  setPathVisible(v) { this.pathGroup.visible = v; }

  /** Segments [0, i) fully done, segment i done up to `pos`. */
  setProgress(i, frac, pos) {
    if (!this.pathDone) return;
    this.pathDone.geometry.setDrawRange(0, i * 2);
    const pl = this.partialLine;
    if (pos && i < this.segs.n && frac > 0) {
      const o = i * 6;
      const a = pl.geometry.attributes.position.array;
      a[0] = this.segs.p[o]; a[1] = this.segs.p[o + 1]; a[2] = this.segs.p[o + 2];
      a[3] = pos[0]; a[4] = pos[1]; a[5] = pos[2];
      pl.geometry.attributes.position.needsUpdate = true;
      const t = this.segs.type[i];
      pl.material.color.copy(PATH_COLORS[t]);
      pl.visible = isNonCut(t) ? this.showRapids : this.showFeeds;
    } else pl.visible = false;
  }

  highlight(i0, i1) {
    for (const o of this.hlGroup.children) o.geometry.dispose();
    this.hlGroup.clear();
    if (!this.segs || i0 < 0 || i1 < i0) return;
    const arr = [];
    for (let i = i0; i <= i1; i++) for (let k = 0; k < 6; k++) arr.push(this.segs.p[i * 6 + k]);
    const g = new LineSegmentsGeometry().setPositions(arr);
    const l = new LineSegments2(g, this.hlMat);
    l.renderOrder = 5;
    l.frustumCulled = false;
    this.hlGroup.add(l);
  }

  // ------------------------------------------------------------------ tool
  /** orient: 'z' (default), 'axial' (lathe drill along +X) */
  setTool(tool, opts = {}) {
    for (const c of [...this.toolGroup.children]) this.toolGroup.remove(c);
    this.toolInner = null;
    if (!tool) return;
    const m = buildToolMesh(tool, opts);
    const inner = new THREE.Group();
    inner.add(m);
    if (opts.orient === 'axial') inner.rotation.y = Math.PI / 2;
    this.toolGroup.add(inner);
    this.toolInner = inner;
    this.spinAxis = opts.orient === 'axial' ? 'x' : 'z';
    this.toolGroup.quaternion.identity();
  }

  setToolPos(p, axis) {
    if (p) this.toolGroup.position.set(p[0], p[1], p[2]);
    if (axis) this.toolGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(axis[0], axis[1], axis[2]).normalize());
  }

  setToolVisible(v) { this.toolGroup.visible = v; }

  // ----------------------------------------------------------------- stock
  clearStock() {
    for (const o of [...this.stockGroup.children]) {
      this.stockGroup.remove(o);
      o.traverse?.((x) => { x.geometry?.dispose(); });
    }
    this.stockMesh = null;
  }

  setStockBox(box, material) {
    this.clearStock();
    if (!box) return;
    const m = MATERIALS[material] || MATERIALS.aluminum;
    const size = [box.x1 - box.x0, box.y1 - box.y0, box.z1 - box.z0];
    const geo = new THREE.BoxGeometry(...size);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: m.color, metalness: m.metal, roughness: m.rough, transparent: true, opacity: 0.35, depthWrite: false }));
    mesh.position.set((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, (box.z0 + box.z1) / 2);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: m.color, transparent: true, opacity: 0.9 }));
    edges.position.copy(mesh.position);
    this.stockGroup.add(mesh, edges);
    this.stockBox = box;
  }

  setStockSim(sim, material) {
    this.clearStock();
    this.stockMesh = new StockMesh(sim, MATERIALS[material] || MATERIALS.aluminum);
    this.stockGroup.add(this.stockMesh.group);
    this.stockBox = sim.box;
  }

  updateStockSim() {
    if (this.stockMesh) this.stockMesh.update();
  }

  /** Lathe bar: profile sim revolved around the X axis (lathe Z), plus a chuck. */
  setLatheSim(sim, material) {
    this.clearStock();
    this.stockMesh = new LatheMesh(sim, MATERIALS[material] || MATERIALS.steel);
    this.stockGroup.add(this.stockMesh.group);
  }

  /** Round bar along X for 4th-axis work (display only). */
  setStockCylinder(c, material) {
    this.clearStock();
    const m = MATERIALS[material] || MATERIALS.aluminum;
    const geo = new THREE.CylinderGeometry(c.r, c.r, c.x1 - c.x0, 48, 1);
    geo.rotateZ(Math.PI / 2);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: m.color, metalness: m.metal, roughness: m.rough, transparent: true, opacity: 0.35, depthWrite: false }));
    mesh.position.set((c.x0 + c.x1) / 2, 0, 0);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), new THREE.LineBasicMaterial({ color: m.color, transparent: true, opacity: 0.9 }));
    edges.position.copy(mesh.position);
    this.stockGroup.add(mesh, edges);
  }

  /** Chuck jaws holding a lathe bar at world x = xAt (lathe Z of the back end). */
  addChuck(xAt, r) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(r * 2.2 + 15, r * 2.2 + 15, 30, 48), new THREE.MeshStandardMaterial({ color: '#4a5059', metalness: 0.7, roughness: 0.4 }));
    body.rotation.z = Math.PI / 2;
    body.position.x = xAt - 15 - 12;
    g.add(body);
    for (let k = 0; k < 3; k++) {
      const a = (k * 2 * Math.PI) / 3 + Math.PI / 2;
      const jaw = new THREE.Mesh(new THREE.BoxGeometry(24, 10, r * 1.1 + 10), new THREE.MeshStandardMaterial({ color: '#7b828c', metalness: 0.7, roughness: 0.35 }));
      jaw.position.set(xAt - 12 + 12, Math.cos(a) * (r + (r * 1.1 + 10) / 2), Math.sin(a) * (r + (r * 1.1 + 10) / 2));
      jaw.rotation.x = a - Math.PI / 2;
      g.add(jaw);
    }
    this.stockGroup.add(g);
  }

  // ---------------------------------------------------------- grid & axes
  setScene(bounds, unitsMM, axisNames = ['X', 'Y', 'Z']) {
    this.bounds = bounds;
    this._orthoFrustum();
    for (const g of [this.gridGroup, this.axesGroup]) for (const o of [...g.children]) { g.remove(o); o.geometry?.dispose(); }
    const size = bounds.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, 10);
    let step = unitsMM; // 1 mm or 1 inch
    while (span / step > 40) step *= unitsMM === 1 ? (String(step)[0] === '2' ? 2.5 : 2) : 2;
    const major = step * 5;
    const x0 = Math.floor((bounds.min.x - span * 0.25) / major) * major;
    const x1 = Math.ceil((bounds.max.x + span * 0.25) / major) * major;
    const y0 = Math.floor((bounds.min.y - span * 0.25) / major) * major;
    const y1 = Math.ceil((bounds.max.y + span * 0.25) / major) * major;
    const z = bounds.min.z - 0.01;
    const minor = [], maj = [];
    for (let x = x0; x <= x1 + 1e-6; x += step) (Math.abs(x / major - Math.round(x / major)) < 1e-6 ? maj : minor).push(x, y0, z, x, y1, z);
    for (let y = y0; y <= y1 + 1e-6; y += step) (Math.abs(y / major - Math.round(y / major)) < 1e-6 ? maj : minor).push(x0, y, z, x1, y, z);
    const mk = (arr, color, opacity) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
    };
    this.gridGroup.add(mk(minor, 0x5a6577, 0.18), mk(maj, 0x7d8ba1, 0.35));
    // axes at program zero
    const L = Math.max(span * 0.12, 5);
    const axes = [[L, 0, 0, '#ff5252', axisNames[0]], [0, L, 0, '#69f0ae', axisNames[1]], [0, 0, L, '#448aff', axisNames[2]]];
    for (const [ax, ay, az, color, name] of axes) {
      if (!name) continue;
      this.axesGroup.add(mk([0, 0, 0, ax, ay, az], color, 1));
      const s = label(name, color);
      s.position.set(ax * 1.12, ay * 1.12, az * 1.12);
      s.scale.setScalar(L * 0.22);
      this.axesGroup.add(s);
    }
    this.gridStep = step;
  }

  setGridVisible(v) { this.gridGroup.visible = v; }
  setAxesVisible(v) { this.axesGroup.visible = v; }

  /** Move the camera with the tool (Follow tool). */
  follow(delta) {
    this.camera.position.add(delta);
    this.controls.target.add(delta);
  }

  // ---------------------------------------------------------------- views
  fit(view) {
    const b = this.bounds;
    const center = b.getCenter(new THREE.Vector3());
    const size = b.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 5);
    const dirs = {
      iso: [1, -1.25, 1.1], top: [0, -0.0001, 1], bottom: [0, 0.0001, -1], front: [0, -1, 0.0001], back: [0, 1, 0.0001],
      right: [1, 0, 0.0001], left: [-1, 0, 0.0001],
    };
    const d = view && dirs[view] ? new THREE.Vector3(...dirs[view]) : this.camera.position.clone().sub(this.controls.target);
    d.normalize();
    const dist = radius / Math.sin((this.persp.fov * Math.PI) / 360) * 1.05;
    this.camera.position.copy(center).addScaledVector(d, dist);
    this.controls.target.copy(center);
    if (this.camera === this.ortho) {
      this._orthoFrustum();
      this.ortho.zoom = 1;
      this.ortho.updateProjectionMatrix();
    }
    this.persp.near = Math.max(0.01, dist / 1000);
    this.persp.far = dist * 100;
    this.persp.updateProjectionMatrix();
    this.camera.lookAt(center);
    this.controls.update();
  }

  // -------------------------------------------------------------- picking
  pick(clientX, clientY) {
    if (!this.segs || !this.segs.n) return -1;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const mx = clientX - rect.left, my = clientY - rect.top;
    const w = rect.width, h = rect.height;
    const m = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).elements;
    const { p, type, n } = this.segs;
    const proj = (x, y, z, out) => {
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (cw <= 1e-6) return false;
      out[0] = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw * 0.5 + 0.5) * w;
      out[1] = (1 - ((m[1] * x + m[5] * y + m[9] * z + m[13]) / cw * 0.5 + 0.5)) * h;
      return true;
    };
    const a = [0, 0], b = [0, 0];
    let best = -1, bestD = 64; // 8 px squared
    for (let i = 0; i < n; i++) {
      if (isNonCut(type[i]) ? !this.showRapids : !this.showFeeds) continue;
      const o = i * 6;
      if (!proj(p[o], p[o + 1], p[o + 2], a) || !proj(p[o + 3], p[o + 4], p[o + 5], b)) continue;
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy;
      let t = l2 ? ((mx - a[0]) * dx + (my - a[1]) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = a[0] + t * dx - mx, ey = a[1] + t * dy - my;
      const d = ex * ex + ey * ey;
      if (d <= bestD) { bestD = d; best = i; }
    }
    return best;
  }
}

function label(text, color) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.font = 'bold 44px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 32, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
}

// ------------------------------------------------------------ stock mesh
class StockMesh {
  constructor(sim, material) {
    this.sim = sim;
    const { nx, ny, box } = sim;
    this.base = new THREE.Color(material.color);
    this.cut = new THREE.Color(material.cut);
    const nv = nx * ny;
    const pos = new Float32Array(nv * 3);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const o = (j * nx + i) * 3;
        pos[o] = box.x0 + i * sim.dx;
        pos[o + 1] = box.y0 + j * sim.dy;
        pos[o + 2] = box.z1;
      }
    }
    const top = new THREE.BufferGeometry();
    top.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    top.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
    top.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
    this.top = top;
    const matl = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: material.metal, roughness: material.rough, side: THREE.DoubleSide });
    this.topMesh = new THREE.Mesh(top, matl);

    // walls: perimeter loop, two vertices (top, bottom) per point
    const loop = [];
    for (let i = 0; i < nx; i++) loop.push(i);
    for (let j = 1; j < ny; j++) loop.push(j * nx + nx - 1);
    for (let i = nx - 2; i >= 0; i--) loop.push((ny - 1) * nx + i);
    for (let j = ny - 2; j >= 1; j--) loop.push(j * nx);
    loop.push(0);
    this.loop = loop;
    const wpos = new Float32Array(loop.length * 2 * 3);
    const widx = [];
    for (let k = 0; k < loop.length - 1; k++) {
      const a = k * 2, b = a + 2;
      widx.push(a, a + 1, b, b, a + 1, b + 1);
    }
    const walls = new THREE.BufferGeometry();
    walls.setAttribute('position', new THREE.BufferAttribute(wpos, 3));
    walls.setIndex(widx);
    this.walls = walls;
    this.wallMesh = new THREE.Mesh(walls, new THREE.MeshStandardMaterial({ color: this.base.clone().multiplyScalar(0.8), metalness: material.metal, roughness: material.rough, side: THREE.DoubleSide }));

    this.group = new THREE.Group();
    this.group.add(this.topMesh, this.wallMesh);
    sim.markAll();
    this.update();
  }

  update() {
    const sim = this.sim;
    const d = sim.takeDirty();
    if (d) this._updateTop(d);
    if (sim.throughChanged) {
      this._rebuildIndex();
      sim.throughChanged = false;
    }
    if (d) this._updateWalls();
  }

  _updateTop(d) {
    const { nx, ny, h, box, dx, dy } = this.sim;
    const i0 = Math.max(0, d.i0 - 1), i1 = Math.min(nx - 1, d.i1 + 1);
    const j0 = Math.max(0, d.j0 - 1), j1 = Math.min(ny - 1, d.j1 + 1);
    const pos = this.top.attributes.position.array;
    const nor = this.top.attributes.normal.array;
    const col = this.top.attributes.color.array;
    const z0 = box.z0, z1 = box.z1, depth = Math.max(z1 - z0, 1e-6);
    const H = (i, j) => { const v = h[j * nx + i]; return v < z0 ? z0 : v; };
    const c = new THREE.Color();
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const idx = j * nx + i, o = idx * 3;
        const z = H(i, j);
        pos[o + 2] = z;
        const zl = H(i > 0 ? i - 1 : i, j), zr = H(i < nx - 1 ? i + 1 : i, j);
        const zd = H(i, j > 0 ? j - 1 : j), zu = H(i, j < ny - 1 ? j + 1 : j);
        let gx = -(zr - zl) / (dx * ((i > 0 && i < nx - 1) ? 2 : 1));
        let gy = -(zu - zd) / (dy * ((j > 0 && j < ny - 1) ? 2 : 1));
        const len = Math.hypot(gx, gy, 1);
        nor[o] = gx / len; nor[o + 1] = gy / len; nor[o + 2] = 1 / len;
        if (z < z1 - 1e-3) {
          const f = (z1 - z) / depth;
          c.copy(this.cut).multiplyScalar(1 - 0.35 * f);
        } else c.copy(this.base);
        col[o] = c.r; col[o + 1] = c.g; col[o + 2] = c.b;
      }
    }
    const start = j0 * nx, count = (j1 - j0 + 1) * nx;
    for (const a of [this.top.attributes.position, this.top.attributes.normal, this.top.attributes.color]) {
      a.clearUpdateRanges();
      a.addUpdateRange(start * 3, count * 3);
      a.needsUpdate = true;
    }
    this.top.computeBoundingSphere();
  }

  _rebuildIndex() {
    const { nx, ny, h, box } = this.sim;
    const floor = box.z0 + 1e-4;
    const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
    let k = 0;
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
        if (h[a] <= floor && h[b] <= floor && h[c] <= floor && h[d] <= floor) continue;
        idx[k++] = a; idx[k++] = b; idx[k++] = d;
        idx[k++] = a; idx[k++] = d; idx[k++] = c;
      }
    }
    this.top.setIndex(new THREE.BufferAttribute(idx.slice(0, k), 1));
  }

  _updateWalls() {
    const { nx, h, box, dx, dy } = this.sim;
    const pos = this.walls.attributes.position.array;
    this.loop.forEach((idx, k) => {
      const i = idx % nx, j = Math.floor(idx / nx);
      const x = box.x0 + i * dx, y = box.y0 + j * dy;
      const z = Math.max(box.z0, h[idx]);
      const o = k * 6;
      pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
      pos[o + 3] = x; pos[o + 4] = y; pos[o + 5] = box.z0;
    });
    this.walls.attributes.position.needsUpdate = true;
    this.walls.computeVertexNormals();
    this.walls.computeBoundingSphere();
  }
}

// ---------------------------------------------------------- cutting chips
class Chips {
  constructor(max = 900) {
    this.max = max;
    this.pos = new Float32Array(max * 3).fill(-1e9); // parked out of sight
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.col = new Float32Array(max * 3);
    this.next = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ size: 3, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false }));
    this.points.frustumCulled = false;
    this.color = new THREE.Color('#e3e8ee');
    this.active = 0;
  }

  setColor(hex) { this.color.set(hex); }

  /** Throw chips from the tool edge. */
  emit(at, radius, count, scale, gravityZ) {
    this.gravity = gravityZ;
    for (let k = 0; k < count; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.max;
      const a = Math.random() * Math.PI * 2;
      const o = i * 3;
      this.pos[o] = at[0] + Math.cos(a) * radius;
      this.pos[o + 1] = at[1] + Math.sin(a) * radius;
      this.pos[o + 2] = at[2] + Math.random() * radius * 0.3;
      const sp = scale * (0.6 + Math.random());
      // tangential (spindle spins CW seen from above) plus a bit outward and up
      this.vel[o] = (Math.sin(a) + Math.cos(a) * 0.5) * sp;
      this.vel[o + 1] = (-Math.cos(a) + Math.sin(a) * 0.5) * sp;
      this.vel[o + 2] = (0.6 + Math.random()) * sp * 0.8;
      this.life[i] = 0.5 + Math.random() * 0.5;
      const shade = 0.75 + Math.random() * 0.35;
      this.col[o] = this.color.r * shade; this.col[o + 1] = this.color.g * shade; this.col[o + 2] = this.color.b * shade;
    }
    this.active = this.max;
  }

  update(dt) {
    if (!this.active) return;
    let alive = 0;
    const g = this.gravity || 400;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const o = i * 3;
      if (this.life[i] <= 0) { this.pos[o + 2] = -1e9; continue; }
      alive++;
      this.vel[o + 2] -= g * dt;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
    }
    if (!alive) {
      this.active = 0;
      this.pos.fill(-1e9);
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }
}

// ------------------------------------------------------------ lathe stock
class LatheMesh {
  constructor(sim, material) {
    this.sim = sim;
    this.seg = 64;
    const n = sim.n, seg = this.seg;
    // outer ring vertices, inner ring vertices, plus two end caps built as rings between them
    const count = n * (seg + 1) * 2;
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(count * 3);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    const idx = [];
    const O = (i, k) => i * (seg + 1) + k, I = (i, k) => n * (seg + 1) + i * (seg + 1) + k;
    for (let i = 0; i < n - 1; i++) {
      for (let k = 0; k < seg; k++) {
        idx.push(O(i, k), O(i + 1, k), O(i + 1, k + 1), O(i, k), O(i + 1, k + 1), O(i, k + 1));
        idx.push(I(i, k), I(i + 1, k + 1), I(i + 1, k), I(i, k), I(i, k + 1), I(i + 1, k + 1));
      }
    }
    for (const i of [0, n - 1]) {
      for (let k = 0; k < seg; k++) {
        if (i === 0) idx.push(O(i, k), O(i, k + 1), I(i, k + 1), O(i, k), I(i, k + 1), I(i, k));
        else idx.push(O(i, k), I(i, k + 1), O(i, k + 1), O(i, k), I(i, k), I(i, k + 1));
      }
    }
    this.geo.setIndex(idx);
    this.mesh = new THREE.Mesh(this.geo, new THREE.MeshStandardMaterial({ color: material.cut, metalness: material.metal, roughness: material.rough, side: THREE.DoubleSide }));
    this.group = new THREE.Group();
    this.group.add(this.mesh);
    sim.dirty = true;
    this.update();
  }

  update() {
    const sim = this.sim;
    if (!sim.dirty) return;
    sim.dirty = false;
    const { n, outer, inner, stock, dz } = sim;
    const seg = this.seg, pos = this.pos;
    for (let i = 0; i < n; i++) {
      const x = stock.z0 + i * dz; // lathe Z -> world X
      const ro = Math.max(outer[i], 0), ri = Math.min(Math.max(inner[i], 0), ro);
      for (let k = 0; k <= seg; k++) {
        const a = (k / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
        let o = (i * (seg + 1) + k) * 3;
        pos[o] = x; pos[o + 1] = ro * s; pos[o + 2] = ro * c;
        o = (n * (seg + 1) + i * (seg + 1) + k) * 3;
        pos[o] = x; pos[o + 1] = ri * s; pos[o + 2] = ri * c;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.computeVertexNormals();
    this.geo.computeBoundingSphere();
  }
}
