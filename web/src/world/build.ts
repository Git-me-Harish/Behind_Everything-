import {
  BoxGeometry, BufferGeometry, CapsuleGeometry, CircleGeometry, Color, CylinderGeometry, Float32BufferAttribute, Matrix4,
  Quaternion, SphereGeometry, Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ZONES, type ZoneId } from '../../../src/core/state.ts';
import { DOOR_W, FRONT_WALL_H, ROOM, roomCenter, SLAB, SPAN, WALL_H } from './layout.ts';
import { CAPACITY } from './model.ts';
import { CLAWD_COLS, CLAWD_ROWS, clawdRuns, PIXEL, type ClawdPart } from './clawd.ts';
import { cells, type Cell, type MascotPart } from './mascots.ts';
import type { Palette } from './palette.ts';

/**
 * Procedural low-poly building. Everything static is merged into one vertex-coloured geometry (one draw
 * call for the whole building); the data-bound props are "slots" drawn as instanced boxes.
 */

export const FLOOR = 0.1;
const T = 0.22; // wall thickness
const H = ROOM / 2;

/** Collects primitives with a colour each and merges them. y is the bottom of a box, not its centre. */
class Kit {
  private parts: BufferGeometry[] = [];
  constructor(private ox = 0, private oz = 0) {}

  /** Adds any geometry, centred at (x, y, z). */
  add(g: BufferGeometry, x: number, y: number, z: number, color: Color, rotY = 0) {
    g.deleteAttribute('uv');
    const m = new Matrix4().compose(new Vector3(x + this.ox, y, z + this.oz), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), rotY), new Vector3(1, 1, 1));
    g.applyMatrix4(m);
    const n = g.getAttribute('position').count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.set([color.r, color.g, color.b], i * 3);
    g.setAttribute('color', new Float32BufferAttribute(c, 3));
    this.parts.push(g.index ? g.toNonIndexed() : g);
    return this;
  }

  box(w: number, h: number, d: number, x: number, y: number, z: number, color: Color, rotY = 0) {
    return this.add(new BoxGeometry(w, h, d), x, y + h / 2, z, color, rotY);
  }

  cyl(rTop: number, rBottom: number, h: number, x: number, y: number, z: number, color: Color, segments = 12) {
    return this.add(new CylinderGeometry(rTop, rBottom, h, segments), x, y + h / 2, z, color);
  }

  sphere(r: number, x: number, y: number, z: number, color: Color, segments = 10) {
    return this.add(new SphereGeometry(r, segments, Math.max(6, segments - 3)), x, y, z, color);
  }

  plant(x: number, z: number, p: Palette, scale = 1) {
    this.cyl(0.26 * scale, 0.2 * scale, 0.4 * scale, x, FLOOR, z, p.furniture2, 10);
    return this.sphere(0.42 * scale, x, FLOOR + 0.75 * scale, z, p.leaf, 8);
  }

  table(w: number, d: number, x: number, z: number, top: Color, base: Color, height = 0.74) {
    this.box(w, 0.08, d, x, FLOOR + height - 0.08, z, top);
    this.box(0.08, height - 0.08, d - 0.1, x - w / 2 + 0.12, FLOOR, z, base);
    return this.box(0.08, height - 0.08, d - 0.1, x + w / 2 - 0.12, FLOOR, z, base);
  }

  merge(other: Kit) {
    this.parts.push(...other.parts);
    other.parts = [];
  }

  geometry(): BufferGeometry {
    const g = mergeGeometries(this.parts, false)!;
    for (const part of this.parts) part.dispose();
    this.parts = [];
    return g;
  }
}

/** A data-bound prop: an instanced box, room-local position of its centre. */
export interface Slot { x: number; y: number; z: number; w: number; h: number; d: number; glow: boolean }

const F = FLOOR;

