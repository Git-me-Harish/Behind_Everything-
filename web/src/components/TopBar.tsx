import { BellOff, BellRing, CircleHelp, Menu, Monitor, Moon, PanelLeftClose, PanelLeftOpen, ScanEye, Sun } from 'lucide-react';
import { store, useApp } from '../lib/store.ts';
import type { ThemeChoice } from '../lib/theme.ts';
import { useNotifyPreference, type NotifyState } from '../lib/alerts.ts';
import { assistantMeta } from '../lib/meta.ts';
import { BrandMark } from './ui.tsx';

const CONN = {
  connecting: { dot: 'idle', label: 'Connecting' },
  live: { dot: 'ok', label: 'Connected' },
  reconnecting: { dot: 'warn', label: 'Reconnecting' },
  offline: { dot: 'error', label: 'Collector offline' },
} as const;

const NOTIFY_TITLE: Record<NotifyState, string> = {
  on: 'Desktop notifications on: you hear about approvals and questions waiting for you in any session',
  off: 'Notify me when an agent is waiting for me (approvals, questions)',
  blocked: 'Notifications are blocked for this page in your browser settings',
  unsupported: 'This browser cannot show notifications',
};

const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = { system: 'light', light: 'dark', dark: 'system' };

export function TopBar({ theme, setTheme, sessionsOpen, narrow }: { theme: ThemeChoice; setTheme: (t: ThemeChoice) => void; sessionsOpen: boolean; narrow: boolean }) {
  const connection = useApp(s => s.connection);
  const health = useApp(s => s.health);
  const c = CONN[connection];
  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  const session = useApp(s => s.sessions.find(x => x.id === s.sessionId));
  const meta = assistantMeta(session?.assistant);
  const [notify, toggleNotify] = useNotifyPreference();
  const source = health?.sources.find(x => x.assistant === (session?.assistant ?? 'claude-code'));
  return (
    <header className="topbar">
      <button
        className="icon-btn ghost"
        onClick={() => store.toggleSidebar()}
        aria-label={sessionsOpen ? 'Hide sessions' : 'Show sessions'}
        aria-expanded={sessionsOpen}
        aria-controls="sessions"
        title={`${sessionsOpen ? 'Hide' : 'Show'} sessions (s)`}
      >
        {narrow ? <Menu size={16} /> : sessionsOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
      </button>
      <div className="brand"><BrandMark /> <span className="brand-name">Behind Everything</span></div>
      <span className="tag hide-narrow" title={`Capture: reading ${meta.logs} — no configuration, read-only${source?.hooks?.installed ? '; approval prompts arrive live through the hook bridge' : ''}`}>
        {meta.name} · log{source?.hooks?.installed ? ' + hook' : ''}
      </span>
      <div className="spacer" />
      <span className="conn" role="status" aria-live="polite" aria-label={c.label} title={source ? `Watching ${source.files} transcript file(s) in ${source.root}` : undefined}>
        <span className={`dot ${c.dot}${connection === 'live' ? ' pulse' : ''}`} style={connection === 'live' ? { boxShadow: '0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent)' } : undefined} />
        <span className="hide-narrow">{c.label}</span>
      </span>
      <button
        className="icon-btn"
        onClick={toggleNotify}
        disabled={notify === 'unsupported' || notify === 'blocked'}
        aria-pressed={notify === 'on'}
        aria-label="Notify me when an agent is waiting for me"
        title={NOTIFY_TITLE[notify]}
      >
        {notify === 'on' ? <BellRing size={15} /> : <BellOff size={15} />}
      </button>
      <button className="icon-btn" onClick={() => store.toggleCoverage(true)} title="What Behind Everything can and cannot see" aria-label="Coverage">
        <ScanEye size={15} /> <span className="hide-narrow">Coverage</span>
      </button>
      <button className="icon-btn" onClick={() => setTheme(NEXT_THEME[theme])} title={`Theme: ${theme}`} aria-label={`Theme: ${theme}. Switch theme`}>
        <ThemeIcon size={15} />
      </button>
      <button className="icon-btn" onClick={() => store.toggleShortcuts(true)} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
        <CircleHelp size={15} />
      </button>
    </header>
  );
}
