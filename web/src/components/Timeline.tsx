import { ArrowDown, FileCode2, Search, ShieldCheck, ShieldX, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SessionState } from '../../../src/core/state.ts';
import { isFiltering, type Activity, type Row } from '../lib/activities.ts';
import { basename, clock, duration } from '../lib/format.ts';
import { CATEGORIES, KIND, ZONE } from '../lib/meta.ts';
import { store, useApp, useNow } from '../lib/store.ts';
import { StatusIcon, activityStatus, agentColor } from './ui.tsx';

const ROW_H = 36;
const TURN_H = 44;
const OVERSCAN = 12;
const MINOR = new Set(['assistant.reasoning', 'session.meta', 'session.compaction']);

export function FilterBar({ shown, total }: { shown: number; total: number }) {
  const filter = useApp(s => s.filter);
  const zone = useApp(s => (s.selection?.type === 'zone' ? s.selection.id : undefined));
  const agentLabel = useApp(s => (s.filter.agent ? s.live.agents[s.filter.agent]?.label ?? s.filter.agent : undefined));
  const toggle = (id: (typeof CATEGORIES)[number]['id']) => {
    const next = new Set(filter.categories);
    if (next.has(id)) next.delete(id); else next.add(id);
    store.setFilter({ categories: next });
  };
  return (
    <div className="filters" role="toolbar" aria-label="Timeline filters">
      <label className="search">
        <Search size={13} aria-hidden />
        <input
          id="timeline-search"
          value={filter.text}
          onChange={e => store.setFilter({ text: e.target.value })}
          placeholder="Search activity"
          aria-label="Search the timeline"
        />
        {filter.text && <button className="icon-btn ghost" style={{ height: 20, minWidth: 20, padding: 0 }} onClick={() => store.setFilter({ text: '' })} aria-label="Clear search"><X size={12} /></button>}
      </label>
      {CATEGORIES.map(c => (
        <button key={c.id} className="chip" aria-pressed={filter.categories.has(c.id)} onClick={() => toggle(c.id)}>{c.label}</button>
      ))}
      <button className="chip" aria-pressed={filter.failedOnly} onClick={() => store.setFilter({ failedOnly: !filter.failedOnly })}>Failures only</button>
      {zone && <button className="chip removable" onClick={() => { store.select(null); store.setFilter({ categories: new Set(), failedOnly: false }); }}>Zone: {ZONE[zone].name} <X size={12} /></button>}
      {agentLabel && <button className="chip removable" onClick={() => store.setFilter({ agent: undefined })}>Agent: {agentLabel} <X size={12} /></button>}
      {filter.file && <button className="chip removable" onClick={() => store.setFilter({ file: undefined })}>File: {basename(filter.file)} <X size={12} /></button>}
      <span className="grow" />
      <span className="muted" style={{ fontSize: 12 }}>{isFiltering(filter) ? `${shown} of ${total}` : `${total}`} activities</span>
      {isFiltering(filter) && (
        <button className="link" style={{ fontSize: 12 }} onClick={() => { store.setFilter({ categories: new Set(), failedOnly: false, text: '', agent: undefined, file: undefined }); if (zone) store.select(null); }}>
          Clear
        </button>
      )}
    </div>
  );
}

export function Timeline({ rows, view, limitSeq }: { rows: Row[]; view: SessionState; limitSeq: number | null }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [follow, setFollow] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const selectedKey = useApp(s => (s.selection?.type === 'activity' ? s.selection.key : undefined));
  const loading = useApp(s => s.loading);
  const error = useApp(s => s.error);
  const now = useNow(1000);

  const offsets = useMemo(() => {
    const o = new Array<number>(rows.length + 1);
    o[0] = 0;
    for (let i = 0; i < rows.length; i++) o[i + 1] = o[i]! + (rows[i]!.type === 'turn' ? TURN_H : ROW_H);
    return o;
  }, [rows]);
  const total = offsets[rows.length] ?? 0;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Follow the live edge; otherwise count what arrived below.
  const prevLen = useRef(rows.length);
  useLayoutEffect(() => {
    const el = scroller.current;
    const added = rows.length - prevLen.current;
    prevLen.current = rows.length;
    if (!el) return;
    if (follow) el.scrollTop = el.scrollHeight;
    else if (added > 0) setUnseen(u => u + added);
  }, [rows, follow]);

  // Bring the selected row into view when it is chosen elsewhere (attention, evidence links, keyboard).
  useEffect(() => {
    const el = scroller.current;
    if (!el || !selectedKey) return;
    const i = rows.findIndex(r => r.key === selectedKey);
    if (i < 0) return;
    const top = offsets[i]!;
    if (top < el.scrollTop + 8 || top + ROW_H > el.scrollTop + el.clientHeight - 8) {
      el.scrollTop = top - el.clientHeight / 3;
      setFollow(false);
    }
  }, [selectedKey, rows, offsets]);

  const onScroll = () => {
    const el = scroller.current!;
    setScrollTop(el.scrollTop);
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setFollow(atBottom);
    if (atBottom) setUnseen(0);
  };

  // Binary search for the first visible row.
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (offsets[mid + 1]! <= scrollTop) lo = mid + 1; else hi = mid; }
  const first = Math.max(0, lo - OVERSCAN);
  let last = lo;
  while (last < rows.length && offsets[last]! < scrollTop + height) last++;
  last = Math.min(rows.length, last + OVERSCAN);

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div className="timeline" ref={scroller} onScroll={onScroll} role="listbox" aria-label="Session timeline" aria-activedescendant={selectedKey ? rowId(selectedKey) : undefined}>
        {loading && <div className="empty"><h2>Loading session…</h2></div>}
        {error && <div className="empty"><h2>Something went wrong</h2><p>{error}</p></div>}
        {!loading && !error && rows.length === 0 && (
          <div className="empty"><h2>Nothing to show</h2><p>No activity matches the current filters.</p></div>
        )}
        <div className="timeline-inner" style={{ height: total }}>
          {rows.slice(first, last).map((r, j) => {
            const i = first + j;
            const top = offsets[i]!;
            return r.type === 'turn'
              ? <TurnRow key={r.key} row={r} top={top} />
              : <ActivityRow key={r.key} a={r.activity} top={top} selected={r.key === selectedKey} view={view} now={now} limitSeq={limitSeq} />;
          })}
        </div>
      </div>
      {unseen > 0 && (
        <button className="icon-btn new-events" style={{ boxShadow: 'var(--shadow-lift)' }} onClick={() => { setFollow(true); setUnseen(0); }}>
          <ArrowDown size={14} /> {unseen} new
        </button>
      )}
    </div>
  );
}

