import type { ZoneId } from '../../../src/core/state.ts';
import { ZONE_LAYOUT } from '../lib/meta.ts';

/**
 * The building, in world units (x east, z south, y up; the camera looks from the south-east).
 * Nine square rooms on a 3×3 grid with corridors between them and a walkway around the outside.
 * Every room's door is in the middle of its south wall, so agents always enter facing the viewer.
 */
export const ROOM = 10;
export const CORRIDOR = 3;
export const SPAN = 3 * ROOM + 4 * CORRIDOR;
export const WALL_H = 2.6;
export const FRONT_WALL_H = 0.45;
export const DOOR_W = 2.4;

export interface P { x: number; z: number }

const STEP = ROOM + CORRIDOR;
const FIRST = -SPAN / 2 + CORRIDOR + ROOM / 2;
/** Centre lines of the corridors, west→east (and north→south): the outer walkway, two inner corridors, the outer walkway. */
export const LANES = [0, 1, 2, 3].map(k => -SPAN / 2 + CORRIDOR / 2 + k * STEP);

export function cell(zone: ZoneId): { col: number; row: number } {
  const i = ZONE_LAYOUT.indexOf(zone);
  return { col: i % 3, row: Math.floor(i / 3) };
}

export function roomCenter(zone: ZoneId): P {
  const { col, row } = cell(zone);
  return { x: FIRST + col * STEP, z: FIRST + row * STEP };
}

const add = (a: P, x: number, z: number): P => ({ x: a.x + x, z: a.z + z });
export const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.z - b.z);

/** Just inside the door: where agents step in before heading to their station. */
export const entry = (zone: ZoneId) => add(roomCenter(zone), 0, ROOM / 2 - 1.3);
export const door = (zone: ZoneId) => add(roomCenter(zone), 0, ROOM / 2);
/** The corridor point in front of the door. */
export const doorstep = (zone: ZoneId) => add(roomCenter(zone), 0, ROOM / 2 + CORRIDOR / 2);

/** Work stations per room, in room-local coordinates, with the direction the agent faces (radians, 0 = south). */
export interface Station { x: number; z: number; yaw: number }
const N = Math.PI, E = Math.PI / 2, W = -Math.PI / 2;

export const STATIONS: Record<ZoneId, Station[]> = {
  mission: [{ x: -2.3, z: 0.4, yaw: E }, { x: 2.3, z: 0.4, yaw: W }, { x: 0, z: 1.9, yaw: N }, { x: -1.6, z: -2.6, yaw: N }, { x: 1.6, z: -2.6, yaw: N }],
  explorer: [{ x: -3, z: -3.1, yaw: N }, { x: 0, z: -3.1, yaw: N }, { x: 3, z: -3.1, yaw: N }, { x: 1.6, z: 2.4, yaw: N }, { x: -3.2, z: 0.5, yaw: W }],
  planning: [{ x: -1.4, z: -3.1, yaw: N }, { x: 1.4, z: -3.1, yaw: N }, { x: -2.3, z: 1.2, yaw: E }, { x: 2.3, z: 1.2, yaw: W }, { x: 0, z: 2.8, yaw: N }],
  implementation: [{ x: -3, z: -2.3, yaw: N }, { x: 0, z: -2.3, yaw: N }, { x: 3, z: -2.3, yaw: N }, { x: -3, z: 1.4, yaw: N }, { x: 0, z: 1.4, yaw: N }, { x: 3, z: 1.4, yaw: N }],
  tooling: [{ x: -2.9, z: -2.7, yaw: N }, { x: -0.1, z: -2.7, yaw: N }, { x: 2.8, z: 1.3, yaw: N }, { x: -2.6, z: 2.2, yaw: W }],
  lab: [{ x: -2.4, z: -2.5, yaw: N }, { x: 0.6, z: -2.5, yaw: N }, { x: -1, z: 1.9, yaw: N }, { x: 2.4, z: 1.9, yaw: N }],
  approval: [{ x: -2.9, z: -0.6, yaw: N }, { x: 1.6, z: 2.4, yaw: N }, { x: 2.8, z: -2.6, yaw: N }, { x: -0.4, z: 2.4, yaw: N }],
  review: [{ x: -2, z: -2.4, yaw: N }, { x: 0.8, z: -2.4, yaw: N }, { x: 1.2, z: 1.6, yaw: E }, { x: -2.4, z: 2, yaw: N }],
  repair: [{ x: -1.2, z: -2.7, yaw: N }, { x: 1.8, z: -2.7, yaw: N }, { x: 0, z: 1.6, yaw: N }, { x: -3, z: 1.5, yaw: W }],
};

