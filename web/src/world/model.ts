import type { SourceClass } from '../../../src/core/schema.ts';
import { ZONES, type AgentState, type Phase, type SessionState, type ZoneId, type ZoneStatus } from '../../../src/core/state.ts';
import { agentColor } from '../lib/meta.ts';

/**
 * Everything the 3D world shows, derived from SessionState alone — the renderer never reads events.
 * Props in each room are bound to real counts: books are files read, sticky notes are plan items,
 * monitors are files changed, tubes are test and check verdicts, crates are files ready for review.
 */

/** Colour roles for the data-bound props; the renderer maps them onto the theme. */
export type Tone = 'zone' | 'ok' | 'error' | 'warn' | 'active' | 'paper' | 'dim';

/** How many data-bound props each room has room for. */
export const CAPACITY: Record<ZoneId, number> = {
  mission: 6, explorer: 24, planning: 12, implementation: 6, tooling: 12, lab: 8, approval: 6, review: 9, repair: 6,
};

export interface RoomModel {
  id: ZoneId;
  status: ZoneStatus;
  label: string;
  source_class: SourceClass;
  last_event?: string;
  /** One entry per prop slot; null = slot empty. */
  cells: Array<Tone | null>;
  /** Approval Gate barrier down: something is waiting for the user. */
  gateClosed?: boolean;
  /** Repair Bay beacon turning: a failure has not been fixed yet. */
  beacon?: boolean;
}

export interface AgentModel {
  id: string;
  label: string;
  initial: string;
  color: string;
  main: boolean;
  zone: ZoneId;
  /** Index among the agents in the same room → which station it stands at. */
  slot: number;
  phase: Phase;
  inferred: boolean;
  busy: boolean;
  thinking: boolean;
  waiting: boolean;
  finished: boolean;
  summary?: string;
  call_id?: string;
}

export interface WorldModel { rooms: Record<ZoneId, RoomModel>; agents: AgentModel[]; hiddenAgents: number }

/** Finished subagents stay visible this long (session time) so you see them hand over. */
export const FINISHED_LINGER_MS = 20_000;
export const MAX_AGENTS = 12;

export function worldModel(view: SessionState): WorldModel {
  const rooms = Object.fromEntries(ZONES.map(id => [id, room(view, id)])) as Record<ZoneId, RoomModel>;
  const { shown, hidden } = visibleAgents(view);
  const perRoom = new Map<ZoneId, number>();
  const agents = shown.map((a): AgentModel => {
    const slot = perRoom.get(a.zone) ?? 0;
    perRoom.set(a.zone, slot + 1);
    return {
      id: a.id, label: a.label, initial: a.id === 'main' ? 'C' : (a.label.trim()[0] ?? 'S').toUpperCase(),
      color: agentColor(view.agents, a.id), main: a.id === 'main', zone: a.zone, slot, phase: a.phase,
      inferred: a.phase_source === 'inferred', busy: !!a.activity && !a.finished,
      thinking: a.phase === 'thinking' && !a.finished, waiting: a.phase === 'awaiting_input', finished: a.finished,
      summary: a.activity?.summary, call_id: a.activity?.call_id,
    };
  });
  return { rooms, agents, hiddenAgents: hidden };
}

function visibleAgents(view: SessionState): { shown: AgentState[]; hidden: number } {
  const now = view.last_ts ? Date.parse(view.last_ts) : 0;
  const all = Object.values(view.agents).filter(a => !a.finished || now - Date.parse(a.phase_since) < FINISHED_LINGER_MS);
  // Main first, then working subagents, most recently active first; finished ones last.
  const order = (a: AgentState) => (a.id === 'main' ? 0 : a.finished ? 2 : 1);
  const sorted = all.sort((a, b) => order(a) - order(b) || b.phase_since.localeCompare(a.phase_since));
  const shown = sorted.slice(0, MAX_AGENTS);
  // Stable station assignment: within a room, agents keep the order they first appeared in.
  const firstSeen = Object.keys(view.agents);
  shown.sort((a, b) => firstSeen.indexOf(a.id) - firstSeen.indexOf(b.id));
  return { shown, hidden: all.length - shown.length };
}

function fill(n: number, tones: Array<[Tone | null, number]>): Array<Tone | null> {
  const out: Array<Tone | null> = [];
  for (const [tone, count] of tones) for (let i = 0; i < count && out.length < n; i++) out.push(tone);
  while (out.length < n) out.push(null);
  return out;
}

function room(view: SessionState, id: ZoneId): RoomModel {
  const z = view.zones[id];
  const n = CAPACITY[id];
  const base: RoomModel = { id, status: z.status, label: z.label, source_class: z.source_class, last_event: z.last_event, cells: [] };
  const busyHere = Object.values(view.agents).some(a => !a.finished && a.zone === id && a.activity);
  switch (id) {
    case 'mission': {
      // The wall screen: one panel per agent at work, lit while a turn is open.
      const working = Object.values(view.agents).filter(a => !a.finished).length;
      return { ...base, cells: fill(n, [[view.turn.open ? 'active' : view.turn.index ? 'ok' : 'dim', Math.max(1, working)], ['dim', n]]) };
    }
    case 'explorer':
      return { ...base, cells: fill(n, [['zone', Math.min(n, view.totals.files_read)], ['dim', n]]) };
    case 'planning':
      return { ...base, cells: fill(n, view.plan.items.slice(0, n).map(i => [i.status === 'completed' ? 'ok' : i.status === 'in_progress' ? 'warn' : 'paper', 1])) };
    case 'implementation': {
      const edited = Math.min(n, view.totals.files_edited);
      return { ...base, cells: fill(n, [[busyHere ? 'active' : 'zone', edited], ['dim', n]]) };
    }
    case 'tooling': {
      const total = Math.min(n, view.commands.total + view.web + view.mcp);
      const running = Math.min(total, Object.keys(view.commands.running).length);
      const failed = Math.min(total - running, view.commands.failed);
      return { ...base, cells: fill(n, [['active', running], ['error', failed], ['ok', total - running - failed], ['dim', n]]) };
    }
    case 'lab': {
      const runs = view.tests.runs + view.builds.runs;
      const failed = view.tests.failed + view.builds.failed;
      // Tubes show the share of passing runs; the newest verdict always gets the first tube.
      const red = runs ? Math.min(n, Math.max(failed ? 1 : 0, Math.round((failed / runs) * n))) : 0;
      const green = runs ? Math.min(n - red, Math.max(runs - failed ? 1 : 0, Math.round(((runs - failed) / runs) * n))) : 0;
      const lastFailed = view.tests.last === 'failed' || view.builds.last === 'failed';
      return { ...base, cells: fill(n, lastFailed ? [['error', red], ['ok', green]] : [['ok', green], ['error', red]]) };
    }
    case 'approval': {
      const pending = Object.keys(view.approvals.pending).length;
      const waiting = Object.values(view.agents).some(a => !a.finished && a.phase === 'awaiting_input');
      return {
        ...base, gateClosed: pending > 0 || waiting,
        cells: fill(n, [['warn', pending], ['error', view.approvals.blocked], ['ok', view.approvals.approved], ['dim', n]]),
      };
    }
    case 'review':
      return { ...base, cells: fill(n, [['zone', Math.min(n, view.totals.files_edited)]]) };
    case 'repair':
      return { ...base, beacon: view.repair.active, cells: fill(n, [['error', Math.min(n, view.repair.failures)], ['ok', Math.min(n, view.repair.reruns)], ['dim', n]]) };
  }
}