/** Slots per room, in the same order as RoomModel.cells (CAPACITY of them). */
export const SLOTS: Record<ZoneId, Slot[]> = {
  // The Mission Control wall screen: 3×2 panels.
  mission: [0, 1].flatMap(r => [-2.05, 0, 2.05].map(x => ({ x, y: F + 1.35 + r * 0.95, z: -H + T + 0.1, w: 1.9, h: 0.85, d: 0.05, glow: true }))),
  // Books on three shelf units, two rows of four, bottom row first.
  explorer: [0, 1].flatMap(r => [-3, 0, 3].flatMap(ux => [-0.84, -0.28, 0.28, 0.84].map(bx => ({ x: ux + bx, y: F + 0.12 + r * 1.0 + 0.36, z: -H + T + 0.42, w: 0.4, h: 0.72, d: 0.44, glow: false })))),
  // Sticky notes on the whiteboard, 4×3, top row first.
  planning: [0, 1, 2].flatMap(r => [-1.8, -0.6, 0.6, 1.8].map(x => ({ x, y: F + 2.25 - r * 0.6, z: -H + T + 0.1, w: 0.9, h: 0.46, d: 0.04, glow: false }))),
  // One monitor per desk, back row first.
  implementation: [-3.2, 0.5].flatMap(dz => [-3, 0, 3].map(x => ({ x, y: F + 1.12, z: dz - 0.2, w: 1.0, h: 0.52, d: 0.04, glow: true }))),
  // Status LEDs on four server racks, three per rack.
  tooling: [-3.9, -2.55, -1.2, 0.15].flatMap(x => [0, 1, 2].map(r => ({ x, y: F + 0.55 + r * 0.55, z: -H + T + 1.02, w: 0.72, h: 0.12, d: 0.04, glow: true }))),
  // Test tubes in a rack on the north bench.
  lab: Array.from({ length: 8 }, (_, i) => ({ x: -2.75 + i * 0.5, y: F + 1.25, z: -4.05, w: 0.2, h: 0.5, d: 0.2, glow: true })),
  // The decision board on the north wall.
  approval: Array.from({ length: 6 }, (_, i) => ({ x: -3.75 + i * 0.6, y: F + 1.95, z: -H + T + 0.1, w: 0.46, h: 0.46, d: 0.05, glow: true })),
  // Crates on the dispatch pallet, 3×3.
  review: [-0.85, 0, 0.85].flatMap(dz => [-0.85, 0, 0.85].map(dx => ({ x: 2.9 + dx, y: F + 0.15 + 0.36, z: 1.6 + dz, w: 0.72, h: 0.72, d: 0.72, glow: false }))),
  // Failure / rerun lamps above the pegboard.
  repair: Array.from({ length: 6 }, (_, i) => ({ x: -1.6 + i * 0.75, y: F + 2.2, z: -H + T + 0.1, w: 0.45, h: 0.28, d: 0.05, glow: true })),
};

for (const z of ZONES) if (SLOTS[z].length !== CAPACITY[z]) throw new Error(`slots for ${z} do not match its capacity`);

/** Each room's status light: a bar on top of its north wall. */
export const STATUS_SLOT: Slot = { x: 0, y: WALL_H + 0.1, z: -H + T / 2, w: 1.8, h: 0.16, d: T + 0.08, glow: true };

export function buildStatic(p: Palette): BufferGeometry {
  const k = new Kit();
  const S = 2 * SLAB;
  // Ground slab with a coloured rim, like the reference map's building edge.
  k.box(S, 0.9, S, 0, -0.9, 0, p.slabSide);
  k.box(S, 0.02, S, 0, -0.02, 0, p.corridor);
  for (const [w, d, x, z] of [[S, 0.3, 0, -S / 2 + 0.15], [S, 0.3, 0, S / 2 - 0.15], [0.3, S, -S / 2 + 0.15, 0], [0.3, S, S / 2 - 0.15, 0]] as const) k.box(w, 0.12, d, x, -0.02, z, p.rim);
  // Corner trees and planters outside the walkway.
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const cx = x * (SPAN / 2 + 1), cz = z * (SPAN / 2 + 1);
    k.cyl(0.14, 0.18, 1.0, cx, 0, cz, p.trunk, 7);
    k.sphere(0.85, cx, 1.55, cz, p.leaf, 8);
  }
  for (const z of ZONES) room(k, z, p);
  return k.geometry();
}

