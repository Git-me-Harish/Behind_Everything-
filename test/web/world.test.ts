import { describe, expect, it } from 'vitest';
import { createClaudeParser } from '../../src/adapters/claude-code/parse.js';
import { ZONES, reduce, type ZoneId } from '../../src/core/state.js';
import { BACK, bounds, clampView, fit, mix, onScreen, panBy, unproject, zoomAround, type V3 } from '../../web/src/world/camera.js';
import { CORRIDOR, door, entry, footprint, GRAPH, LANES, ROOM, roomCenter, shortest, SPAN, stationPos, STATIONS, type P } from '../../web/src/world/layout.js';
import { CAPACITY, FINISHED_LINGER_MS, MAX_AGENTS, worldModel } from '../../web/src/world/model.js';
import { MAX_WALK, MIN_WALK, retarget, spawn, step, walking, type Walker } from '../../web/src/world/motion.js';
import { demoSession } from '../fixtures/claude.js';

const inRoom = (p: P, z: ZoneId, margin = 0) => {
  const c = roomCenter(z);
  return Math.abs(p.x - c.x) < ROOM / 2 - margin && Math.abs(p.z - c.z) < ROOM / 2 - margin;
};

/** Points along a polyline, every 0.25 units. */
function samples(path: P[]): P[] {
  const out: P[] = [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!, b = path[i]!;
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.25));
    for (let k = 0; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  return out;
}

function walk(w: Walker, max = 10): P[] {
  const trail = [w.pos];
  for (let t = 0; t < max && step(w, 1 / 60); t += 1 / 60) trail.push(w.pos);
  trail.push(w.pos);
  return trail;
}

describe('building layout', () => {
  it('lays the nine zones on a 3×3 grid inside the footprint, Mission Control in the middle', () => {
    expect(roomCenter('mission')).toEqual({ x: 0, z: 0 });
    for (const z of ZONES) {
      const c = roomCenter(z);
      expect(Math.abs(c.x) + ROOM / 2 + CORRIDOR).toBeLessThanOrEqual(SPAN / 2 + 1e-9);
      expect(Math.abs(c.z) + ROOM / 2 + CORRIDOR).toBeLessThanOrEqual(SPAN / 2 + 1e-9);
    }
    expect(LANES).toEqual([-19.5, -6.5, 6.5, 19.5]);
  });

  it('keeps every station inside its room and clear of the walls', () => {
    for (const z of ZONES) for (let i = 0; i < STATIONS[z].length + 8; i++) expect(inRoom(stationPos(z, i), z, 0.4), `${z} #${i}`).toBe(true);
  });

  it('connects every room to every other through the corridors', () => {
    for (const a of ZONES) for (const b of ZONES) expect(shortest(`entry:${a}`, `entry:${b}`).length, `${a}→${b}`).toBeGreaterThan(0);
    // Every edge runs along a corridor or through a doorway — never diagonally.
    for (const [from, edges] of GRAPH.edges) for (const e of edges) {
      const p = GRAPH.nodes.get(from)!, q = GRAPH.nodes.get(e.to)!;
      expect(Math.abs(p.x - q.x) < 1e-9 || Math.abs(p.z - q.z) < 1e-9, `${from}→${e.to}`).toBe(true);
    }
  });

  it('routes between rooms only through doors: a walk enters no room but its start and end', () => {
    for (const a of ZONES) for (const b of ZONES) {
      if (a === b) continue;
      const w = spawn(a, 0);
      retarget(w, b, 1);
      for (const p of samples([w.pos, ...w.path])) {
        const room = ZONES.find(z => inRoom(p, z));
        if (room) expect([a, b], `${a}→${b} crosses ${room} at ${p.x.toFixed(1)},${p.z.toFixed(1)}`).toContain(room);
      }
      // …and passes through both doorways.
      const pts = w.path.map(p => `${p.x},${p.z}`);
      expect(pts).toContain(`${door(a).x},${door(a).z}`);
      expect(pts).toContain(`${door(b).x},${door(b).z}`);
    }
  });
});

