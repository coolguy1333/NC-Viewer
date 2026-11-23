// 3D models of cutting tools (mm, Z up, tip at the origin).
import * as THREE from 'three';
import { TOOL_TYPES } from './tools.js';

const SEG = 64;

/**
 * Surface of revolution with optional helical flutes cut into it.
 * @param {Array<[number, number]>} profile [r, z] from the tip upwards
 * @param {{flutes:number, helix:number, fluteLen:number, depth:number}} f
 */
function fluted(profile, f) {
  const maxStep = Math.max(0.05, (f.fluteLen || 1) / 70);
  const pts = [];
  for (let i = 0; i < profile.length; i++) {
    if (i === 0) { pts.push(profile[0]); continue; }
    const [r0, z0] = profile[i - 1], [r1, z1] = profile[i];
    const inFlute = Math.min(z0, z1) < f.fluteLen;
    const len = Math.hypot(r1 - r0, z1 - z0);
    const n = inFlute && f.flutes > 0 ? Math.max(1, Math.ceil(len / maxStep)) : 1;
    for (let k = 1; k <= n; k++) pts.push([r0 + ((r1 - r0) * k) / n, z0 + ((z1 - z0) * k) / n]);
  }
  const rows = pts.length;
  const pos = new Float32Array(rows * (SEG + 1) * 3);
  const R = Math.max(...pts.map((p) => p[0]), 1e-3);
  const tanH = Math.tan(((f.helix || 0) * Math.PI) / 180);
  for (let k = 0; k < rows; k++) {
    const [r, z] = pts[k];
    for (let s = 0; s <= SEG; s++) {
      const th = (s / SEG) * Math.PI * 2;
      let rr = r;
      if (f.flutes > 0 && z < f.fluteLen + 1e-6) {
        const fade = Math.min(1, Math.max(0, (f.fluteLen - z) / (0.06 * f.fluteLen + 0.2)));
        const twist = (z * tanH) / R;
        let u = ((th + twist) * f.flutes) / (Math.PI * 2);
        u -= Math.floor(u);
        const g = u < 0.4 ? Math.sin((Math.PI * u) / 0.4) : 0;
        rr = r * (1 - f.depth * g * fade);
      }
      const o = (k * (SEG + 1) + s) * 3;
      pos[o] = rr * Math.cos(th);
      pos[o + 1] = rr * Math.sin(th);
      pos[o + 2] = z;
    }
  }
  const idx = [];
  for (let k = 0; k < rows - 1; k++) {
    for (let s = 0; s < SEG; s++) {
      const a = k * (SEG + 1) + s, b = a + 1, c = a + SEG + 1, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function arcPts(cx, cz, r, a0, a1, n = 12) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]);
  }
  return out;
}

function threads(r0, r1, zStart, zEnd, pitch) {
  const out = [];
  const p = Math.max(pitch || 1, 0.2);
  let z = zStart;
  let up = true;
  while (z < zEnd) {
    out.push([up ? r1 : r0, z]);
    z += p / 2;
    up = !up;
  }
  out.push([r1, zEnd]);
  return out;
}

const mats = new Map();
function mat(color, metal = 0.85, rough = 0.32) {
  const k = `${color}|${metal}|${rough}`;
  if (!mats.has(k)) mats.set(k, new THREE.MeshStandardMaterial({ color, metalness: metal, roughness: rough }));
  return mats.get(k);
}