function room(k0: Kit, zone: ZoneId, p: Palette) {
  const c = roomCenter(zone);
  const k = new Kit(c.x, c.z);
  const badge = p.badge[zone];
  k.box(ROOM, F, ROOM, 0, 0, 0, p.floor[zone]);
  // Tall walls at the back (north, west), low walls at the front (south, east) so the room reads like a dollhouse.
  k.box(ROOM, WALL_H, T, 0, 0, -H + T / 2, p.wall);
  k.box(T, WALL_H, ROOM, -H + T / 2, 0, 0, p.wall);
  k.box(ROOM + 0.04, 0.08, T + 0.06, 0, WALL_H, -H + T / 2, badge);
  k.box(T + 0.06, 0.08, ROOM + 0.04, -H + T / 2, WALL_H, 0, badge);
  k.box(T, FRONT_WALL_H, ROOM, H - T / 2, 0, 0, p.wall);
  const seg = (ROOM - DOOR_W) / 2;
  for (const s of [-1, 1]) k.box(seg, FRONT_WALL_H, T, s * (DOOR_W / 2 + seg / 2), 0, H - T / 2, p.wall);
  // Door mat in the zone colour.
  k.box(DOOR_W - 0.3, 0.02, 0.9, 0, F, H - 0.7, badge.clone().lerp(p.floor[zone], 0.55));
  FURNISH[zone](k, p, badge);
  k0.merge(k);
}

type Furnish = (k: Kit, p: Palette, badge: Color) => void;

