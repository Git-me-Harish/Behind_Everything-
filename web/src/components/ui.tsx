import { Ban, Check, CircleDashed, Clock, LoaderCircle, X } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { SourceClass } from '../../../src/core/schema.ts';
import type { AgentState, ZoneId } from '../../../src/core/state.ts';
import type { Activity } from '../lib/activities.ts';
import { AGENT_COLORS, SOURCE_INFO } from '../lib/meta.ts';
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

export function Avatar({ agent, color, busy }: { agent: Pick<AgentState, 'id' | 'label'>; color: string; busy?: boolean }) {
  const assistant = useAssistant();
  if (agent.id === 'main' && assistant === 'claude-code') {
    return (
      <span className={`avatar mascot${busy ? ' busy' : ''}`} style={{ color }} title={agent.label} aria-label={agent.label}>
        <ClawdIcon color={color} />
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
