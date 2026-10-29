import type { EventKind, SourceClass, Status } from '../../../src/core/schema.ts';
import type { StoredEvent } from './types.ts';
import { KIND, type Category } from './meta.ts';
import { inferredFailure } from '../../../src/core/verdict.ts';

/** One row in the timeline: a tool call with its result and side effects, or a standalone event. */
export interface Activity {
  key: string;
  kind: EventKind;
  category: Category;
  status?: Status;
  agent_id: string;
  turn_id?: string;
  summary: string;
  tool?: string;
  ts: string;
  end_ts?: string;
  duration_ms?: number;
  seq: number;
  last_seq: number;
  source_class: SourceClass;
  start: StoredEvent;
  result?: StoredEvent;
  /** Permission decisions and files changed by a command, linked by call id. */
  related: StoredEvent[];
  files: string[];
  /** Exit code said success but the output reports failures (see core/verdict.ts). */
  inferred_failure?: string;
}

export type Row =
  | { type: 'turn'; key: string; turn_id?: string; index: number; prompt?: StoredEvent; ts: string; end?: StoredEvent }
  | { type: 'activity'; key: string; activity: Activity };

const HIDDEN: Set<EventKind> = new Set(['usage.tokens', 'session.start', 'turn.start', 'turn.end', 'user.prompt']);

export function buildActivities(events: StoredEvent[]): Activity[] {
  const out: Activity[] = [];
  const byCall = new Map<string, Activity>();
  for (const e of events) {
    const callId = e.correlation?.call_id;
    const open = callId ? byCall.get(callId) : undefined;
    if (open) {
      if (e.kind === 'permission.decision' || e.payload?.op === 'command') open.related.push(e);
      else {
        open.result = e;
        open.status = e.status;
        open.end_ts = e.ts;
        open.duration_ms = e.duration_ms;
        open.inferred_failure = inferredFailure(e);
        if (e.kind === 'subagent.end') open.kind = 'subagent.start';
      }
      open.last_seq = e.seq;
      for (const r of e.resources ?? []) if (r.type === 'file' && !open.files.includes(r.ref)) open.files.push(r.ref);
      continue;
    }
    const a: Activity = {
      key: callId ? `call:${callId}` : e.id,
      kind: e.kind, category: KIND[e.kind].category, status: e.status, agent_id: e.agent_id, turn_id: e.turn_id,
      summary: e.summary, tool: e.tool, ts: e.ts, duration_ms: e.duration_ms, seq: e.seq, last_seq: e.seq,
      source_class: e.source_class, start: e, related: [],
      files: (e.resources ?? []).filter(r => r.type === 'file').map(r => r.ref),
    };
    if (callId && e.kind !== 'permission.decision') byCall.set(callId, a);
    out.push(a);
  }
  return out;
}

export interface Filter {
  categories: Set<Category>;
  failedOnly: boolean;
  text: string;
  agent?: string;
  file?: string;
}

export const emptyFilter = (): Filter => ({ categories: new Set(), failedOnly: false, text: '' });

export function isFiltering(f: Filter) {
  return f.categories.size > 0 || f.failedOnly || f.text.trim() !== '' || f.agent !== undefined || f.file !== undefined;
}

export function matches(a: Activity, f: Filter): boolean {
  if (f.categories.size && !f.categories.has(a.category)) return false;
  if (f.failedOnly && a.status !== 'failed' && !a.inferred_failure && !a.related.some(r => r.status === 'failed')) return false;
  if (f.agent && a.agent_id !== f.agent) return false;
  if (f.file && !a.files.includes(f.file)) return false;
  const q = f.text.trim().toLowerCase();
  if (q) {
    const hay = [a.summary, a.tool, KIND[a.kind].label, a.kind, ...a.files, ...(a.start.resources ?? []).map(r => r.ref)].join('\n').toLowerCase();
    if (!q.split(/\s+/).every(w => hay.includes(w))) return false;
  }
  return true;
}

/** Timeline rows: a header per turn, then that turn's visible activities. */
export function buildRows(events: StoredEvent[], activities: Activity[], f: Filter): Row[] {
  const turns = new Map<string, { prompt?: StoredEvent; start?: StoredEvent; end?: StoredEvent }>();
  for (const e of events) {
    if (!e.turn_id) continue;
    const t = turns.get(e.turn_id) ?? {};
    if (e.kind === 'user.prompt') t.prompt = e;
    if (e.kind === 'turn.start') t.start = e;
    if (e.kind === 'turn.end') t.end = e;
    turns.set(e.turn_id, t);
  }
  const rows: Row[] = [];
  const seenTurns = new Map<string | undefined, number>();
  const filtering = isFiltering(f);
  for (const a of activities) {
    if (HIDDEN.has(a.kind)) {
      // Keep empty turns visible when not filtering, so the conversation shape stays readable.
      if (!filtering && a.kind === 'turn.start' && !seenTurns.has(a.turn_id)) pushTurn(a.turn_id, a.ts);
      continue;
    }
    // Sub-second reasoning blocks are noise in the timeline; longer ones show where the model paused to think.
    if (a.kind === 'assistant.reasoning' && (a.duration_ms ?? 0) < 1000) continue;
    if (!matches(a, f)) continue;
    if (!seenTurns.has(a.turn_id)) pushTurn(a.turn_id, a.ts);
    rows.push({ type: 'activity', key: a.key, activity: a });
  }
  return rows;

  function pushTurn(turn_id: string | undefined, ts: string) {
    const index = seenTurns.size + 1;
    seenTurns.set(turn_id, index);
    const t = turn_id ? turns.get(turn_id) : undefined;
    rows.push({ type: 'turn', key: `turn:${turn_id ?? 'pre'}`, turn_id, index, prompt: t?.prompt, ts: t?.start?.ts ?? ts, end: t?.end });
  }
}

/** Turn numbers as the session counts them (1-based, in order of appearance). */
export function turnNumbers(events: StoredEvent[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of events) if (e.kind === 'turn.start' && e.turn_id && !m.has(e.turn_id)) m.set(e.turn_id, m.size + 1);
  return m;
}

/** Activities as they looked after the event with sequence `limit`: later results are not known yet. */
export function asOf(activities: Activity[], limit: number | null): Activity[] {
  if (limit === null) return activities;
  const out: Activity[] = [];
  for (const a of activities) {
    if (a.seq > limit) break;
    if (a.last_seq <= limit) { out.push(a); continue; }
    const result = a.result && a.result.seq <= limit ? a.result : undefined;
    out.push({
      ...a, result, status: result?.status ?? a.start.status, end_ts: result?.ts, duration_ms: result?.duration_ms,
      inferred_failure: result ? a.inferred_failure : undefined,
      related: a.related.filter(r => r.seq <= limit), last_seq: limit,
    });
  }
  return out;
}

/** The timeline row that contains a given event — used to jump from evidence ids to rows. */
export function activityForEvent(activities: Activity[], eventId: string): Activity | undefined {
  return activities.find(a => a.start.id === eventId || a.result?.id === eventId || a.related.some(r => r.id === eventId));
}