describe('agent motion', () => {
  it('walks to the new station in a bounded time and then faces its work', () => {
    const w = spawn('explorer', 0);
    retarget(w, 'repair', 0);
    expect(walking(w)).toBe(true);
    let t = 0;
    while (step(w, 1 / 60)) t += 1 / 60;
    expect(t).toBeGreaterThanOrEqual(MIN_WALK - 0.05);
    expect(t).toBeLessThanOrEqual(MAX_WALK + 0.05);
    const s = stationPos('repair', 0);
    expect(w.pos).toEqual({ x: s.x, z: s.z });
    expect(w.yaw).toBe(s.yaw);
  });

  it('never teleports when re-targeted mid-walk, and still only uses doors', () => {
    const w = spawn('explorer', 0);
    retarget(w, 'repair', 0);
    for (let i = 0; i < 40; i++) step(w, 1 / 60);
    const before = { ...w.pos };
    retarget(w, 'planning', 0);
    const trail = walk(w);
    expect(Math.hypot(trail[1]!.x - before.x, trail[1]!.z - before.z)).toBeLessThan(0.5);
    for (const p of samples(trail)) {
      const room = ZONES.find(z => inRoom(p, z, 0.3));
      if (room) expect(['explorer', 'repair', 'planning']).toContain(room);
    }
    expect(w.zone).toBe('planning');
  });

  it('moves within a room directly, snaps when asked, and plays faster in fast replay', () => {
    const w = spawn('lab', 0);
    retarget(w, 'lab', 2);
    expect(w.path).toHaveLength(1);
    retarget(w, 'review', 0, { snap: true });
    expect(walking(w)).toBe(false);
    expect(w.pos).toEqual({ x: stationPos('review', 0).x, z: stationPos('review', 0).z });

    const slow = spawn('explorer', 0), fast = spawn('explorer', 0);
    retarget(slow, 'repair', 0);
    retarget(fast, 'repair', 0, { timeScale: 4 });
    expect(fast.speed / slow.speed).toBeCloseTo(4);
  });

  it('ignores a re-target to where it already is', () => {
    const w = spawn('mission', 1);
    retarget(w, 'mission', 1);
    expect(walking(w)).toBe(false);
  });
});

describe('camera maths', () => {
  const vp = { width: 800, height: 500 };
  const pts = footprint() as V3[];

  it('projects along the isometric axes: up is up, the view direction is flat', () => {
    expect(onScreen([0, 1, 0]).y).toBeGreaterThan(0);
    expect(onScreen([1, 0, -1]).x).toBeGreaterThan(0);
    const d = onScreen(BACK);
    expect(Math.abs(d.x) + Math.abs(d.y)).toBeLessThan(1e-9);
  });

  it('fits the building inside the padded viewport', () => {
    const pad = { x: 16, top: 60, bottom: 20 };
    const v = fit(pts, vp, pad);
    const b = bounds(pts);
    const px = (x: number) => (x - v.x) * v.zoom + vp.width / 2;
    const py = (y: number) => vp.height / 2 - (y - v.y) * v.zoom;
    expect(px(b.minX)).toBeGreaterThanOrEqual(pad.x - 1e-6);
    expect(px(b.maxX)).toBeLessThanOrEqual(vp.width - pad.x + 1e-6);
    expect(py(b.maxY)).toBeGreaterThanOrEqual(pad.top - 1e-6);
    expect(py(b.minY)).toBeLessThanOrEqual(vp.height - pad.bottom + 1e-6);
  });

  it('zooms around the cursor and respects the limits', () => {
    const v = fit(pts, vp, { x: 0, top: 0, bottom: 0 });
    const before = unproject(v, vp, 600, 120);
    const z = zoomAround(v, vp, 2, 600, 120, { min: 1, max: 100 });
    expect(z.zoom).toBeCloseTo(v.zoom * 2);
    const after = unproject(z, vp, 600, 120);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(zoomAround(v, vp, 1000, 0, 0, { min: 1, max: 30 }).zoom).toBe(30);
  });

  it('pans with the pointer and never loses the building', () => {
    const v = { x: 0, y: 0, zoom: 10 };
    expect(panBy(v, 100, 50)).toEqual({ x: -10, y: 5, zoom: 10 });
    const b = bounds(pts);
    const lost = clampView(panBy(v, -1e6, 1e6), b, { min: 1, max: 100 });
    expect(lost.x).toBe(b.maxX);
    expect(lost.y).toBe(b.maxY);
  });

  it('eases between views and lands exactly', () => {
    const a = { x: 0, y: 0, zoom: 10 }, b = { x: 10, y: -4, zoom: 40 };
    expect(mix(a, b, 0)).toEqual(a);
    expect(mix(a, b, 1)).toEqual(b);
    expect(mix(a, b, 0.5).zoom).toBeCloseTo(20);
  });
});

