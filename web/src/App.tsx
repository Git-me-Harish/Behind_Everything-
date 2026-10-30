import { useEffect, useMemo, useState } from 'react';
import { CoverageDialog, ShortcutsDialog } from './components/Dialogs.tsx';
import { Inspector } from './components/Inspector.tsx';
import { Agents, Attention, SessionHeader } from './components/Overview.tsx';
import { ReplayBar } from './components/ReplayBar.tsx';
import { SessionList } from './components/SessionList.tsx';
import { FilterBar, Timeline } from './components/Timeline.tsx';
import { TopBar } from './components/TopBar.tsx';
import { Workspace } from './components/Workspace.tsx';
import { asOf, buildRows, type Row } from './lib/activities.ts';
import { clock } from './lib/format.ts';
import { store, useApp, useView } from './lib/store.ts';
import { useTheme } from './lib/theme.ts';

export function App() {
  const [theme, setTheme] = useTheme();
  const [menu, setMenu] = useState(false);
  const events = useApp(s => s.events);
  const activities = useApp(s => s.activities);
  const filter = useApp(s => s.filter);
  const cursor = useApp(s => s.cursor);
  const selection = useApp(s => s.selection);
  const connection = useApp(s => s.connection);
  const sessionId = useApp(s => s.sessionId);
  const sessionsLoaded = useApp(s => s.sessionsLoaded);
  const expanded = useApp(s => s.expanded);
  const view = useView();

  useEffect(() => { void store.start(); }, []);

  // While replaying, everything reflects the session as it was at the cursor.
  const limitSeq = cursor === null ? null : cursor === 0 ? 0 : events[cursor - 1]?.seq ?? null;
  const visible = useMemo(() => asOf(activities, limitSeq), [activities, limitSeq]);
  const visibleEvents = useMemo(() => (limitSeq === null ? events : events.slice(0, cursor ?? events.length)), [events, limitSeq, cursor]);
  const rows = useMemo(() => buildRows(visibleEvents, visible, filter), [visibleEvents, visible, filter]);
  const activityCount = useMemo(() => rows.filter(r => r.type === 'activity').length, [rows]);
  const totalCount = useMemo(() => buildRows(visibleEvents, visible, { categories: new Set(), failedOnly: false, text: '' }).filter(r => r.type === 'activity').length, [visibleEvents, visible]);
  const selected = selection?.type === 'activity' ? visible.find(a => a.key === selection.key) : undefined;

  useKeyboard(rows);

  return (
    <div className={`app${selection ? '' : ' no-inspector'}${expanded ? ' map-expanded' : ''}`}>
      <TopBar theme={theme} setTheme={setTheme} onMenu={() => setMenu(!menu)} />
      <SessionList open={menu} onPick={() => setMenu(false)} />
      <main className="main" aria-label="Session overview">
        {connection === 'offline' && <div className="banner" role="alert">Can’t reach the collector. Is <span className="mono">behind-everything</span> still running? Retrying…</div>}
        {cursor !== null && (
          <div className="banner" role="status">
            Replaying — showing the session as it was at <b>{events[cursor - 1] ? clock(events[cursor - 1]!.ts) : 'the start'}</b>.{' '}
            <button className="link" onClick={() => store.goLive()}>Go live</button>
          </div>
        )}
        {!sessionId && sessionsLoaded && (
          <div className="empty" style={{ marginTop: 80 }}>
            <h2>Waiting for your first Claude Code session</h2>
            <p>Open Claude Code in any project and start working — its activity appears here live. Nothing to configure.</p>
          </div>
        )}
        {sessionId && (
          <>
            <SessionHeader view={view} />
            <Agents view={view} />
            <Workspace view={view} />
            <Attention view={view} />
            <section className="timeline-card" aria-label="Timeline">
              <FilterBar shown={activityCount} total={totalCount} />
              <Timeline rows={rows} view={view} limitSeq={limitSeq} />
            </section>
          </>
        )}
      </main>
      <Inspector view={view} activity={selected} />
      <ReplayBar />
      <CoverageDialog view={view} />
      <ShortcutsDialog />
    </div>
  );
}

function useKeyboard(rows: Row[]) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inputType = target instanceof HTMLInputElement ? target.type : '';
      // Text fields swallow shortcuts; sliders and buttons only keep the keys they use themselves.
      const typing = target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || (target.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(inputType));
      if (inputType === 'range' && e.key.startsWith('Arrow')) return;
      if (e.key === 'Escape') {
        if (typing) return target.blur();
        if (store.state.showCoverage || store.state.showShortcuts) { store.toggleCoverage(false); store.toggleShortcuts(false); return; }
        if (store.state.selection) return store.clearSelection();
        if (store.state.expanded) return store.toggleExpanded(false);
        return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      const acts = rows.filter(r => r.type === 'activity');
      const sel = store.state.selection;
      const i = sel?.type === 'activity' ? acts.findIndex(r => r.key === sel.key) : -1;
      const move = (d: number) => {
        const next = acts[Math.max(0, Math.min(acts.length - 1, i < 0 ? (d > 0 ? 0 : acts.length - 1) : i + d))];
        if (next) store.select({ type: 'activity', key: next.key });
      };
      switch (e.key) {
        case 'j': case 'ArrowDown': e.preventDefault(); move(1); break;
        case 'k': case 'ArrowUp': e.preventDefault(); move(-1); break;
        case '/': e.preventDefault(); document.getElementById('timeline-search')?.focus(); break;
        case 'f': store.setFilter({ failedOnly: !store.state.filter.failedOnly }); break;
        case ' ': if (target.tagName !== 'BUTTON') { e.preventDefault(); store.togglePlay(); } break;
        case '[': store.step(-1); break;
        case ']': store.step(1); break;
        case 'l': store.goLive(); break;
        case '?': store.toggleShortcuts(true); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows]);
}