const FURNISH: Record<ZoneId, Furnish> = {
  mission(k, p, badge) {
    k.cyl(1.5, 1.6, 0.82, 0, F, -0.4, p.furniture, 20);
    k.cyl(1.56, 1.56, 0.06, 0, F + 0.82, -0.4, badge, 20);
    k.cyl(0.5, 0.5, 0.05, 0, F + 0.88, -0.4, p.screen, 14);
    k.box(6.6, 2.1, 0.08, 0, F + 0.82, -H + T + 0.04, p.screen);
    k.plant(-4.1, 4.1, p);
    k.plant(4.1, -4.1, p, 0.8);
  },
  explorer(k, p, badge) {
    for (const ux of [-3, 0, 3]) {
      k.box(2.6, 2.2, 0.08, ux, F, -H + T + 0.04, p.wood);
      for (const sx of [-1.28, 1.28]) k.box(0.08, 2.2, 0.64, ux + sx, F, -H + T + 0.32, p.wood);
      for (const y of [0, 1.0, 2.12]) k.box(2.6, 0.08, 0.64, ux, F + y, -H + T + 0.32, p.wood);
    }
    // A side shelf of reference books and a reading table with a lamp.
    k.box(0.64, 1.6, 3, -H + T + 0.32, F, 1.2, p.wood);
    for (let i = 0; i < 5; i++) k.box(0.4, 0.6, 0.4, -H + T + 0.36, F + 0.9, -0.05 + i * 0.6, p.furniture2);
    k.table(2.6, 1.3, 1.6, 1.0, p.wood, p.furniture2);
    k.cyl(0.04, 0.04, 0.5, 2.5, F + 0.74, 0.7, p.metal, 6);
    k.cyl(0.08, 0.28, 0.24, 2.5, F + 1.18, 0.7, badge, 10);
    k.box(0.5, 0.06, 0.36, 1.2, F + 0.74, 1.0, p.furniture);
    k.plant(4.1, -3.9, p, 0.9);
  },
  planning(k, p) {
    k.box(5.5, 2.2, 0.06, 0, F + 0.6, -H + T + 0.03, p.furniture2);
    k.box(5.2, 1.95, 0.05, 0, F + 0.72, -H + T + 0.06, p.wall);
    k.box(5.2, 0.08, 0.2, 0, F + 0.6, -H + T + 0.12, p.metal);
    k.table(3.4, 1.7, 0, 1.2, p.wood, p.furniture2);
    for (const x of [-0.9, 0.9]) k.box(0.55, 0.45, 0.55, x, F, 0.0, p.furniture2);
    k.box(0.7, 0.04, 0.5, -0.6, F + 0.74, 1.3, p.wall);
    k.box(0.6, 0.04, 0.45, 0.7, F + 0.74, 1.0, p.wall);
    // A flip chart.
    k.box(1.0, 1.3, 0.06, 4.0, F + 0.5, -2.8, p.wall, -0.5);
    k.box(0.06, 1.8, 0.06, 4.0, F, -2.8, p.metal);
    k.plant(-4.1, 4.1, p);
  },
  implementation(k, p) {
    for (const dz of [-3.2, 0.5]) for (const x of [-3, 0, 3]) {
      k.table(2.3, 0.95, x, dz, p.furniture, p.furniture2);
      k.box(1.12, 0.62, 0.06, x, F + 0.82, dz - 0.25, p.screen);
      k.box(0.1, 0.1, 0.1, x, F + 0.74, dz - 0.25, p.metal);
      k.box(0.62, 0.03, 0.2, x, F + 0.74, dz + 0.18, p.furniture2);
      k.box(0.12, 0.03, 0.16, x + 0.5, F + 0.74, dz + 0.18, p.furniture2);
    }
    k.plant(-4.1, 4.1, p, 0.9);
    k.plant(4.1, 4.1, p, 0.7);
  },
  tooling(k, p, badge) {
    for (const x of [-3.9, -2.55, -1.2, 0.15]) {
      k.box(1.2, 2.2, 1.0, x, F, -H + T + 0.5, p.screen);
      k.box(1.0, 0.04, 0.02, x, F + 1.95, -H + T + 1.01, p.metal);
    }
    k.box(5.6, 0.12, 0.12, -1.85, F + 2.3, -H + T + 0.3, badge);
    // Terminal desk.
    k.table(2.2, 1.0, 2.8, 0.3, p.furniture, p.furniture2);
    k.box(1.1, 0.62, 0.06, 2.8, F + 0.82, 0.05, p.screen);
    k.box(0.95, 0.48, 0.02, 2.8, F + 0.89, 0.09, badge.clone().lerp(p.screen, 0.45));
    // Package crates (dependencies).
    for (const [y, z, s] of [[0, 1.6, 0.9], [0, 2.6, 0.9], [0.9, 2.1, 0.7]] as const) k.box(s, s, s, -H + T + 0.55, F + y, z, p.wood);
    k.plant(4.1, -3.9, p, 0.8);
  },
  lab(k, p, badge) {
    k.box(5.0, 0.9, 1.1, -1, F, -4.15, p.furniture);
    k.box(5.1, 0.06, 1.2, -1, F + 0.9, -4.15, p.metal);
    k.box(4.2, 0.1, 0.36, -1, F + 0.96, -4.05, p.furniture2);
    k.box(5.0, 0.9, 1.1, -1, F, 0.65, p.furniture);
    k.box(5.1, 0.06, 1.2, -1, F + 0.9, 0.65, p.metal);
    for (const [x, c] of [[-2.6, badge], [-1.6, p.status.ok], [-0.4, p.status.active], [0.6, badge]] as const) {
      k.cyl(0.08, 0.3, 0.42, x, F + 0.96, 0.65, p.wall, 10);
      k.cyl(0.07, 0.24, 0.18, x, F + 0.97, 0.65, c, 10);
    }
    k.box(1.0, 2.2, 1.7, -H + T + 0.5, F, 2.6, p.furniture2);
    k.box(0.8, 0.85, 0.8, 2.4, F, 0.9, p.metal);
    k.cyl(0.25, 0.25, 0.1, 2.4, F + 0.85, 0.9, p.screen, 12);
  },
  approval(k, p, badge) {
    k.box(4.0, 1.0, 0.08, -2.25, F + 1.45, -H + T + 0.04, p.screen);
    k.box(2.8, 1.05, 1.0, -2.9, F, -1.8, p.furniture);
    k.box(2.9, 0.06, 1.1, -2.9, F + 1.05, -1.8, badge);
    k.table(2.0, 0.95, 2.8, -3.7, p.wood, p.furniture2);
    for (let i = 0; i < 3; i++) k.box(0.42, 0.04, 0.56, 2.3 + i * 0.5, F + 0.74 + i * 0.01, -3.65, p.wall, i * 0.2);
    k.box(0.22, 0.24, 0.22, 3.4, F + 0.74, -3.8, badge);
    // Barrier posts (the arm itself is animated).
    k.box(0.42, 1.0, 0.42, -0.6, F, 1.0, p.furniture2);
    k.box(0.3, 0.9, 0.3, 4.35, F, 1.0, p.furniture2);
    k.plant(4.1, -1.2, p, 0.8);
  },
  review(k, p, badge) {
    k.box(7.2, 0.6, 1.2, -0.6, F, -4.1, p.metal);
    k.box(7.2, 0.05, 1.0, -0.6, F + 0.6, -4.1, p.screen);
    for (const x of [-3.4, -1.4, 0.8]) k.box(0.7, 0.5, 0.6, x, F + 0.65, -4.1, p.wood);
    k.box(2.7, 0.15, 2.7, 2.9, F, 1.6, p.wood);
    k.table(2.0, 0.95, -2.4, 1.0, p.furniture, p.furniture2);
    k.box(0.8, 0.05, 0.55, -2.4, F + 0.74, 1.0, p.metal);
    k.box(0.8, 0.5, 0.04, -2.4, F + 0.79, 0.75, p.screen);
    k.box(0.06, 2.0, 0.06, 4.2, F, -2.2, p.metal);
    k.box(1.0, 0.6, 0.06, 4.2, F + 1.4, -2.2, badge, -0.6);
  },
  repair(k, p, badge) {
    k.box(5.5, 0.9, 1.1, 0.3, F, -4.15, p.wood);
    k.box(5.6, 0.06, 1.2, 0.3, F + 0.9, -4.15, p.metal);
    k.box(4.6, 1.2, 0.06, 0.3, F + 1.25, -H + T + 0.03, p.furniture2);
    for (const [x, w, h] of [[-1.6, 0.12, 0.7], [-1.1, 0.5, 0.12], [-0.4, 0.1, 0.8], [0.4, 0.6, 0.1], [1.2, 0.14, 0.6], [1.9, 0.4, 0.4]] as const) k.box(w, h, 0.04, x, F + 1.5, -H + T + 0.08, p.legs);
    k.box(0.5, 0.35, 0.4, -1.8, F + 0.96, -4.0, p.metal);
    k.box(0.8, 0.6, 1.2, -H + T + 0.45, F, 1.5, badge);
    k.box(1.6, 0.8, 1.0, 0, F, 0.5, p.metal);
    k.box(1.0, 0.3, 0.6, 0, F + 0.8, 0.5, p.furniture2);
    k.plant(4.1, 4.1, p, 0.8);
  },
};

