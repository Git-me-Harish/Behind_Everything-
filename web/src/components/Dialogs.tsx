import { Check, Minus, X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import type { SessionState } from '../../../src/core/state.ts';
import { CAPABILITIES, SOURCE_INFO } from '../lib/meta.ts';
import { store, useApp } from '../lib/store.ts';
import { SourceTag } from './ui.tsx';

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => prev?.focus();
  }, []);
  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} onClick={e => e.stopPropagation()}>
        <header><h2>{title}</h2><button className="icon-btn ghost" onClick={onClose} aria-label="Close"><X size={16} /></button></header>
        <div className="body">{children}</div>
      </div>
    </div>
  );
}

export function CoverageDialog({ view }: { view: SessionState }) {
  const show = useApp(s => s.showCoverage);
  const health = useApp(s => s.health);
  const events = useApp(s => s.events);
  if (!show) return null;
  const redacted = events.reduce((n, e) => n + (e.redactions?.length ?? 0), 0);
  const adapter = events.find(e => e.adapter)?.adapter;
  const source = health?.sources[0];
  return (
    <Dialog title="Coverage — what we can and cannot see" onClose={() => store.toggleCoverage(false)}>
      <p style={{ margin: 0 }}>
        Behind Everything shows what the assistant records about its own work. Every signal is labelled:
      </p>
      <div style={{ display: 'grid', gap: 8 }}>
        {(['observed', 'inferred', 'unavailable'] as const).map(s => (
          <div key={s} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}><SourceTag source={s} /><span className="muted">{SOURCE_INFO[s].help}</span></div>
        ))}
      </div>
      <table className="cap-table">
        <tbody>
          {CAPABILITIES.map(c => (
            <tr key={c.signal}>
              <td style={{ width: 22 }}>{c.state === 'yes' ? <Check size={15} color="var(--ok)" aria-label="Captured" /> : c.state === 'partial' ? <Minus size={15} color="var(--warn)" aria-label="Partly captured" /> : <X size={15} color="var(--error)" aria-label="Not captured" />}</td>
              <td>{c.signal}</td>
              <td className="muted">{c.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="kv">
        <dt>Capture</dt><dd>Claude Code transcripts · read-only · no configuration</dd>
        {source && <><dt>Watching</dt><dd className="mono" style={{ fontSize: 11.5 }}>{source.root} ({source.files} files)</dd></>}
        {adapter && <><dt>Adapter</dt><dd className="mono">{adapter.name} v{adapter.version}</dd></>}
        <dt>This session</dt><dd>{view.event_count.toLocaleString()} events · {view.unknown_count} unrecognised · {redacted} values redacted</dd>
      </dl>
    </Dialog>
  );
}

const SHORTCUTS: Array<[string, string]> = [
  ['j / ↓', 'Next activity'], ['k / ↑', 'Previous activity'], ['Esc', 'Close details / clear selection'],
  ['/', 'Search the timeline'], ['f', 'Toggle “failures only”'], ['Space', 'Play / pause replay'],
  ['[ / ]', 'Step back / forward one event'], ['l', 'Go live'], ['s', 'Show / hide the sessions list'], ['?', 'This help'],
];

export function ShortcutsDialog() {
  const show = useApp(s => s.showShortcuts);
  if (!show) return null;
  return (
    <Dialog title="Keyboard shortcuts" onClose={() => store.toggleShortcuts(false)}>
      <table className="cap-table"><tbody>
        {SHORTCUTS.map(([k, d]) => <tr key={k}><td style={{ width: 120 }}>{k.split(' / ').map((x, i) => <span key={x}>{i > 0 && ' / '}<kbd>{x}</kbd></span>)}</td><td>{d}</td></tr>)}
      </tbody></table>
    </Dialog>
  );
}
