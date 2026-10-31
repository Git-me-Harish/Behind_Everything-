import { Ban, Check, CircleDashed, Clock, LoaderCircle, SquareTerminal, X } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { SourceClass } from '../../../src/core/schema.ts';
import type { AgentState, ZoneId } from '../../../src/core/state.ts';
import type { Activity } from '../lib/activities.ts';
import { AGENT_COLORS, assistantMeta, mascotOf, SOURCE_INFO } from '../lib/meta.ts';
import { cells, MASCOTS, mascotFor, partColor, type MascotId } from '../world/mascots.ts';
import { useAssistant } from '../lib/store.ts';
import { CLAWD_COLS, CLAWD_ROWS, clawdRuns, PIXEL } from '../world/clawd.ts';

export { agentColor } from '../lib/meta.ts';

export type RowStatus = 'ok' | 'failed' | 'running' | 'pending' | 'cancelled' | 'none';

export function activityStatus(a: Activity): RowStatus {
  if (a.inferred_failure) return 'failed';
  switch (a.status) {
    case 'succeeded': return 'ok';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'pending': return 'pending';
    case 'started': return 'running';
    default: return 'none';
  }
}

const STATUS_LABEL: Record<RowStatus, string> = { ok: 'Succeeded', failed: 'Failed', running: 'Running', pending: 'Waiting for you', cancelled: 'Cancelled', none: '' };

export function StatusIcon({ status }: { status: RowStatus }) {
  if (status === 'none') return <span className="status-icon" aria-hidden />;
  const Icon = { ok: Check, failed: X, running: LoaderCircle, pending: Clock, cancelled: Ban }[status];
  return (
    <span className={`status-icon ${status}`} title={STATUS_LABEL[status]}>
      <Icon size={14} strokeWidth={2.5} className={status === 'running' ? 'spin' : undefined} aria-hidden />
      <span className="sr-only">{STATUS_LABEL[status]}</span>
    </span>
  );
}

export function SourceTag({ source, why }: { source: SourceClass; why?: string }) {
  const info = SOURCE_INFO[source];
  return (
    <span className={`tag ${source}`} title={why ? `${info.help}\n\n${why}` : info.help}>
      {source === 'inferred' && <CircleDashed size={10} style={{ marginRight: 3 }} aria-hidden />}
      {info.label}
    </span>
  );
}

const CLAWD_RUNS = clawdRuns();

/** Claude's pixel mascot, from the same drawing as the 3D figure in the map. */
export function ClawdIcon({ color = AGENT_COLORS[0]!, className = 'clawd' }: { color?: string; className?: string }) {
  return (
    <svg className={className} viewBox={`0 0 ${CLAWD_COLS * PIXEL.w} ${CLAWD_ROWS * PIXEL.h}`} shapeRendering="crispEdges" aria-hidden>
      {CLAWD_RUNS.map(r => (
        <rect key={`${r.part}${r.row}-${r.col}`} x={r.col * PIXEL.w} y={r.row * PIXEL.h} width={r.len * PIXEL.w} height={PIXEL.h} fill={r.part === 'eye' ? 'var(--clawd-eye)' : color} />
      ))}
    </svg>
  );
}

/** A Codex or Copilot mascot, from the same drawing as its 3D figure in the map. */
export function MascotIcon({ id, color, className = 'mascot-icon' }: { id: MascotId; color?: string; className?: string }) {
  const m = MASCOTS[id];
  const body = m.color ?? color ?? AGENT_COLORS[0]!;
  return (
    <svg className={className} viewBox={`0 0 ${m.grid[0]!.length} ${m.grid.length}`} shapeRendering="crispEdges" aria-hidden>
      {cells(m.grid).map(c => <rect key={`${c.row}-${c.col}`} x={c.col} y={c.row} width={1.02} height={1.02} fill={partColor(c.part, body, m.eye)} />)}
    </svg>
  );
}

/** An agent's mascot as an icon: Claude's crab, Codex's plush cast or Copilot's head; undefined for anything else. */
export function AgentMascot({ mascot, color }: { mascot: MascotId | 'clawd' | undefined; color: string }) {
  if (mascot === 'clawd') return <ClawdIcon color={color} />;
  if (mascot) return <MascotIcon id={mascot} color={color} />;
  return null;
}

/** Which assistant a session belongs to, at a glance: its lead mascot. */
export function AssistantMark({ assistant }: { assistant: string }) {
  const meta = assistantMeta(assistant);
  const mascot = mascotFor(assistant, true, 0);
  return (
    <span className={`assistant-mark ${assistant}`} title={meta.name} role="img" aria-label={meta.name}>
      {mascot ? <AgentMascot mascot={mascot} color={meta.color} /> : <SquareTerminal size={13} color={meta.color} aria-hidden />}
    </span>
  );
}

export function Avatar({ agent, agents, color, busy }: { agent: Pick<AgentState, 'id' | 'label'>; agents: Record<string, AgentState>; color: string; busy?: boolean }) {
  const mascot = mascotOf(agents, agent.id, useAssistant());
  if (mascot) {
    return (
      <span className={`avatar mascot${busy ? ' busy' : ''}`} style={{ color }} title={agent.label} aria-label={agent.label}>
        <AgentMascot mascot={mascot} color={color} />
      </span>
    );
  }
  const letter = agent.id === 'main' ? 'C' : (agent.label.trim()[0] ?? 'S').toUpperCase();
  return (
    <span className={`avatar${busy ? ' busy' : ''}`} style={{ background: color, color }} title={agent.label} aria-label={agent.label}>
      <span style={{ color: '#fff' }}>{letter}</span>
    </span>
  );
}

export const zoneVars = (id: ZoneId): CSSProperties => ({ ['--zt' as string]: `var(--z-${id})`, ['--zb' as string]: `var(--z-${id}-b)` });

export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden>
      <path d="M16 3 29 10.5v11L16 29 3 21.5v-11Z" fill="var(--z-mission-b)" />
      <path d="M16 3 29 10.5 16 18 3 10.5Z" fill="#64c2cc" />
      <path d="M16 18v11L3 21.5v-11Z" fill="#17606a" />
    </svg>
  );
}
