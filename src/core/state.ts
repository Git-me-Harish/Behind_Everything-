import type { CanonicalEvent, EventKind, SourceClass } from './schema.js';
import { inferredFailure } from './verdict.js';

export const ZONES = ['mission', 'explorer', 'planning', 'implementation', 'lab', 'repair', 'tooling', 'approval', 'review'] as const;
export type ZoneId = (typeof ZONES)[number];

export type Phase =
  | 'idle' | 'thinking' | 'exploring' | 'planning' | 'implementing' | 'testing'
  | 'repairing' | 'running' | 'researching' | 'delegating' | 'awaiting_input' | 'delivering' | 'done';

export const PHASE_ZONE: Record<Phase, ZoneId> = {
  idle: 'mission', thinking: 'mission', delegating: 'mission', exploring: 'explorer', planning: 'planning',
  implementing: 'implementation', testing: 'lab', repairing: 'repair', running: 'tooling', researching: 'tooling',
  awaiting_input: 'approval', delivering: 'review', done: 'review',
};

export interface AgentState {
  id: string;
  parent?: string;
  label: string;
  phase: Phase;
  /** Inferred when the phase is derived from a pattern (e.g. repairing) rather than the current action. */
  phase_source: SourceClass;
  phase_since: string;
  /** Event ids that justify the current phase. */
  phase_evidence: string[];
  activity?: { call_id?: string; kind: EventKind; summary: string; started_at: string };
  /**
   * Where the agent is in the workspace. Follows the phase, except that thinking happens wherever the
   * agent already is — only a new prompt calls it back to Mission Control.
   */
  zone: ZoneId;
  finished: boolean;
}

export interface FileState { path: string; reads: number; edits: number; added: number; removed: number; last_ts: string; last_event: string }

export type ZoneStatus = 'idle' | 'active' | 'ok' | 'warn' | 'error';
export interface ZoneState { id: ZoneId; status: ZoneStatus; label: string; count: number; source_class: SourceClass; last_event?: string }

export interface Attention {
  id: string;
  severity: 'info' | 'warn' | 'error';
  message: string;
  source_class: SourceClass;
  evidence: string[];
  ts: string;
  resolved: boolean;
}

export interface RunStats {
  runs: number;
  passed: number;
  failed: number;
  last?: 'passed' | 'failed';
  /** The last verdict came from the output text, not the exit code. */
  last_inferred?: boolean;
  last_event?: string;
}

export interface SessionState {
  session_id: string;
  started_at?: string;
  last_ts?: string;
  title?: string;
  turn: { index: number; id?: string; started_at?: string; open: boolean; edits: Record<string, number> };
  agents: Record<string, AgentState>;
  zones: Record<ZoneId, ZoneState>;
  files: Record<string, FileState>;
  searches: number;
  /** Running totals over `files`, so zone labels never rescan every file (sessions touch hundreds). */
  totals: { files_read: number; files_edited: number; added: number; removed: number };
  commands: { total: number; failed: number; dependencies: number; running: Record<string, { summary: string; kind: EventKind; started_at: string; agent_id: string }> };
  tests: RunStats;
  builds: RunStats;
  plan: { items: Array<{ text: string; status: string }>; proposals: number; last_event?: string };
  approvals: { pending: Record<string, { summary: string; ts: string; event: string }>; approved: number; blocked: number };
  repair: { active: boolean; failures: number; reruns: number; evidence: string[] };
  tokens: { input: number; output: number; cache_read: number };
  web: number;
  mcp: number;
  attention: Attention[];
  event_count: number;
  unknown_count: number;
  /** Subagent calls not yet matched to the agent id that appears in its transcript. */
  pending_subagents: Array<{ call_id: string; label: string; parent: string }>;
}

/** What the main agent is called on screen. */
export const ASSISTANT_NAME: Record<CanonicalEvent['assistant'], string> = { 'claude-code': 'Claude', codex: 'Codex', 'copilot-cli': 'Copilot', 'copilot-vscode': 'Copilot' };

