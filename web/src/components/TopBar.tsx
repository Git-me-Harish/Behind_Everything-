import { CircleHelp, Menu, Monitor, Moon, ScanEye, Sun } from 'lucide-react';
import { store, useApp } from '../lib/store.ts';
import type { ThemeChoice } from '../lib/theme.ts';
import { BrandMark } from './ui.tsx';

const CONN = {
  connecting: { dot: 'idle', label: 'Connecting' },
  live: { dot: 'ok', label: 'Connected' },
  reconnecting: { dot: 'warn', label: 'Reconnecting' },
  offline: { dot: 'error', label: 'Collector offline' },
} as const;

const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = { system: 'light', light: 'dark', dark: 'system' };

export function TopBar({ theme, setTheme, onMenu }: { theme: ThemeChoice; setTheme: (t: ThemeChoice) => void; onMenu: () => void }) {
  const connection = useApp(s => s.connection);
  const health = useApp(s => s.health);
  const c = CONN[connection];
  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  const source = health?.sources[0];
  return (
    <header className="topbar">
      <button className="icon-btn ghost only-narrow" onClick={onMenu} aria-label="Sessions"><Menu size={16} /></button>
      <div className="brand"><BrandMark /> <span className="brand-name">Behind Everything</span></div>
      <span className="tag hide-narrow" title="Capture: reading Claude Code's own transcripts — no configuration, read-only">Claude Code · log</span>
      <div className="spacer" />
      <span className="conn" role="status" aria-live="polite" aria-label={c.label} title={source ? `Watching ${source.files} transcript file(s) in ${source.root}` : undefined}>
        <span className={`dot ${c.dot}${connection === 'live' ? ' pulse' : ''}`} style={connection === 'live' ? { boxShadow: '0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent)' } : undefined} />
        <span className="hide-narrow">{c.label}</span>
      </span>
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
