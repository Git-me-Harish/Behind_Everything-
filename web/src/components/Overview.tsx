import {
  CircleAlert, ClipboardList, Code2, FlaskConical, FolderSearch, GitBranch, Info, PackageCheck, Radar, ShieldCheck,
  SquareTerminal, TriangleAlert, Wrench, type LucideIcon, Clock, Cpu, Folder,
} from 'lucide-react';
import { useState } from 'react';
import type { SessionState, ZoneId, ZoneStatus } from '../../../src/core/state.ts';
import { activityForEvent } from '../lib/activities.ts';
import { ago, clock, compact, dateTime, duration, isLive, project } from '../lib/format.ts';
import { assistantMeta, PHASE_LABEL, ZONE, ZONE_LAYOUT } from '../lib/meta.ts';
import { store, useApp, useAssistant, useNow } from '../lib/store.ts';
import { Avatar, SourceTag, agentColor, zoneVars } from './ui.tsx';

export const ZONE_ICON: Record<ZoneId, LucideIcon> = {
  mission: Radar, explorer: FolderSearch, planning: ClipboardList, implementation: Code2, lab: FlaskConical,
  repair: Wrench, tooling: SquareTerminal, approval: ShieldCheck, review: PackageCheck,
};

const LONG_RUNNING_MS = 60_000;

/** Jump to the timeline row holding an event (evidence links). */
export function revealEvent(eventId: string) {
  const a = activityForEvent(store.state.activities, eventId);
  if (!a) return;
  // Make sure the target row is not hidden by a filter.
  store.setFilter({ categories: new Set(), failedOnly: false, text: '', agent: undefined, file: undefined });
  store.select({ type: 'activity', key: a.key });
}

export function SessionHeader({ view }: { view: SessionState }) {
  const session = useApp(s => s.sessions.find(x => x.id === s.sessionId));
  const replaying = useApp(s => s.cursor !== null);
  const now = useNow(5000);
  if (!session) return null;
  const live = !replaying && isLive(session.last_ts, now);
  const changed = Object.values(view.files).filter(f => f.edits > 0).length;
  const span = view.started_at && view.last_ts ? Date.parse(view.last_ts) - Date.parse(view.started_at) : undefined;
  return (
    <section className="session-header" aria-label="Session">
      <div style={{ minWidth: 0 }}>
        <h1>{view.title ?? session.title ?? project(session.cwd)}</h1>
        <div className="facts">
          <span title={session.cwd}><Folder size={13} />{project(session.cwd)}</span>
          {session.git_branch && <span><GitBranch size={13} />{session.git_branch}</span>}
          {session.model && <span><Cpu size={13} />{session.model}</span>}
          <span title={session.started_at ? dateTime(session.started_at) : ''}><Clock size={13} />{span !== undefined ? duration(span) : ''} · {replaying ? `replaying at ${view.last_ts ? clock(view.last_ts) : 'the start'}` : live ? 'live now' : `last active ${ago(session.last_ts, now)}`}</span>
          {session.version && <span className="muted">{assistantMeta(session.assistant).name} {session.version}</span>}
        </div>
      </div>
      <div className="stat-row">
        <Stat value={view.turn.index} label="Turns" />
        <Stat value={changed} label="Files changed" />
        <Stat value={`${view.tests.passed}/${view.tests.runs}`} label="Tests passed" tone={view.tests.last === 'failed' ? 'error' : undefined} />
        {assistantMeta(session.assistant).tokens
          ? <Stat value={compact(view.tokens.output)} label="Output tokens" />
          : <Stat value="—" label="Output tokens" hint={`${assistantMeta(session.assistant).name} does not log token usage per call`} />}
      </div>
    </section>
  );
}

function Stat({ value, label, tone, hint }: { value: number | string; label: string; tone?: 'error'; hint?: string }) {
  return (
    <div className="stat" title={hint}>
      <b style={tone ? { color: 'var(--error)' } : undefined}>{value}</b>
      <small>{label}</small>
    </div>
  );
}

export function Agents({ view }: { view: SessionState }) {
  const filterAgent = useApp(s => s.filter.agent);
  const replaying = useApp(s => s.cursor !== null);
  const now = useNow(1000);
  const assistant = useAssistant();
  const agents = Object.values(view.agents).sort((a, b) => Number(a.finished) - Number(b.finished));
  if (!agents.length) return null;
  const shown = agents.slice(0, 8);
  return (
    <section className="agents" aria-label="Agents">
      {shown.map(a => {
        const color = agentColor(view.agents, a.id, assistant);
        const busy = !!a.activity && !a.finished;
        const elapsed = a.activity && !replaying ? now - Date.parse(a.activity.started_at) : undefined;
        return (
          <button
            key={a.id}
            className={`agent${a.phase_source === 'inferred' ? ' inferred' : ''}`}
            style={a.finished ? { opacity: 0.6 } : undefined}
            aria-pressed={filterAgent === a.id}
            onClick={() => store.setFilter({ agent: filterAgent === a.id ? undefined : a.id })}
            title={a.phase_source === 'inferred' ? 'Phase inferred from a pattern of events — open the zone for the evidence' : 'Filter the timeline to this agent'}
          >
            <Avatar agent={a} color={color} busy={busy} />
            <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="who truncate">{a.label}</span>
                <span className="tag" style={{ color }}>{a.phase_source === 'inferred' ? '~ ' : ''}{PHASE_LABEL[a.phase]}</span>
              </span>
              <span className="what truncate" style={{ maxWidth: 360 }}>
                {a.activity ? a.activity.summary : a.parent ? `Subagent of ${view.agents[a.parent]?.label ?? assistantMeta(assistant).agent}` : 'No active tool call'}
                {elapsed !== undefined && elapsed > 1500 ? ` · ${duration(elapsed)}` : ''}
              </span>
            </span>
          </button>
        );
      })}
      {agents.length > shown.length && <span className="chip">+{agents.length - shown.length} more agents</span>}
    </section>
  );
}

