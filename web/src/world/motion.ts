import type { ZoneId } from '../../../src/core/state.ts';
import { dist, GRAPH, pathLength, shortest, stationPos, type P } from './layout.ts';

/**
 * Agents walk the corridors between rooms. A walk takes as long as it takes at walking pace, but
 * never less than MIN_WALK or more than MAX_WALK seconds — agents change task every few seconds, so
 * a long walk is sped up rather than leaving them forever in transit.
 */
export const WALK_SPEED = 7; // units per second
export const MIN_WALK = 0.5;
export const MAX_WALK = 1.8;

/** A point on a walk; `node` names the corridor-graph node it sits on (stations have none). */
export interface Waypoint extends P { node?: string }

export interface Walker {
  pos: P;
  /** Facing, radians; 0 = south (towards the viewer). */
  yaw: number;
  /** The room the walker is in, or heading to. */
  zone: ZoneId;
  slot: number;
  path: Waypoint[];
  /** Index of the waypoint being walked towards; == path.length when standing. */
  next: number;
  speed: number;
}

export function spawn(zone: ZoneId, slot: number): Walker {
  const s = stationPos(zone, slot);
  return { pos: { x: s.x, z: s.z }, yaw: s.yaw, zone, slot, path: [], next: 0, speed: 0 };
}

export const walking = (w: Walker) => w.next < w.path.length;

/**
 * Sends the walker to a station. `timeScale` > 1 shortens the walk (fast replay); `snap` moves it at
 * once (seeking, switching sessions, reduced motion).
 */
export function retarget(w: Walker, zone: ZoneId, slot: number, opts: { snap?: boolean; timeScale?: number } = {}): void {
  const target = stationPos(zone, slot);
  const from = w.zone;
  if (from === zone && w.slot === slot && !opts.snap) return;
  w.zone = zone;
  w.slot = slot;
  if (opts.snap) {
    Object.assign(w, { pos: { x: target.x, z: target.z }, yaw: target.yaw, path: [], next: 0, speed: 0 });
    return;
  }
  const station: Waypoint = { x: target.x, z: target.z };
  // Standing in the same room: straight to the new station. Otherwise (even mid-walk into this room) by the corridors.
  const path = from === zone && !walking(w) ? [station] : routeFrom(w, from, zone, station);
  const length = dist(w.pos, path[0]!) + pathLength(path);
  const seconds = Math.min(MAX_WALK, Math.max(MIN_WALK, length / WALK_SPEED)) / Math.max(1, opts.timeScale ?? 1);
  Object.assign(w, { path, next: 0, speed: length / seconds });
}

const at = (node: string): Waypoint => ({ ...GRAPH.nodes.get(node)!, node });

/**
 * Corridor route to `zone`'s station, from wherever the walker is: standing in `from`, or part-way
 * along a walk — then via either end of the current leg, whichever makes the shorter walk.
 */
function routeFrom(w: Walker, from: ZoneId, zone: ZoneId, station: Waypoint): Waypoint[] {
  // A station is reached through its room's entrance; the only station on a path is its last point, in `from`.
  const via = (wp: Waypoint) => wp.node ?? `entry:${from}`;
  const starts: Array<{ lead: Waypoint[]; node: string }> = walking(w)
    ? [w.path[w.next - 1], w.path[w.next]].filter((wp): wp is Waypoint => !!wp).map(wp => ({ lead: wp.node ? [wp] : [wp, at(via(wp))], node: via(wp) }))
    : [{ lead: [], node: `entry:${from}` }];
  let best: Waypoint[] = [];
  let bestLen = Infinity;
  for (const s of starts) {
    const path = dedupe([...s.lead, ...shortest(s.node, `entry:${zone}`).map(at), station]);
    const len = dist(w.pos, path[0]!) + pathLength(path);
    if (len < bestLen) { best = path; bestLen = len; }
  }
  return best;
}

function dedupe(path: Waypoint[]): Waypoint[] {
  return path.filter((p, i) => i === 0 || dist(p, path[i - 1]!) > 1e-6);
}

/** Advances the walker by dt seconds. Returns true while it is still moving. */
export function step(w: Walker, dt: number): boolean {
  let budget = w.speed * dt;
  while (budget > 0 && walking(w)) {
    const target = w.path[w.next]!;
    const d = dist(w.pos, target);
    if (d > 1e-6) w.yaw = Math.atan2(target.x - w.pos.x, target.z - w.pos.z);
    if (d <= budget) {
      w.pos = { x: target.x, z: target.z };
      w.next++;
      budget -= d;
    } else {
      w.pos = { x: w.pos.x + ((target.x - w.pos.x) / d) * budget, z: w.pos.z + ((target.z - w.pos.z) / d) * budget };
      budget = 0;
    }
  }
  if (!walking(w) && w.path.length) {
    // Arrived: face the station's work.
    w.yaw = stationPos(w.zone, w.slot).yaw;
    w.path = [];
    w.next = 0;
  }
  return walking(w);
}
