import { FolderOpen, Sparkles } from 'lucide-react';
import { assistantMeta } from '../lib/meta.ts';
import { store, useApp } from '../lib/store.ts';
import { mascotFor } from '../world/mascots.ts';
import { AgentMascot } from './ui.tsx';

const ENV: Record<string, string> = { 'claude-code': 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', 'copilot-cli': 'COPILOT_HOME' };

/** First run: which assistants are set up here, how to get a first session, and a demo to explore meanwhile. */
export function Welcome({ onOpenFile }: { onOpenFile: () => void }) {
  const health = useApp(s => s.health);
  return (
    <section className="welcome" aria-labelledby="welcome-title">
      <h2 id="welcome-title">Welcome to Behind Everything</h2>
      <p className="lede">See what your AI coding agent is doing, as it does it. Start a session and it appears here within a moment.</p>
      <ul className="welcome-sources" aria-label="Assistants on this machine">
        {(health?.sources ?? []).map(s => {
          const meta = assistantMeta(s.assistant);
          const found = s.exists ?? s.files > 0;
          return (
            <li key={s.assistant} className={found ? 'found' : 'missing'}>
              <span className="mark" style={{ color: meta.color }}><AgentMascot mascot={mascotFor(s.assistant, true, 0)} color={meta.color} /></span>
              <span>
                <b>{meta.name}</b>
                <small>{found ? (s.files ? `Ready · ${s.files} recent session${s.files === 1 ? '' : 's'}` : 'Ready · no sessions yet') : `Not found here${ENV[s.assistant] ? ` (set ${ENV[s.assistant]} if it lives elsewhere)` : ''}`}</small>
              </span>
            </li>
          );
        })}
      </ul>
      <ol className="welcome-steps">
        <li><b>Open a project</b> in a terminal or in VS Code.</li>
        <li><b>Start your agent</b> (<code>claude</code>, <code>codex</code> or <code>copilot</code>) and ask it to do something.</li>
        <li><b>Watch it here.</b> Optional: <code>npx behind-everything hooks install</code> shows Claude Code and Codex approval prompts while they wait.</li>
      </ol>
      <div className="welcome-actions">
        <button className="btn primary" onClick={() => void store.openDemo()}><Sparkles size={15} aria-hidden /> Explore the demo sessions</button>
        <button className="btn" onClick={onOpenFile}><FolderOpen size={15} aria-hidden /> Open a shared session</button>
      </div>
      <p className="muted small">Something not showing up? Run <code>npx behind-everything doctor</code> for a check of your setup.</p>
    </section>
  );
}
