// Lathe inserts, printer nozzle, laser head and plasma torch models.
// Loaded on demand (see registerSpecialTools in toolmesh.js).
import * as THREE from 'three';
import { mat } from './toolmesh.js';

// ------------------------------------------------- lathe / printer / laser
const insertMat = () => mat('#d8b45a', 0.55, 0.35);
const shankMat = () => mat('#6b727c', 0.7, 0.4);

/** Flat plate from a 2D outline in the world XZ plane (y thickness centred). */
function plate(pts, thick, material) {
  const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, z)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false });
  g.rotateX(Math.PI / 2);
  g.translate(0, thick / 2, 0);
  return new THREE.Mesh(g, material);
}

function box(w, h, d, x, y, z, material) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  return m;
}

export function buildSpecial(tool, { holder, lathe }) {
  const t = tool.type;
  const g = new THREE.Group();
  if (t === 'turn' || t === 'thread' || t === 'groove') {
    const L = 12, T = 4;
    if (t === 'turn') {
      const a = ((tool.angle || 80) * Math.PI) / 180;
      const bis = (60 * Math.PI) / 180; // insert points down toward the part, leading edge toward the chuck
      const d1 = [Math.cos(bis + a / 2), Math.sin(bis + a / 2)], d2 = [Math.cos(bis - a / 2), Math.sin(bis - a / 2)];
      if (a >= Math.PI - 0.01) {
        // round insert
        const r = 6;
        const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, T, 32), insertMat());
        c.rotation.x = Math.PI / 2;
        c.position.set(0, 0, r);
        g.add(c);
      } else {
        g.add(plate([[0, 0], [L * d1[0], L * d1[1]], [L * (d1[0] + d2[0]), L * (d1[1] + d2[1])], [L * d2[0], L * d2[1]]], T, insertMat()));
      }
    } else if (t === 'thread') {
      const h = 8, half = Math.tan(Math.PI / 6) * h;
      g.add(plate([[0, 0], [half, h], [-half, h]], T, insertMat()));
      g.add(box(2 * half + 4, T + 2, 6, 2, 0, h + 3, insertMat()));
    } else {
      const w = Math.max(tool.dia || 3, 0.5), depth = Math.max(tool.flute || 12, 4);
      g.add(box(w, T, depth, 0, 0, depth / 2, insertMat()));
    }
    if (holder) {
      const S = Math.max(tool.stickout || 40, 20);
      g.add(box(16, 16, S, t === 'turn' ? 8 : 0, 0, 10 + S / 2, shankMat()));
    }
    return g;
  }
  if (t === 'boring' && lathe) {
    // bar along +X (out of the bore), insert pointing outward (+Z)
    const R = Math.max((tool.dia || 10) / 2, 1);
    const S = Math.max(tool.flute || 40, 20) + 20;
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.8, R * 0.8, S, 24), shankMat());
    bar.rotation.z = Math.PI / 2;
    bar.position.set(S / 2 + 1, 0, -R * 0.6);
    g.add(bar);
    g.add(plate([[0, 0], [3, -3], [1, -6], [-2, -3]], 3, insertMat()));
    g.userData.prerotated = true;
    return g;
  }
  if (t === 'nozzle') {
    const d = Math.max(tool.dia || 0.4, 0.1);
    const brass = mat('#c9a64a', 0.8, 0.3);
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(3, d / 2 + 0.4, 2.5, 24), brass);
    tip.rotation.x = Math.PI / 2;
    tip.position.z = 1.25;
    g.add(tip);
    const hex = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 3, 6), brass);
    hex.rotation.x = Math.PI / 2;
    hex.position.z = 4;
    g.add(hex);
    g.add(box(20, 16, 11, 4, 0, 11, mat('#b9c0c9', 0.6, 0.4))); // heater block
    const brk = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 6, 16), mat('#8a929e', 0.7, 0.4));
    brk.rotation.x = Math.PI / 2;
    brk.position.z = 19.5;
    g.add(brk);
    if (holder) g.add(box(24, 24, 26, 0, 0, 35, mat('#3a3f47', 0.2, 0.6))); // heatsink + fan
    return g;
  }
  if (t === 'laser' || t === 'plasma') {
    if (t === 'laser') {
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.2, Math.max((tool.dia || 0.15) / 2, 0.1), 8, 16, 1, true),
        new THREE.MeshBasicMaterial({ color: '#ff3b3b', transparent: true, opacity: 0.55, depthWrite: false }));
      beam.rotation.x = Math.PI / 2;
      beam.position.z = 4;
      g.add(beam);
      const nose = new THREE.Mesh(new THREE.CylinderGeometry(4, 3, 4, 24), mat('#8a929e', 0.7, 0.4));
      nose.rotation.x = Math.PI / 2;
      nose.position.z = 10;
      g.add(nose);
      g.add(box(30, 30, 40, 0, 0, 32, mat('#2f343b', 0.3, 0.55)));
    } else {
      const copper = mat('#c27a4f', 0.8, 0.3);
      const nz = new THREE.Mesh(new THREE.CylinderGeometry(6, 2.5, 8, 24), copper);
      nz.rotation.x = Math.PI / 2;
      nz.position.z = 4;
      g.add(nz);
      const body = new THREE.Mesh(new THREE.CylinderGeometry(11, 9, 50, 24), mat('#3a3f47', 0.4, 0.5));
      body.rotation.x = Math.PI / 2;
      body.position.z = 33;
      g.add(body);
      const arc = new THREE.Mesh(new THREE.ConeGeometry(Math.max((tool.dia || 1.5) / 2, 0.3), 3, 12), new THREE.MeshBasicMaterial({ color: '#9fd4ff', transparent: true, opacity: 0.7 }));
      arc.rotation.x = -Math.PI / 2;
      arc.position.z = -1.5;
      g.add(arc);
    }
    return g;
  }
  return null;
}
