import { Check, Download, Minus, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ShareBundle, ShareOptions } from '../../../src/core/share.ts';
import type { SessionState } from '../../../src/core/state.ts';
import { assistantMeta, SOURCE_INFO } from '../lib/meta.ts';
import { store, useApp } from '../lib/store.ts';
import type { HookHealth } from '../lib/types.ts';
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
  const assistant = useApp(s => s.sessions.find(x => x.id === s.sessionId)?.assistant ?? 'claude-code');
  if (!show) return null;
  const redacted = events.reduce((n, e) => n + (e.redactions?.length ?? 0), 0);
  const adapter = events.find(e => e.adapter)?.adapter;
  const meta = assistantMeta(assistant);
  const source = health?.sources.find(x => x.assistant === assistant);
  const hooks = source?.hooks;
  return (
    <Dialog title="Coverage: what we can and cannot see" onClose={() => store.toggleCoverage(false)}>
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
          {meta.capabilities.map(c => (c.hook && hooks?.installed ? { ...c, state: 'yes' as const, note: 'Live, through the hook bridge' } : c)).map(c => (
            <tr key={c.signal}>
              <td style={{ width: 22 }}>{c.state === 'yes' ? <Check size={15} color="var(--ok)" aria-label="Captured" /> : c.state === 'partial' ? <Minus size={15} color="var(--warn)" aria-label="Partly captured" /> : <X size={15} color="var(--error)" aria-label="Not captured" />}</td>
              <td>{c.signal}</td>
              <td className="muted">{c.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="kv">
        <dt>Capture</dt><dd>{meta.logs} · read-only · no configuration</dd>
        {source && <><dt>Watching</dt><dd className="mono" style={{ fontSize: 11.5 }}>{source.root} ({source.files} files)</dd></>}
        {hooks && <><dt>Hook bridge</dt><dd>{hookLine(hooks)}</dd></>}
        {adapter && <><dt>Adapter</dt><dd className="mono">{adapter.name} v{adapter.version}</dd></>}
        <dt>This session</dt><dd>{view.event_count.toLocaleString()} events · {view.unknown_count} unrecognised · {redacted} values redacted</dd>
      </dl>
    </Dialog>
  );
}

/** Installed or not, and whether it is actually delivering: the honest state, with the next step when there is one. */
function hookLine(h: HookHealth): string {
  if (!h.installed) return 'Not installed. Run `pnpm hooks install` to see approval prompts while they wait';
  if (!h.port_matches) return 'Installed for another port. Run `pnpm hooks install` again';
  if (!h.events) return 'Installed · no prompts since Behind Everything started';
  return `Installed · ${h.events} prompt${h.events === 1 ? '' : 's'} received, ${h.matched} shown${h.unmatched ? `, ${h.unmatched} not matched to a call` : ''}`;
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

/** "report-fix-date-parser.behind-everything.json": readable, safe on every file system. */
const fileName = (title?: string) => `${(title ?? 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'session'}.behind-everything.json`;

const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function ShareDialog() {
  const show = useApp(s => s.showShare);
  const session = useApp(s => s.sessions.find(x => x.id === s.sessionId));
  const [options, setOptions] = useState<ShareOptions>({ prompts: true, outputs: true, diffs: true });
  const [bundle, setBundle] = useState<{ json: string; b: ShareBundle } | { error: string } | undefined>();
  useEffect(() => {
    if (!show) return;
    let live = true;
    setBundle(undefined);
    store.exportSession(options).then(b => live && setBundle({ json: JSON.stringify(b), b }), err => live && setBundle({ error: String(err) }));
    return () => { live = false; };
  }, [show, options, session?.id]);
  if (!show || !session) return null;
  const download = () => {
    if (!bundle || 'error' in bundle) return;
    const url = URL.createObjectURL(new Blob([bundle.json], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: fileName(session.title) });
    a.click();
    URL.revokeObjectURL(url);
    store.toggleShare(false);
    store.notify('ok', `Saved ${a.download}. Anyone can open it in Behind Everything with "Open a shared session".`);
  };
  const toggle = (k: keyof ShareOptions) => setOptions(o => ({ ...o, [k]: !o[k] }));
  const stats = bundle && !('error' in bundle) ? bundle.b.stats : undefined;
  return (
    <Dialog title="Share this session" onClose={() => store.toggleShare(false)}>
      <p style={{ margin: 0 }}>Save the session as a file that anyone can open in their own Behind Everything, with the 3D map, timeline and replay.</p>
      <fieldset className="share-options">
        <legend>Include</legend>
        <label><input type="checkbox" checked={options.prompts} onChange={() => toggle('prompts')} /> Prompts and assistant messages</label>
        <label><input type="checkbox" checked={options.outputs} onChange={() => toggle('outputs')} /> Command and tool output</label>
        <label><input type="checkbox" checked={options.diffs} onChange={() => toggle('diffs')} /> File diffs</label>
      </fieldset>
      <section className="share-preview" aria-live="polite" aria-label="What the file contains">
        {!bundle && <p className="muted">Preparing the file…</p>}
        {bundle && 'error' in bundle && <p className="error-text">Could not prepare the file: {bundle.error}</p>}
        {stats && bundle && !('error' in bundle) && (
          <ul>
            <li><Check size={14} aria-hidden /> {stats.events.toLocaleString()} events, {kb(bundle.json.length)}</li>
            <li><Check size={14} aria-hidden /> {stats.redacted_at_capture + stats.redacted} secret{stats.redacted_at_capture + stats.redacted === 1 ? '' : 's'} redacted{stats.redacted ? ` (${stats.redacted} caught just now)` : ''}</li>
            <li><Check size={14} aria-hidden /> {stats.paths_shortened} path{stats.paths_shortened === 1 ? '' : 's'} shortened: your home folder becomes ~ and the project folder only its name</li>
            {(stats.left_out.prompts || stats.left_out.outputs || stats.left_out.diffs) ? (
              <li><Minus size={14} aria-hidden /> Left out: {[stats.left_out.prompts && `${stats.left_out.prompts} prompts and messages`, stats.left_out.outputs && `${stats.left_out.outputs} outputs`, stats.left_out.diffs && `${stats.left_out.diffs} diffs`].filter(Boolean).join(', ')}</li>
            ) : null}
            <li><X size={14} aria-hidden /> Never included: the model's reasoning, raw log records, and where files live on your machine</li>
          </ul>
        )}
      </section>
      <div className="dialog-actions">
        <button className="btn" onClick={() => store.toggleShare(false)}>Cancel</button>
        <button className="btn primary" onClick={download} disabled={!stats}><Download size={15} aria-hidden /> Download {fileName(session.title)}</button>
      </div>
    </Dialog>
  );
}