// ── people ───────────────────────────────────────────────────────────────────

/** A small person facing +z: body and head as one coloured mesh, legs separate (they swing). */
export function personGeometry(body: Color, p: Palette): { torso: BufferGeometry; leg: BufferGeometry; shadow: BufferGeometry } {
  const k = new Kit()
    .add(new CapsuleGeometry(0.24, 0.4, 4, 12), 0, 0.8, 0, body)
    .add(new SphereGeometry(0.2, 12, 9), 0, 1.33, 0, p.skin)
    .add(new BoxGeometry(0.24, 0.08, 0.08), 0, 1.36, 0.17, p.legs);
  const leg = new BoxGeometry(0.13, 0.38, 0.15).translate(0, -0.19, 0);
  const shadow = new CircleGeometry(0.42, 20).rotateX(-Math.PI / 2);
  return { torso: k.geometry(), leg, shadow };
}

/** Pixel width of the voxel mascot; a pixel is 9/4 as tall (see `PIXEL`). About as tall as a person's shoulders. */
const VOXEL = 0.095;

export interface ClawdGeometry extends Record<ClawdPart, BufferGeometry> {
  shadow: BufferGeometry;
  height: number;
  /** The eyes are centred on their own origin (so they blink in place); this lifts them back into the face. */
  eyeY: number;
}

/**
 * Claude's mascot as voxels: the pixel drawing extruded into a block, facing +z. Each part is its own geometry
 * so the engine can lift legs, wave arms and blink. Two legs stand at the front and two at the back, stepping
 * in turn: from the front it is the 2D drawing, in 3D it walks like a little crab.
 */
export function clawdGeometry(): ClawdGeometry {
  const cw = VOXEL, ch = (VOXEL * PIXEL.h) / PIXEL.w, depth = 7 * cw;
  const parts = { body: [], eye: [], armL: [], armR: [], legFront: [], legBack: [] } as Record<ClawdPart, BufferGeometry[]>;
  for (const r of clawdRuns()) {
    const x = (r.col + r.len / 2 - CLAWD_COLS / 2) * cw;
    const y = (CLAWD_ROWS - 1 - r.row + 0.5) * ch;
    const [d, z] = r.part === 'eye' ? [0.03, depth / 2 + 0.012]
      : r.part === 'armL' || r.part === 'armR' ? [3 * cw, 0]
      : r.part === 'legFront' ? [1.6 * cw, depth / 2 - 1.2 * cw]
      : r.part === 'legBack' ? [1.6 * cw, -depth / 2 + 1.2 * cw]
      : [depth, 0];
    parts[r.part].push(new BoxGeometry(r.len * cw, ch, d).translate(x, y, z));
  }
  const merged = Object.fromEntries(Object.entries(parts).map(([k, gs]) => {
    const g = mergeGeometries(gs)!;
    for (const part of gs) part.dispose();
    return [k, g];
  })) as Record<ClawdPart, BufferGeometry>;
  const eyeY = (CLAWD_ROWS - 1 - clawdRuns().find(r => r.part === 'eye')!.row + 0.5) * ch;
  merged.eye.translate(0, -eyeY, 0);
  const shadow = new CircleGeometry(0.5, 24).rotateX(-Math.PI / 2).scale(CLAWD_COLS * cw * 1.05, 1, depth * 1.6);
  return { ...merged, shadow, height: CLAWD_ROWS * ch, eyeY };
}