export function initialState(session_id: string): SessionState {
  const zones = Object.fromEntries(ZONES.map(id => [id, { id, status: 'idle', label: '', count: 0, source_class: 'observed' }])) as unknown as Record<ZoneId, ZoneState>;
  const s: SessionState = {
    session_id, turn: { index: 0, open: false, edits: {} }, agents: {}, zones, files: {}, searches: 0, totals: { files_read: 0, files_edited: 0, added: 0, removed: 0 },
    commands: { total: 0, failed: 0, dependencies: 0, running: {} },
    tests: { runs: 0, passed: 0, failed: 0 }, builds: { runs: 0, passed: 0, failed: 0 },
    plan: { items: [], proposals: 0 }, approvals: { pending: {}, approved: 0, blocked: 0 },
    repair: { active: false, failures: 0, reruns: 0, evidence: [] },
    tokens: { input: 0, output: 0, cache_read: 0 }, web: 0, mcp: 0,
    attention: [], event_count: 0, unknown_count: 0, pending_subagents: [],
  };
  refreshZones(s);
  return s;
}

const EDIT_LOOP_THRESHOLD = 4;
const MAX_ATTENTION = 100;

/** Applies one event to the state in place. Deterministic: replaying the same events gives the same state. */
export function applyEvent(s: SessionState, e: CanonicalEvent): SessionState {
  s.event_count++;
  s.started_at ??= e.ts;
  if (!s.last_ts || e.ts > s.last_ts) s.last_ts = e.ts;
  const agent = ensureAgent(s, e);
  const started = e.status === 'started' || e.status === 'pending';
  const finished = e.status === 'succeeded' || e.status === 'failed' || e.status === 'cancelled';
  const callId = e.correlation?.call_id;

  if (finished && callId) {
    delete s.commands.running[callId];
    if (agent.activity?.call_id === callId) agent.activity = undefined;
  }

  switch (e.kind) {
    case 'session.meta':
      if (typeof e.payload?.title === 'string') s.title = e.payload.title;
      break;
    case 'turn.start':
      s.turn = { index: s.turn.index + 1, id: e.turn_id, started_at: e.ts, open: true, edits: {} };
      for (const a of Object.values(s.agents)) if (!a.parent) {
        setPhase(a, 'thinking', e);
        if (!a.finished) a.zone = 'mission';
      }
      break;
    case 'turn.end':
      s.turn.open = false;
      setPhase(agent, 'delivering', e);
      break;
    case 'assistant.reasoning': case 'assistant.message':
      if (!agent.activity) setPhase(agent, 'thinking', e);
      break;
    case 'file.read': case 'file.search':
      if (started) setPhase(agent, 'exploring', e);
      if (e.status === 'succeeded') {
        if (e.kind === 'file.search') s.searches++;
        else for (const r of e.resources ?? []) if (r.type === 'file') {
          const f = touchFile(s, r.ref, e);
          if (f.reads++ === 0) s.totals.files_read++;
        }
      }
      break;
    case 'file.edit':
      if (started) setPhase(agent, s.repair.active ? 'repairing' : 'implementing', e, s.repair.active ? 'inferred' : 'observed', s.repair.active ? s.repair.evidence : []);
      if (e.status === 'succeeded') for (const r of e.resources ?? []) if (r.type === 'file') {
        const f = touchFile(s, r.ref, e);
        if (f.edits++ === 0) s.totals.files_edited++;
        const added = num(e.payload?.added), removed = num(e.payload?.removed);
        f.added += added;
        f.removed += removed;
        s.totals.added += added;
        s.totals.removed += removed;
        const n = (s.turn.edits[r.ref] = (s.turn.edits[r.ref] ?? 0) + 1);
        if (n === EDIT_LOOP_THRESHOLD) attend(s, `loop:${s.turn.index}:${r.ref}`, 'warn', `${r.ref} edited ${n} times this turn — possible loop`, e, 'inferred');
      }
      break;
    case 'test.run': case 'build.run': {
      const bucket = e.kind === 'test.run' ? s.tests : s.builds;
      const label = e.kind === 'test.run' ? 'Tests' : 'Checks';
      if (started) {
        setPhase(agent, 'testing', e);
        if (s.repair.active) s.repair.reruns++;
      }
      if (e.status === 'succeeded' || e.status === 'failed') {
        bucket.runs++;
        bucket.last_event = e.id;
        // Exit 0 but the output reports failures (usually a piped command): count it as a failure, labelled inferred.
        const hint = inferredFailure(e);
        bucket.last_inferred = hint !== undefined;
        if (e.status === 'succeeded' && !hint) {
          bucket.passed++;
          bucket.last = 'passed';
          resolve(s, `fail:${e.kind}`);
          if (s.repair.active && s.tests.last !== 'failed' && s.builds.last !== 'failed') s.repair = { ...s.repair, active: false, evidence: [] };
        } else {
          bucket.failed++;
          bucket.last = 'failed';
          s.repair.active = true;
          s.repair.failures++;
          s.repair.evidence = [...s.repair.evidence, e.id].slice(-10);
          if (hint) attend(s, `fail:${e.kind}`, 'error', `${label} likely failed: output says “${hint}” although the exit code was 0`, e, 'inferred');
          else attend(s, `fail:${e.kind}`, 'error', `${label} failed: ${e.summary}`, e);
        }
      }
      trackCommand(s, e, started, callId, agent);
      break;
    }
    case 'command.run': case 'dependency.change': case 'mcp.call': case 'tool.call': case 'web.fetch':
      if (started) setPhase(agent, e.kind === 'web.fetch' ? 'researching' : 'running', e);
      if (e.status === 'succeeded' || e.status === 'failed') {
        if (e.kind === 'web.fetch') s.web++;
        if (e.kind === 'mcp.call') s.mcp++;
        if (e.kind === 'dependency.change') s.commands.dependencies++;
      }
      if (e.status === 'failed' && e.error_category !== 'permission_denied') {
        attend(s, `cmdfail:${e.id}`, 'warn', `Failed: ${e.summary}${e.exit_code !== undefined ? ` (exit ${e.exit_code})` : ''}`, e);
      }
      if (e.kind === 'command.run' || e.kind === 'dependency.change') trackCommand(s, e, started, callId, agent);
      break;
    case 'plan.update':
      if (started) {
        setPhase(agent, 'planning', e);
        s.plan.last_event = e.id;
        const todos = e.payload?.todos;
        if (Array.isArray(todos)) s.plan.items = todos.map((t: any) => ({ text: String(t.text ?? ''), status: String(t.status ?? 'pending') }));
        else if (e.tool === 'TaskCreate') s.plan.items.push({ text: String(e.payload?.subject ?? e.summary), status: 'pending' });
        else if (e.tool === 'ExitPlanMode') s.plan.proposals++;
      }
      break;
    case 'user.question':
      if (started && callId) {
        setPhase(agent, 'awaiting_input', e);
        s.approvals.pending[callId] = { summary: e.summary, ts: e.ts, event: e.id };
        attend(s, `ask:${callId}`, 'info', e.summary, e);
      } else if (finished && callId) {
        delete s.approvals.pending[callId];
        resolve(s, `ask:${callId}`);
      }
      break;
    case 'permission.decision':
      if (e.status === 'failed') {
        s.approvals.blocked++;
        attend(s, `perm:${e.id}`, 'warn', e.summary, e);
      } else s.approvals.approved++;
      break;
    case 'subagent.start':
      if (started && callId) {
        setPhase(agent, 'delegating', e);
        s.pending_subagents.push({ call_id: callId, label: String(e.payload?.description ?? e.summary), parent: agent.id });
      }
      break;
    case 'subagent.end': {
      const id = typeof e.payload?.agent_id === 'string' ? e.payload.agent_id : undefined;
      const sub = id ? s.agents[id] : Object.values(s.agents).find(a => a.parent && !a.finished && a.label === e.summary.replace(/^Subagent: /, ''));
      if (sub) finishAgent(sub, e);
      s.pending_subagents = s.pending_subagents.filter(p => p.call_id !== callId);
      break;
    }
    case 'usage.tokens':
      s.tokens.input += num(e.payload?.input);
      s.tokens.output += num(e.payload?.output);
      s.tokens.cache_read += num(e.payload?.cache_read);
      break;
    case 'system.error':
      attend(s, `err:${e.id}`, 'warn', e.summary, e);
      break;
    case 'system.unknown':
      s.unknown_count++;
      break;
  }

  if (started && callId && e.kind !== 'user.question') agent.activity = { call_id: callId, kind: e.kind, summary: e.summary, started_at: e.ts };
  refreshZones(s);
  return s;
}