describe('world model', () => {
  const parse = (jsonl: string) => {
    const p = createClaudeParser('f');
    return jsonl.split('\n').flatMap((l, i) => (l ? p.parse(l, i + 1) : []));
  };
  const events = parse(demoSession().main.jsonl());
  const final = reduce('s', events);
  const after = (callId: string, status: string) => reduce('s', events.slice(0, events.findIndex(e => e.correlation?.call_id === callId && e.status === status && e.kind !== 'permission.decision') + 1));

  it('binds room props to the real counts', () => {
    const m = worldModel(final);
    const count = (z: ZoneId, tone: string) => m.rooms[z].cells.filter(c => c === tone).length;
    for (const z of ZONES) expect(m.rooms[z].cells, z).toHaveLength(CAPACITY[z]);
    expect(count('explorer', 'zone')).toBe(1); // one file read
    expect(count('implementation', 'zone')).toBe(1); // one file changed
    expect(count('review', 'zone')).toBe(1);
    expect(m.rooms.planning.cells.slice(0, 2)).toEqual(['warn', 'paper']); // in progress, pending
    expect(count('lab', 'ok')).toBeGreaterThan(0);
    expect(count('lab', 'error')).toBeGreaterThan(0);
    expect(m.rooms.lab.cells[0]).toBe('ok'); // newest verdict first: the rerun passed
    expect(count('approval', 'ok')).toBe(1);
    expect(count('approval', 'error')).toBe(1);
    expect(m.rooms.repair.beacon).toBe(false);
    expect(m.rooms.approval.gateClosed).toBe(false);
  });

  it('turns the repair beacon on after a failure and closes the gate while a question waits', () => {
    expect(worldModel(after('t-test1', 'failed')).rooms.repair.beacon).toBe(true);
    expect(worldModel(after('t-test1', 'failed')).rooms.lab.cells[0]).toBe('error');
    expect(worldModel(after('t-ask', 'pending')).rooms.approval.gateClosed).toBe(true);
  });

  it('puts each agent in its zone with its own station', () => {
    const m = worldModel(after('t-edit1', 'started'));
    expect(m.agents).toHaveLength(1);
    expect(m.agents[0]).toMatchObject({ id: 'main', zone: 'implementation', slot: 0, busy: true, main: true, initial: 'C' });
    expect(m.agents[0]!.summary).toContain('date.ts');
  });

  it('gives agents sharing a room different stations, keeps finished subagents briefly, and caps the crowd', () => {
    const s = structuredClone(final);
    const t0 = Date.parse(s.last_ts!);
    for (let i = 0; i < 15; i++) {
      s.agents[`sub${i}`] = { id: `sub${i}`, parent: 'main', label: `Helper ${i}`, phase: 'exploring', phase_source: 'observed', phase_since: new Date(t0 - i).toISOString(), phase_evidence: [], zone: 'explorer', finished: false };
    }
    s.agents.old = { id: 'old', parent: 'main', label: 'Old', phase: 'done', phase_source: 'observed', phase_since: new Date(t0 - FINISHED_LINGER_MS - 1).toISOString(), phase_evidence: [], zone: 'review', finished: true };
    const m = worldModel(s);
    expect(m.agents).toHaveLength(MAX_AGENTS);
    expect(m.agents.some(a => a.id === 'main')).toBe(true);
    expect(m.agents.some(a => a.id === 'old')).toBe(false);
    expect(m.hiddenAgents).toBe(1 + 15 - MAX_AGENTS); // main + 15 helpers, minus those shown; the long-finished one is gone
    const slots = m.agents.filter(a => a.zone === 'explorer').map(a => a.slot);
    expect(new Set(slots).size).toBe(slots.length);
  });
});
