import { GitBranch, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ago, compact, isLive, project } from '../lib/format.ts';
import { store, useApp, useNow } from '../lib/store.ts';

export function SessionList({ open, onPick }: { open: boolean; onPick: () => void }) {
  const sessions = useApp(s => s.sessions);
  const loaded = useApp(s => s.sessionsLoaded);
  const current = useApp(s => s.sessionId);
  const health = useApp(s => s.health);
  const now = useNow(5000);
  const [q, setQ] = useState('');

  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return sessions.filter(s => {
      const hay = `${s.title ?? ''} ${s.cwd ?? ''} ${s.git_branch ?? ''}`.toLowerCase();
      return words.every(w => hay.includes(w));
    });
  }, [sessions, q]);

  return (
    <nav id="sessions" className={`sidebar${open ? ' open' : ''}`} aria-label="Sessions" inert={!open}>
      <div className="sidebar-head">
        <div className="section-title">Sessions</div>
        <label className="search">
          <Search size={14} aria-hidden />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter sessions" aria-label="Filter sessions" />
        </label>
      </div>
      <div className="session-list">
        {loaded && sessions.length === 0 && (
          <div className="empty">
            <h2>No sessions yet</h2>
            <p>Start Claude Code in any project. Its sessions appear here automatically.</p>
          </div>
        )}
        {shown.map(s => {
          const live = isLive(s.last_ts, now);
          return (
            <button
              key={s.id}
              className="session"
              aria-current={s.id === current}
              onClick={() => { void store.selectSession(s.id); onPick(); }}
            >
              <span className={`dot ${live ? 'ok pulse' : ''}`} title={live ? 'Active in the last 90 seconds' : 'Idle'} />
              <span className="title truncate">{s.title ?? project(s.cwd)}</span>
              <span className="when">{ago(s.last_ts, now)}</span>
              <span className="meta">
                <span className="truncate">{project(s.cwd)}</span>
                {s.git_branch && <span className="truncate" style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}><GitBranch size={11} />{s.git_branch}</span>}
                <span style={{ marginLeft: 'auto' }}>{compact(s.event_count)} events</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="sidebar-foot">
        <span>{sessions.length} session{sessions.length === 1 ? '' : 's'} · local only</span>
        {health && <span className="truncate" title={health.sources[0]?.root}>Watching {health.sources[0]?.files ?? 0} transcript files</span>}
      </div>
    </nav>
  );
}