export function reduce(session_id: string, events: Iterable<CanonicalEvent>): SessionState {
  const s = initialState(session_id);
  for (const e of events) applyEvent(s, e);
  return s;
}

function ensureAgent(s: SessionState, e: CanonicalEvent): AgentState {
  const existing = s.agents[e.agent_id];
  if (existing) return existing;
  // A subagent's transcript doesn't name the call that spawned it: pair it with the oldest unmatched call.
  const pending = e.agent_id !== 'main' ? s.pending_subagents.shift() : undefined;
  const agent: AgentState = {
    id: e.agent_id,
    parent: e.agent_id === 'main' ? undefined : pending?.parent ?? 'main',
    label: e.agent_id === 'main' ? ASSISTANT_NAME[e.assistant] : pending?.label ?? 'Subagent',
    phase: 'idle', phase_source: 'observed', phase_since: e.ts, phase_evidence: [], zone: 'mission', finished: false,
  };
  s.agents[e.agent_id] = agent;
  return agent;
}

function setPhase(a: AgentState, phase: Phase, e: CanonicalEvent, source: SourceClass = 'observed', evidence: string[] = []) {
  if (a.finished) return;
  if (a.phase !== phase) a.phase_since = e.ts;
  a.phase = phase;
  if (phase !== 'thinking') a.zone = PHASE_ZONE[phase];
  a.phase_source = source;
  a.phase_evidence = [...evidence, e.id];
}

