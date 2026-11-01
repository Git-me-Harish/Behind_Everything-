import type { Phase, ZoneId, ZoneStatus } from '../../src/core/state.ts';
import { ZONES } from '../../src/core/state.ts';
import { MASCOTS } from '../../web/src/world/mascots.ts';
import { CAPACITY, type AgentModel, type RoomModel, type Tone, type WorldModel } from '../../web/src/world/model.ts';

/**
 * The hero's scripted session: Claude, Codex and Copilot working through the same building, one beat every few
 * seconds, looping. It drives the real renderer with the same model the app derives from a live session, so the
 * page shows the product itself rather than a video of it.
 */

export const BEAT_MS = 3400;

type Who = 'claude' | 'codex' | 'copilot' | 'reviewer';
interface Act { zone: ZoneId; phase: Phase; summary: string; busy?: boolean; thinking?: boolean; waiting?: boolean; finished?: boolean }

const CAST: Record<Who, Pick<AgentModel, 'label' | 'initial' | 'color' | 'main' | 'avatar'>> = {
  claude: { label: 'Claude', initial: 'C', color: '#d97757', main: true, avatar: 'clawd' },
  codex: { label: 'Codex', initial: 'C', color: MASCOTS.blob.color!, main: true, avatar: 'blob' },
  copilot: { label: 'Copilot', initial: 'C', color: '#8b5cf6', main: true, avatar: 'copilot' },
  reviewer: { label: 'Reviewer', initial: 'R', color: MASCOTS.heart.color!, main: false, avatar: 'heart' },
};

/** What each agent does on each beat; undefined means it is not on the map. */
const SCRIPT: Array<Partial<Record<Who, Act>>> = [
  {
    claude: { zone: 'explorer', phase: 'exploring', summary: 'Reading src/cart.ts', busy: true },
    codex: { zone: 'planning', phase: 'planning', summary: 'Planning the API change', thinking: true },
    copilot: { zone: 'mission', phase: 'thinking', summary: 'Thinking', thinking: true },
  },
  {
    claude: { zone: 'implementation', phase: 'implementing', summary: 'Editing src/cart.ts', busy: true },
    codex: { zone: 'tooling', phase: 'running', summary: 'pnpm install zod', busy: true },
    copilot: { zone: 'approval', phase: 'awaiting_input', summary: 'Approve: rm -rf dist', waiting: true },
  },
  {
    claude: { zone: 'lab', phase: 'testing', summary: 'pnpm test', busy: true },
    codex: { zone: 'implementation', phase: 'implementing', summary: 'Editing api/routes.ts', busy: true },
    copilot: { zone: 'approval', phase: 'awaiting_input', summary: 'Approve: rm -rf dist', waiting: true },
  },
  {
    claude: { zone: 'repair', phase: 'repairing', summary: 'Fixing the failing test', busy: true },
    codex: { zone: 'lab', phase: 'testing', summary: 'pytest -q', busy: true },
    copilot: { zone: 'tooling', phase: 'running', summary: 'Removing dist', busy: true },
    reviewer: { zone: 'review', phase: 'exploring', summary: 'Reviewing the diff', busy: true },
  },
  {
    claude: { zone: 'lab', phase: 'testing', summary: 'pnpm test', busy: true },
    codex: { zone: 'review', phase: 'delivering', summary: 'Handing over' },
    copilot: { zone: 'explorer', phase: 'exploring', summary: 'Searching for TODOs', busy: true },
    reviewer: { zone: 'review', phase: 'exploring', summary: 'Reviewing the diff', busy: true },
  },
  {
    claude: { zone: 'review', phase: 'delivering', summary: 'All tests pass' },
    codex: { zone: 'mission', phase: 'thinking', summary: 'Thinking', thinking: true },
    copilot: { zone: 'planning', phase: 'planning', summary: 'Writing the plan', busy: true },
    reviewer: { zone: 'review', phase: 'done', summary: 'No issues found', finished: true },
  },
  {
    claude: { zone: 'mission', phase: 'thinking', summary: 'Thinking', thinking: true },
    codex: { zone: 'explorer', phase: 'exploring', summary: 'Reading api/schema.ts', busy: true },
    copilot: { zone: 'implementation', phase: 'implementing', summary: 'Editing README.md', busy: true },
  },
];