export interface MascotGeometry {
  body: BufferGeometry;
  /** Dark parts that stand on their own (beret, bow tie). */
  standalone?: BufferGeometry;
  /** Thin plates on the face: dark (glasses, visor), white, and the eyes (a separate mesh, so they can blink). */
  dark?: BufferGeometry;
  white?: BufferGeometry;
  eye?: BufferGeometry;
  eyeY: number;
  shadow: BufferGeometry;
  height: number;
  width: number;
}

/** About as tall as Claude's mascot, whatever the grid size. */
const MASCOT_HEIGHT = 1.02;

/**
 * A mascot as voxels. The drawing is extruded with a depth that grows with the distance from its outline, so it
 * comes out rounded like the plush toy it is rather than a flat cut-out; face details are plates on its front.
 */
export function mascotGeometry(grid: readonly string[]): MascotGeometry {
  const all = cells(grid);
  const rows = grid.length, cols = grid[0]!.length;
  const v = MASCOT_HEIGHT / rows;
  const filled = (row: number, col: number, standalone: boolean) => {
    const ch = grid[row]?.[col];
    return ch !== undefined && ch !== '.' && (ch === 'K') === standalone;
  };
  /** Steps to the nearest empty cell, counting diagonals: 1 on the outline. */
  const inset = (row: number, col: number, standalone: boolean) => {
    for (let d = 1; d < 5; d++) {
      for (let dr = -d; dr <= d; dr++) for (let dc = -d; dc <= d; dc++) {
        if ((Math.abs(dr) === d || Math.abs(dc) === d) && !filled(row + dr, col + dc, standalone)) return d;
      }
    }
    return 5;
  };
  const depthAt = (row: number, col: number, standalone: boolean) => v * (standalone ? 1.2 + 1.4 * Math.min(inset(row, col, true), 3) : 2.4 + 1.5 * Math.min(inset(row, col, false), 4));
  const parts: Record<MascotPart, BufferGeometry[]> = { body: [], standalone: [], dark: [], white: [], eye: [] };
  const at = (c: Cell) => [(c.col + 0.5 - cols / 2) * v, (rows - 1 - c.row + 0.5) * v] as const;
  for (const c of all) {
    const [x, y] = at(c);
    const standalone = c.part === 'standalone';
    const depth = depthAt(c.row, c.col, standalone);
    parts[standalone ? 'standalone' : 'body'].push(new BoxGeometry(v, v, depth).translate(x, y, 0));
    if (c.part !== 'body' && !standalone) parts[c.part].push(new BoxGeometry(v * 1.001, v * 1.001, 0.02).translate(x, y, depth / 2 + 0.006));
  }
  const merge = (gs: BufferGeometry[]) => {
    if (!gs.length) return undefined;
    const g = mergeGeometries(gs)!;
    for (const part of gs) part.dispose();
    return g;
  };
  const eyes = all.filter(c => c.part === 'eye');
  const eyeY = eyes.length ? eyes.reduce((s, c) => s + at(c)[1], 0) / eyes.length : 0;
  const eye = merge(parts.eye)?.translate(0, -eyeY, 0);
  const maxDepth = Math.max(...all.map(c => depthAt(c.row, c.col, c.part === 'standalone')));
  const shadow = new CircleGeometry(0.5, 24).rotateX(-Math.PI / 2).scale(cols * v * 1.05, 1, maxDepth * 1.5);
  return { body: merge(parts.body)!, standalone: merge(parts.standalone), dark: merge(parts.dark), white: merge(parts.white), eye, eyeY, shadow, height: rows * v, width: cols * v };
}