/** Selects a zone (details + timeline focused on it), or clears it if it was already selected. */
export function toggleZone(id: ZoneId) {
  const on = !(store.state.selection?.type === 'zone' && store.state.selection.id === id);
  store.select(on ? { type: 'zone', id } : null);
  store.setFilter({ categories: new Set(on ? ZONE[id].categories : []), failedOnly: on && !!ZONE[id].failedOnly });
}

/** Clicking an agent shows what it is doing right now; with nothing running, it filters the timeline to it. */
export function pickAgent(id: string, callId: string | undefined) {
  if (callId) return store.select({ type: 'activity', key: `call:${callId}` });
  store.setFilter({ agent: store.state.filter.agent === id ? undefined : id });
}

export const zoneDot = (status: ZoneStatus) => (status === 'idle' ? '' : status === 'active' ? 'active pulse' : status === 'warn' ? 'warn pulse' : status);

export function ZoneBoard({ view, compact }: { view: SessionState; compact: boolean }) {
  const assistant = useAssistant();
  const selected = useApp(s => (s.selection?.type === 'zone' ? s.selection.id : undefined));
  return (
    <section className={`board${compact ? ' compact' : ''}`} aria-label="Workspace zones">
      {ZONE_LAYOUT.map(id => {
        const z = view.zones[id];
        const meta = ZONE[id];
        const Icon = ZONE_ICON[id];
        const occupants = Object.values(view.agents).filter(a => !a.finished && a.zone === id);
        return (
          <button
            key={id}
            className={`zone status-${z.status}${z.source_class === 'inferred' ? ' inferred' : ''}`}
            style={zoneVars(id)}
            aria-pressed={selected === id}
            aria-label={`${meta.name}: ${z.label}${occupants.length ? `, ${occupants.map(o => o.label).join(', ')} here` : ''}`}
            title={meta.blurb}
            onClick={() => toggleZone(id)}
          >
            <span className="zone-top">
              <span className="badge"><Icon size={12} aria-hidden />{meta.name}</span>
              <span className="occupants">
                {occupants.map(a => <Avatar key={a.id} agent={a} color={agentColor(view.agents, a.id, assistant)} busy={!!a.activity} />)}
              </span>
            </span>
            <span className={`pill${z.source_class === 'inferred' ? ' inferred' : ''}`} title={z.label}>
              <span className={`dot ${zoneDot(z.status)}`} />
              <span>{z.label}</span>
            </span>
          </button>
        );
      })}
    </section>
  );
}

export function Attention({ view }: { view: SessionState }) {
  const replaying = useApp(s => s.cursor !== null);
  const now = useNow(5000);
  const [all, setAll] = useState(false);
  const items = view.attention.filter(a => !a.resolved).slice().reverse();
  // Long-running commands are judged against the clock, so only while following live — and not while the agent
  // is waiting for your approval to run them.
  const slow = replaying ? [] : Object.entries(view.commands.running)
    .filter(([, c]) => now - Date.parse(c.started_at) > LONG_RUNNING_MS && view.agents[c.agent_id]?.phase !== 'awaiting_input')
    .map(([id, c]) => ({ id: `slow:${id}`, severity: 'warn' as const, message: `Still running after ${duration(now - Date.parse(c.started_at))}: ${c.summary}`, source_class: 'observed' as const, evidence: [] as string[], ts: c.started_at, call: id }));
  const list = [...slow, ...items];
  if (!list.length) return null;
  const shown = all ? list : list.slice(0, 2);
  return (
    <section className="attention" aria-label="Needs attention">
      {shown.map(a => {
        const Icon = a.severity === 'error' ? CircleAlert : a.severity === 'warn' ? TriangleAlert : Info;
        const target = 'call' in a ? undefined : a.evidence.at(-1);
        return (
          <button
            key={a.id}
            className={`alert ${a.severity}${a.source_class === 'inferred' ? ' inferred' : ''}`}
            onClick={() => ('call' in a ? store.select({ type: 'activity', key: `call:${a.call}` }) : target && revealEvent(target))}
          >
            <Icon size={15} color={a.severity === 'error' ? 'var(--error)' : a.severity === 'warn' ? 'var(--warn)' : 'var(--active)'} aria-hidden />
            <span className="truncate">{a.message}</span>
            {a.source_class === 'inferred' && <SourceTag source="inferred" />}
            <span className="when">{ago(a.ts, now)}</span>
          </button>
        );
      })}
      {list.length > 2 && (
        <button className="link" style={{ alignSelf: 'flex-start', fontSize: 12 }} onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${list.length} items needing attention`}
        </button>
      )}
    </section>
  );
}