function finishAgent(a: AgentState, e: CanonicalEvent) {
  setPhase(a, 'done', e);
  a.finished = true;
  a.activity = undefined;
}

function trackCommand(s: SessionState, e: CanonicalEvent, started: boolean, callId: string | undefined, agent: AgentState) {
  if (started && callId) {
    s.commands.total++;
    s.commands.running[callId] = { summary: e.summary, kind: e.kind, started_at: e.ts, agent_id: agent.id };
  }
  if (e.status === 'failed') s.commands.failed++;
}

function touchFile(s: SessionState, path: string, e: CanonicalEvent): FileState {
  const f = (s.files[path] ??= { path, reads: 0, edits: 0, added: 0, removed: 0, last_ts: e.ts, last_event: e.id });
  f.last_ts = e.ts;
  f.last_event = e.id;
  return f;
}

function attend(s: SessionState, id: string, severity: Attention['severity'], message: string, e: CanonicalEvent, source_class: SourceClass = 'observed') {
  const existing = s.attention.find(a => a.id === id && !a.resolved);
  if (existing) {
    existing.message = message;
    existing.evidence = [...existing.evidence, e.id].slice(-10);
    existing.ts = e.ts;
    return;
  }
  s.attention.push({ id, severity, message, source_class, evidence: [e.id], ts: e.ts, resolved: false });
  if (s.attention.length > MAX_ATTENTION) s.attention.splice(0, s.attention.length - MAX_ATTENTION);
}