/** Where the n-th agent in a room stands. Beyond the stations, agents queue in a row by the door. */
export function stationPos(zone: ZoneId, n: number): Station {
  const c = roomCenter(zone);
  const s = STATIONS[zone][n];
  if (s) return { x: c.x + s.x, z: c.z + s.z, yaw: s.yaw };
  const k = n - STATIONS[zone].length;
  return { x: c.x - 3 + (k % 6) * 1.2, z: c.z + 3.2 - Math.floor(k / 6) * 0.9, yaw: N };
}

// ── corridor graph ───────────────────────────────────────────────────────────

export interface Graph { nodes: Map<string, P>; edges: Map<string, Array<{ to: string; w: number }>> }

function buildGraph(): Graph {
  const nodes = new Map<string, P>();
  const edges = new Map<string, Array<{ to: string; w: number }>>();
  const link = (a: string, b: string) => {
    const w = dist(nodes.get(a)!, nodes.get(b)!);
    (edges.get(a) ?? edges.set(a, []).get(a)!).push({ to: b, w });
    (edges.get(b) ?? edges.set(b, []).get(b)!).push({ to: a, w });
  };
  LANES.forEach((x, i) => LANES.forEach((z, k) => nodes.set(`j${i}${k}`, { x, z })));
  for (const zone of ZONE_LAYOUT) {
    nodes.set(`step:${zone}`, doorstep(zone));
    nodes.set(`door:${zone}`, door(zone));
    nodes.set(`entry:${zone}`, entry(zone));
    link(`entry:${zone}`, `door:${zone}`);
    link(`door:${zone}`, `step:${zone}`);
  }
  // East–west corridors: junctions and doorsteps on each lane, linked to their neighbours.
  for (const z of LANES) {
    const on = [...nodes].filter(([id, p]) => (id.startsWith('j') || id.startsWith('step:')) && Math.abs(p.z - z) < 1e-6).sort((a, b) => a[1].x - b[1].x);
    for (let i = 1; i < on.length; i++) link(on[i - 1]![0], on[i]![0]);
  }
  // North–south corridors: junction to junction.
  LANES.forEach((_, i) => { for (let k = 1; k < LANES.length; k++) link(`j${i}${k - 1}`, `j${i}${k}`); });
  return { nodes, edges };
}

export const GRAPH = buildGraph();

/** Shortest walk between two graph nodes (Dijkstra; the graph has ~45 nodes). */
export function shortest(from: string, to: string, g: Graph = GRAPH): string[] {
  const d = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, string>();
  const open = new Set([from]);
  while (open.size) {
    let cur = '';
    let best = Infinity;
    for (const n of open) if ((d.get(n) ?? Infinity) < best) { best = d.get(n)!; cur = n; }
    open.delete(cur);
    if (cur === to) break;
    for (const { to: nx, w } of g.edges.get(cur) ?? []) {
      const nd = best + w;
      if (nd < (d.get(nx) ?? Infinity)) { d.set(nx, nd); prev.set(nx, cur); open.add(nx); }
    }
  }
  if (!d.has(to)) return [];
  const out = [to];
  while (out[0] !== from) out.unshift(prev.get(out[0]!)!);
  return out;
}

export const pathLength = (pts: P[]) => pts.reduce((sum, p, i) => (i ? sum + dist(pts[i - 1]!, p) : 0), 0);

/** Half the width of the ground slab: the building plus a margin for the corner trees. */
export const SLAB = SPAN / 2 + 2;

/** The slab's corners, its underside and the tree tops: everything the camera must fit. */
export function footprint(): Array<[number, number, number]> {
  const h = SLAB;
  return [[-h, -0.9, -h], [h, -0.9, -h], [h, -0.9, h], [-h, -0.9, h], [-h, 2.4, -h], [h, 2.4, -h], [-h, 2.4, h], [h, 2.4, h]];
}

export function roomCorners(zone: ZoneId): Array<[number, number, number]> {
  const c = roomCenter(zone);
  const h = ROOM / 2 + 0.6;
  return [[c.x - h, 0, c.z - h], [c.x + h, 0, c.z - h], [c.x + h, 0, c.z + h], [c.x - h, 0, c.z + h], [c.x - h, WALL_H + 1.4, c.z - h], [c.x + h, WALL_H, c.z - h]];
}