const rowId = (key: string) => `row-${key.replace(/[^\w-]/g, '_')}`;

function TurnRow({ row, top }: { row: Extract<Row, { type: 'turn' }>; top: number }) {
  return (
    <div className="turn-row" style={{ top, height: TURN_H }}>
      <span className="turn-no">Turn {row.index}</span>
      <span className="prompt truncate" title={row.prompt?.summary}>{row.prompt?.summary ?? 'Activity before the first prompt'}</span>
      <span className="muted mono" style={{ marginLeft: 'auto', fontSize: 11.5, whiteSpace: 'nowrap' }}>
        {clock(row.ts)}{row.end ? ` → ${clock(row.end.ts)} · ${duration(Date.parse(row.end.ts) - Date.parse(row.ts))}` : ''}
      </span>
    </div>
  );
}

function ActivityRow({ a, top, selected, view, now, limitSeq }: { a: Activity; top: number; selected: boolean; view: SessionState; now: number; limitSeq: number | null }) {
  const meta = KIND[a.kind];
  const Icon = meta.icon;
  const status = activityStatus(a);
  const running = status === 'running' || status === 'pending';
  const sub = a.agent_id !== 'main' ? view.agents[a.agent_id] : undefined;
  const decision = a.related.find(r => r.kind === 'permission.decision');
  const added = Number(a.result?.payload?.added ?? 0);
  const removed = Number(a.result?.payload?.removed ?? 0);
  const elapsed = running && limitSeq === null ? now - Date.parse(a.ts) : undefined;
  return (
    <button
      id={rowId(a.key)}
      className={`row status-${running ? 'running' : status === 'failed' ? 'failed' : a.status ?? 'none'}${MINOR.has(a.kind) ? ' minor' : ''}`}
      title={a.inferred_failure ? `Inferred failure: exit code 0, but the output says “${a.inferred_failure}” (likely piped)` : undefined}
      style={{ top }}
      role="option"
      aria-selected={selected}
      onClick={() => store.select(selected ? null : { type: 'activity', key: a.key })}
    >
      <span className="time">{clock(a.ts)}</span>
      <StatusIcon status={status} />
      <Icon size={15} aria-hidden color="var(--text-2)" />
      <span className="kind">{meta.label}</span>
      <span className="summary truncate">
        {sub && <span className="sub" style={{ background: agentColor(view.agents, a.agent_id) }}>{sub.label.slice(0, 18)}</span>}
        {a.summary}
      </span>
      <span className="end">
        {decision && (decision.status === 'failed'
          ? <ShieldX size={14} color="var(--error)" aria-label="Blocked" />
          : <ShieldCheck size={14} color="var(--ok)" aria-label="Approved by you" />)}
        {a.related.some(r => r.kind === 'file.edit') && <FileCode2 size={14} aria-label="Changed files" />}
        {a.kind === 'file.edit' && (added || removed) ? <span><span className="plus">+{added}</span> <span className="minus">−{removed}</span></span> : null}
        {a.result?.exit_code ? <span style={{ color: 'var(--error)' }}>exit {a.result.exit_code}</span> : null}
        {a.inferred_failure && <span className="tag inferred" style={{ color: 'var(--error)' }}>~ failed</span>}
        {elapsed !== undefined ? <span style={{ color: 'var(--active)' }}>{duration(elapsed)}</span> : a.duration_ms && a.duration_ms >= 1000 ? <span>{duration(a.duration_ms)}</span> : null}
      </span>
    </button>
  );
}