/** Build the tool (and optionally its holder). */
export function buildToolMesh(tool, { holder = true } = {}) {
  const group = new THREE.Group();
  const R = Math.max(tool.dia / 2, 0.05);
  const F = Math.max(tool.flute || R * 6, 0.1);
  const S = Math.max(tool.stickout || F + 10, F);
  const type = tool.type in TOOL_TYPES ? tool.type : 'flat';
  const info = TOOL_TYPES[type];
  const body = mat(info.color);
  const flutes = tool.flutes || info.flutes;
  let profile;
  let fl = { flutes, helix: info.helix, fluteLen: F, depth: 0.22 };
  const Rs = R;
  const neck = (r) => [[r, F], [Rs * 0.96, F + Math.min(1.5, R * 0.3)], [Rs * 0.96, S], [0, S]];

  switch (type) {
    case 'ball':
      profile = [...arcPts(0, R, R, -Math.PI / 2, 0), ...neck(R)];
      break;
    case 'bull': {
      const cr = Math.min(Math.max(tool.cr || 0, 0), R);
      profile = [[0, 0], [R - cr, 0], ...arcPts(R - cr, cr, cr, -Math.PI / 2, 0, 8), ...neck(R)];
      break;
    }
    case 'drill':
    case 'spot': {
      const half = ((tool.angle || (type === 'drill' ? 118 : 90)) * Math.PI) / 360;
      const tipH = R / Math.tan(half);
      profile = [[0, 0], [R, tipH], ...neck(R)];
      fl = { flutes: 2, helix: type === 'drill' ? 30 : 15, fluteLen: F, depth: 0.32 };
      break;
    }
    case 'chamfer':
    case 'vbit': {
      const half = ((tool.angle || 90) * Math.PI) / 360;
      const tipR = Math.min((tool.tip || 0) / 2, R * 0.9);
      const coneH = (R - tipR) / Math.tan(half);
      profile = [[0, 0], [tipR, 0], [R, coneH], [R, Math.max(coneH + R * 0.2, Math.min(S, coneH + 2))], [R * 0.9, Math.max(coneH + R * 0.3, Math.min(S, coneH + 3))], [R * 0.9, S], [0, S]];
      fl = { flutes: type === 'vbit' ? 2 : flutes, helix: 0, fluteLen: coneH, depth: 0.3 };
      break;
    }
    case 'tap': {
      const p = tool.pitch || 1;
      const chamferH = Math.min(2.5 * p, F * 0.3);
      profile = [[0, 0], [R * 0.72, 0], ...threads(R * 0.8, R, chamferH * 0.4, F, p).map(([r, z]) => [z < chamferH ? Math.min(r, R * 0.78 + (R * 0.22 * z) / chamferH) : r, z]), [R * 0.8, F + p], [R * 0.8, S], [0, S]];
      fl = { flutes: Math.max(3, flutes || 3), helix: 0, fluteLen: F, depth: 0.3 };
      break;
    }
    case 'threadmill': {
      const p = tool.pitch || 1;
      profile = [[0, 0], [R * 0.75, 0], ...threads(R * 0.68, R, p * 0.3, F, p), [R * 0.68, F + 1], [Math.max(R * 0.7, R), F + 3], [R, S], [0, S]];
      fl = { flutes: 3, helix: 0, fluteLen: F, depth: 0.25 };
      break;
    }
    case 'reamer':
      profile = [[0, 0], [R * 0.9, 0], [R, R * 0.15], ...neck(R)];
      fl = { flutes: 6, helix: 5, fluteLen: F, depth: 0.12 };
      break;
    case 'face': {
      const H = Math.max(F, R * 0.35);
      const arbor = Math.max(R * 0.32, Math.min(8, R * 0.6));
      profile = [[0, 0], [R * 0.95, 0], [R * 0.95, H], [R * 0.7, H + R * 0.12], [arbor, H + R * 0.16], [arbor, S], [0, S]];
      fl = { flutes: 0, helix: 0, fluteLen: 0, depth: 0 };
      const ins = mat('#e4b74a', 0.6, 0.35);
      const n = Math.max(3, flutes || 5);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const sz = Math.max(1.5, R * 0.18);
        const b = new THREE.Mesh(new THREE.BoxGeometry(sz, sz * 0.35, sz), ins);
        b.position.set((R - sz / 2) * Math.cos(a), (R - sz / 2) * Math.sin(a), sz / 2);
        b.rotation.z = a + Math.PI / 2;
        group.add(b);
        // chip pocket
        const pocket = new THREE.Mesh(new THREE.BoxGeometry(sz * 1.2, sz * 0.9, H * 0.9), mat('#3b4049', 0.3, 0.7));
        pocket.position.set((R * 0.85) * Math.cos(a + 0.18), (R * 0.85) * Math.sin(a + 0.18), H * 0.45);
        pocket.rotation.z = a;
        group.add(pocket);
      }
      break;
    }
    case 'boring': {
      const barR = Math.max(R * 0.32, 0.5);
      profile = [[0, R * 0.25], [barR, R * 0.25], [barR, S], [0, S]];
      fl = { flutes: 0, helix: 0, fluteLen: 0, depth: 0 };
      const len = R + barR * 0.2;
      const insert = new THREE.Mesh(new THREE.BoxGeometry(len, barR * 1.1, R * 0.35 + 0.3), mat('#e4b74a', 0.6, 0.35));
      insert.position.set(len / 2 - barR * 0.2, 0, R * 0.25 / 2 + 0.15);
      group.add(insert);
      break;
    }
    default:
      profile = [[0, 0], [R, 0], ...neck(R)];
  }
  const geo = fluted(profile, fl);
  group.add(new THREE.Mesh(geo, body));

  if (holder) group.add(buildHolder(Rs, S));
  return group;
}

const holderMat = (color) => new THREE.MeshStandardMaterial({ color, metalness: 0.6, roughness: 0.45, transparent: true, opacity: 0.55, depthWrite: false });
let holderMats = null;

function buildHolder(Rs, S) {
  const g = new THREE.Group();
  // See-through so the toolpath under it stays visible from above.
  holderMats ??= [holderMat('#6b727c'), holderMat('#454a52')];
  const [grey, dark] = holderMats;
  const nutR = Math.max(Rs * 1.7 + 4, 9);
  const nut = new THREE.Mesh(new THREE.CylinderGeometry(nutR, nutR * 0.92, 12, 6, 1), grey);
  nut.rotation.x = Math.PI / 2;
  nut.position.z = S + 6;
  g.add(nut);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(nutR * 1.6, nutR * 1.05, 26, 40, 1), dark);
  body.rotation.x = Math.PI / 2;
  body.position.z = S + 12 + 13;
  g.add(body);
  const flange = new THREE.Mesh(new THREE.CylinderGeometry(Math.max(32, nutR * 2), Math.max(32, nutR * 2), 12, 48, 1), grey);
  flange.rotation.x = Math.PI / 2;
  flange.position.z = S + 38 + 6;
  g.add(flange);
  const taper = new THREE.Mesh(new THREE.CylinderGeometry(14, 22, 40, 40, 1), dark);
  taper.rotation.x = Math.PI / 2;
  taper.position.z = S + 50 + 20;
  g.add(taper);
  g.userData.holder = true;
  return g;
}