export const BEATS = SCRIPT.length;

const fill = (n: number, parts: Array<[Tone, number]>): Array<Tone | null> => {
  const out: Array<Tone | null> = [];
  for (const [tone, count] of parts) for (let i = 0; i < count && out.length < n; i++) out.push(tone);
  while (out.length < n) out.push(null);
  return out;
};

/** Room props grow as the story goes on; failures turn red and clear once fixed. */
function rooms(beat: number, acts: Partial<Record<Who, Act>>): Record<ZoneId, RoomModel> {
  const here = (z: ZoneId) => Object.values(acts).filter(a => a && a.zone === z && !a.finished);
  const busy = (z: ZoneId) => here(z).some(a => a!.busy);
  const waiting = here('approval').some(a => a!.waiting);
  const failing = beat === 2 || beat === 3;
  const status = (z: ZoneId, fallback: ZoneStatus): ZoneStatus => (busy(z) || here(z).length ? 'active' : fallback);
  const r = (id: ZoneId, cells: Array<[Tone, number]>, st: ZoneStatus, extra: Partial<RoomModel> = {}): RoomModel =>
    ({ id, status: st, label: '', source_class: 'observed', last_event: here(id).length ? `${id}:${beat}` : undefined, cells: fill(CAPACITY[id], cells), ...extra });
  const n = beat + 1;
  return {
    mission: r('mission', [['active', 3], ['dim', 6]], status('mission', 'ok')),
    explorer: r('explorer', [['zone', Math.min(24, 5 + n * 3)], ['dim', 24]], status('explorer', 'ok')),
    planning: r('planning', [['ok', Math.min(5, n)], ['warn', 1], ['paper', 3]], status('planning', 'ok')),
    implementation: r('implementation', [[busy('implementation') ? 'active' : 'zone', Math.min(6, 1 + n)], ['dim', 6]], status('implementation', 'ok')),
    tooling: r('tooling', [['active', busy('tooling') ? 1 : 0], ['ok', Math.min(10, 2 + n)], ['dim', 12]], status('tooling', 'ok')),
    lab: r('lab', failing ? [['error', 2], ['ok', 3]] : [['ok', Math.min(8, 3 + n)]], failing ? 'error' : status('lab', 'ok')),
    approval: r('approval', [['warn', waiting ? 1 : 0], ['ok', Math.min(5, 1 + Math.floor(n / 2))], ['dim', 6]], waiting ? 'warn' : status('approval', 'ok'), { gateClosed: waiting }),
    review: r('review', [['zone', Math.min(9, n)], ['dim', 9]], status('review', n > 4 ? 'ok' : 'idle')),
    repair: r('repair', failing ? [['error', 1], ['warn', 1]] : [['ok', 1]], failing ? 'warn' : 'ok', { beacon: failing }),
  };
}

/** The world on a given beat (wrapping around), with agents sharing a room at different stations. */
export function storyAt(beat: number): WorldModel {
  const b = ((beat % BEATS) + BEATS) % BEATS;
  const acts = SCRIPT[b]!;
  const perRoom = new Map<ZoneId, number>();
  const agents: AgentModel[] = (Object.keys(CAST) as Who[]).flatMap(who => {
    const act = acts[who];
    if (!act) return [];
    const slot = perRoom.get(act.zone) ?? 0;
    perRoom.set(act.zone, slot + 1);
    return [{
      id: who, ...CAST[who], zone: act.zone, slot, phase: act.phase, inferred: false,
      busy: !!act.busy, thinking: !!act.thinking, waiting: !!act.waiting, finished: !!act.finished, summary: act.summary,
    }];
  });
  return { rooms: rooms(b, acts), agents, hiddenAgents: 0 };
}

export const ROOMS: ZoneId[] = [...ZONES];