function resolve(s: SessionState, id: string) {
  for (const a of s.attention) if (a.id === id) a.resolved = true;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function refreshZones(s: SessionState) {
  const z = s.zones;
  const occupied = new Set(Object.values(s.agents).filter(a => !a.finished).map(a => a.zone));
  const set = (id: ZoneId, label: string, count: number, status: ZoneStatus, source_class: SourceClass = 'observed', last_event?: string) => {
    z[id] = { id, label, count, status: status === 'idle' && occupied.has(id) ? 'active' : status === 'ok' && occupied.has(id) ? 'active' : status, source_class, last_event };
  };
  const { files_read: reads, files_edited: edited, added, removed } = s.totals;
  const done = s.plan.items.filter(i => i.status === 'completed').length;
  const pending = Object.keys(s.approvals.pending).length;
  const openIssues = s.attention.filter(a => !a.resolved && a.severity !== 'info').length;

  set('mission', s.turn.index ? `TURN ${s.turn.index}${s.turn.open ? ' · LIVE' : ''}` : 'WAITING', s.turn.index, s.turn.open ? 'active' : s.turn.index ? 'ok' : 'idle');
  set('explorer', `${reads} READ · ${plural(s.searches, 'SEARCH', 'SEARCHES')}`, reads + s.searches, reads + s.searches ? 'ok' : 'idle');
  set('planning', s.plan.items.length ? `PLAN ${done}/${s.plan.items.length}` : s.plan.proposals ? `${s.plan.proposals} PLAN${s.plan.proposals > 1 ? 'S' : ''}` : 'NO PLAN', s.plan.items.length, s.plan.items.length || s.plan.proposals ? 'ok' : 'idle', 'observed', s.plan.last_event);
  set('implementation', `${plural(edited, 'FILE')} · +${added} −${removed}`, edited, edited ? 'ok' : 'idle');
  set('lab', s.tests.runs || s.builds.runs ? `TESTS ${s.tests.passed}✓ ${s.tests.failed}✗ · CHECKS ${s.builds.passed}✓ ${s.builds.failed}✗` : 'NO RUNS', s.tests.runs + s.builds.runs,
    s.tests.last === 'failed' || s.builds.last === 'failed' ? 'error' : s.tests.runs + s.builds.runs ? 'ok' : 'idle',
    s.tests.last_inferred || s.builds.last_inferred ? 'inferred' : 'observed', s.tests.last_event ?? s.builds.last_event);
  set('repair', s.repair.active ? `~ REPAIRING · ${s.repair.reruns} RERUNS` : s.repair.failures ? `~ ${s.repair.failures} FIXED` : 'CLEAR', s.repair.failures, s.repair.active ? 'warn' : s.repair.failures ? 'ok' : 'idle', 'inferred', s.repair.evidence.at(-1));
  set('tooling', `${plural(s.commands.total, 'CMD')} · ${plural(s.commands.dependencies, 'DEP')}${s.web ? ` · ${s.web} WEB` : ''}${s.mcp ? ` · ${s.mcp} MCP` : ''}`, s.commands.total + s.web + s.mcp,
    Object.keys(s.commands.running).length ? 'active' : s.commands.total + s.web + s.mcp ? 'ok' : 'idle');
  set('approval', pending ? `${pending} WAITING` : `${s.approvals.approved} APPROVED · ${s.approvals.blocked} BLOCKED`, pending, pending ? 'warn' : s.approvals.approved + s.approvals.blocked ? 'ok' : 'idle');
  set('review', s.turn.index && !s.turn.open ? `${edited} CHANGED · ${openIssues} OPEN` : edited ? `${edited} CHANGED` : 'NOTHING YET', edited,
    s.turn.index && !s.turn.open ? (openIssues ? 'warn' : 'ok') : 'idle');
}

/** "1 FILE", "3 FILES" — zone labels read as sentences. */
const plural = (n: number, one: string, many = `${one}S`) => `${n} ${n === 1 ? one : many}`;

