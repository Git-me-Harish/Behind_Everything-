import { FolderOpen, Hand, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { compact, isLive, project, shortAgo } from '../lib/format.ts';
import { assistantMeta, isShared } from '../lib/meta.ts';
import { store, useApp, useNow } from '../lib/store.ts';
import type { SessionRow } from '../lib/types.ts';
import { AssistantMark } from './ui.tsx';

/** Branches that say nothing: shown only when a session is on some other branch. */
const DEFAULT_BRANCHES = new Set(['main', 'master', 'trunk', 'develop', 'HEAD']);

const DAY = 86_400_000;

/** Today, Yesterday, This week, Earlier: by the session's last activity, in local time. */
function group(ts: string, now: number): string {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const t = Date.parse(ts);
  if (t >= startOfToday) return 'Today';
  if (t >= startOfToday - DAY) return 'Yesterday';
  if (t >= startOfToday - 6 * DAY) return 'This week';
  return 'Earlier';
}

export function SessionList({ open, onPick, onOpenFile }: { open: boolean; onPick: () => void; onOpenFile: () => void }) {
  const sessions = useApp(s => s.sessions);
  const loaded = useApp(s => s.sessionsLoaded);
  const current = useApp(s => s.sessionId);
  const health = useApp(s => s.health);
  const now = useNow(5000);
  const [q, setQ] = useState('');

  const groups = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const out: Array<{ label: string; sessions: SessionRow[] }> = [];
    for (const s of sessions) {
      const hay = `${s.title ?? ''} ${s.cwd ?? ''} ${s.git_branch ?? ''} ${assistantMeta(s.assistant).name}`.toLowerCase();
      if (!words.every(w => hay.includes(w))) continue;
      const label = group(s.last_ts, now);
      if (out.at(-1)?.label === label) out.at(-1)!.sessions.push(s);
      else out.push({ label, sessions: [s] });
    }
    return out;
  }, [sessions, q, now]);

  return (
    <nav id="sessions" className={`sidebar${open ? ' open' : ''}`} aria-label="Sessions" inert={!open}>
      <div className="sidebar-head">
        <div className="section-title">Sessions</div>
        <label className="search">
          <Search size={14} aria-hidden />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter sessions" aria-label="Filter sessions" />
        </label>
        <button className="link open-shared" onClick={onOpenFile}><FolderOpen size={13} aria-hidden /> Open a shared session</button>
      </div>
      <div className="session-list">
        {loaded && sessions.length === 0 && (
          <div className="empty">
            <h2>No sessions yet</h2>
            <p>They appear here as soon as you start one.</p>
          </div>
        )}
        {groups.map(g => (
          <section key={g.label} className="session-group" aria-label={g.label}>
            <h3 className="session-group-label">{g.label}</h3>
            {g.sessions.map(s => <SessionItem key={s.id} s={s} current={s.id === current} now={now} onPick={onPick} />)}
          </section>
        ))}
      </div>
      <div className="sidebar-foot">
        <span>{sessions.length} session{sessions.length === 1 ? '' : 's'} · local only</span>
        {health && (
          <span className="watching" title={health.sources.map(x => `${assistantMeta(x.assistant).name}: ${x.files} log file${x.files === 1 ? '' : 's'} in ${x.root}`).join('\n')}>
            Watching
            {health.sources.map(x => (
              <span key={x.assistant} className="source" role="img" aria-label={`${assistantMeta(x.assistant).name}: ${x.files} log file${x.files === 1 ? '' : 's'}`}>
                <span aria-hidden><AssistantMark assistant={x.assistant} /></span>{compact(x.files)}
              </span>
            ))}
          </span>
        )}
      </div>
    </nav>
  );
}

function SessionItem({ s, current, now, onPick }: { s: SessionRow; current: boolean; now: number; onPick: () => void }) {
  const live = !isShared(s.id) && isLive(s.last_ts, now);
  const waiting = s.waiting ?? [];
  const branch = s.git_branch && !DEFAULT_BRANCHES.has(s.git_branch) ? s.git_branch : undefined;
  const state = waiting.length ? 'waiting' : live ? 'live' : 'idle';
  // Everything the row leaves out, one hover away.
  const details = [s.title ?? project(s.cwd), `${assistantMeta(s.assistant).name} · ${s.cwd ?? ''}`, s.git_branch && `Branch ${s.git_branch}`, `${compact(s.event_count)} events`, ...waiting.map(w => w.summary)].filter(Boolean).join('\n');
  return (
    <button className={`session ${state}`} aria-current={current} title={details} onClick={() => { void store.selectSession(s.id); onPick(); }}>
      <span className="mark">
        <AssistantMark assistant={s.assistant} />
        {state !== 'idle' && <span className={`badge ${state}`} aria-label={state === 'waiting' ? 'Waiting for you' : 'Live'} />}
      </span>
      <span className="title truncate">{s.title ?? project(s.cwd)}</span>
      <span className="when">{live ? 'Live' : shortAgo(s.last_ts, now)}</span>
      {waiting.length
        ? <span className="sub"><span className="waiting-pill"><Hand size={11} aria-hidden />Waiting for you{waiting.length > 1 ? ` · ${waiting.length}` : ''}</span></span>
        : <span className="sub truncate">{isShared(s.id) && <span className="shared-mark">Shared · </span>}{project(s.cwd)}{branch && <span className="branch"> · {branch}</span>}</span>}
    </button>
  );
}
