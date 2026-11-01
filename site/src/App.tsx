import { Check, ChevronDown, Copy, ExternalLink, Lock, Menu, Minus, Monitor, Moon, Plug, Sun, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { AgentMascot, BrandMark } from '../../web/src/components/ui.tsx';
import { useTheme, type ThemeChoice } from '../../web/src/lib/theme.ts';
import { mascotFor } from '../../web/src/world/mascots.ts';
import { ASSISTANTS, CLOSING, FAQ, FEATURES, HERO, HOOKS, INSTALL, MATRIX, NAV, PRIVACY, REPO, STEPS, type Feature, type Support } from './content.ts';

/** GitHub's mark, for links to the repository (lucide no longer ships brand icons). */
function GithubMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

const HeroWorld = lazy(() => import('./HeroWorld.tsx'));
const base = import.meta.env.BASE_URL;
const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = { system: 'light', light: 'dark', dark: 'system' };
const ASSISTANT_COLOR: Record<string, string> = { 'claude-code': '#d97757', codex: '#2f8ee6', 'copilot-cli': '#8b5cf6' };

export function App() {
  const [theme, setTheme] = useTheme();
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <Nav theme={theme} setTheme={setTheme} />
      <main id="main">
        <Hero />
        <AssistantStrip />
        <HowItWorks />
        <Features />
        <HookCallout />
        <Privacy />
        <Matrix />
        <Faq />
        <Closing />
      </main>
      <Footer />
    </>
  );
}

function Nav({ theme, setTheme }: { theme: ThemeChoice; setTheme: (t: ThemeChoice) => void }) {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open]);
  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  return (
    <header className={`nav${scrolled ? ' scrolled' : ''}${open ? ' open' : ''}`}>
      <div className="wrap nav-inner">
        <a className="brand" href="#top" aria-label="Behind Everything, back to top"><BrandMark /><span>Behind Everything</span></a>
        <nav id="site-nav" className="nav-links" aria-label="Main">
          {NAV.map(n => <a key={n.href} href={n.href} onClick={() => setOpen(false)}>{n.label}</a>)}
        </nav>
        <div className="nav-actions">
          <button className="icon" onClick={() => setTheme(NEXT_THEME[theme])} aria-label={`Theme: ${theme}. Switch theme`} title={`Theme: ${theme}`}><ThemeIcon size={17} /></button>
          <a className="icon hide-sm" href={REPO} aria-label="Behind Everything on GitHub" title="GitHub"><GithubMark /></a>
          <a className="btn small primary hide-sm" href="#get-started">Get started</a>
          <button className="icon menu" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="site-nav" aria-label={open ? 'Close menu' : 'Open menu'}>{open ? <X size={18} /> : <Menu size={18} />}</button>
        </div>
      </div>
    </header>
  );
}

function CopyCommand({ command, size = 'large' }: { command: string; size?: 'large' | 'small' }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked: the command stays selectable */ }
  };
  return (
    <div className={`cmd ${size}`}>
      <span className="prompt" aria-hidden>$</span>
      <code>{command}</code>
      <button onClick={copy} aria-label={`Copy "${command}"`} title="Copy">{copied ? <Check size={16} /> : <Copy size={16} />}</button>
      <span className="sr-only" aria-live="polite">{copied ? 'Copied to clipboard' : ''}</span>
    </div>
  );
}

function Hero() {
  const [state, setState] = useState<'poster' | 'live' | 'failed'>('poster');
  const [load, setLoad] = useState(false);
  // Let the page paint first; the 3D world (three.js) follows a moment later.
  useEffect(() => {
    const go = () => setLoad(true);
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(go, { timeout: 1200 });
    else window.setTimeout(go, 300);
  }, []);
  return (
    <section className="hero" id="top">
      <div className="hero-bg" aria-hidden />
      <div className="wrap hero-copy">
        <p className="eyebrow">{HERO.eyebrow}</p>
        <h1>{HERO.title}</h1>
        <p className="lede">{HERO.lede}</p>
        <div className="hero-cta" id="get-started">
          <CopyCommand command={INSTALL} />
          <a className="btn ghost" href={REPO}><GithubMark /> View on GitHub</a>
        </div>
        <p className="note">{HERO.note}</p>
      </div>
      <div className="wrap">
        <figure className="window">
          <div className="window-bar" aria-hidden>
            <i /><i /><i />
            <span className="url"><Lock size={11} /> 127.0.0.1:47821</span>
          </div>
          <div className={`window-body ${state}`}>
            <div className="poster"><Themed name="hero" alt="The Behind Everything workspace: nine rooms with agents at work" eager /></div>
            {load && state !== 'failed' && (
              <Suspense fallback={null}>
                <HeroWorld onReady={() => setState('live')} onFail={() => setState('failed')} />
              </Suspense>
            )}
          </div>
          <figcaption>{HERO.caption}</figcaption>
        </figure>
      </div>
    </section>
  );
}

function AssistantStrip() {
  return (
    <section className="strip" aria-label="Supported assistants">
      <div className="wrap strip-inner">
        <p>Works with the agents you already use</p>
        <ul>
          {ASSISTANTS.map(a => (
            <li key={a.id}>
              <span className="mascot-badge"><AgentMascot mascot={mascotFor(a.id, true, 0)} color={ASSISTANT_COLOR[a.id]!} /></span>
              <span><b>{a.name}</b><small>{a.where}</small></span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function SectionHead({ kicker, title, children }: { kicker: string; title: string; children?: ReactNode }) {
  return (
    <div className="section-head">
      <p className="kicker">{kicker}</p>
      <h2>{title}</h2>
      {children && <p className="sub">{children}</p>}
    </div>
  );
}

function HowItWorks() {
  return (
    <section className="section" id="how">
      <div className="wrap">
        <SectionHead kicker="How it works" title="Up and running in under a minute">No configuration, no account, no changes to how you work.</SectionHead>
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={s.title}>
              <span className="step-n" aria-hidden>{i + 1}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
              <code className="step-code">{s.code}</code>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** A screenshot in the page's theme (the toggle wins over the system setting, so this cannot be a media query). */
function Themed({ name, alt, eager, size = [1600, 900] }: { name: string; alt: string; eager?: boolean; size?: [number, number] }) {
  const attrs = { width: size[0], height: size[1], decoding: 'async' as const, loading: eager ? undefined : ('lazy' as const) };
  return (
    <>
      <img className="only-light" src={`${base}shots/${name}-light.jpg`} alt={alt} {...attrs} />
      <img className="only-dark" src={`${base}shots/${name}-dark.jpg`} alt={alt} {...attrs} />
    </>
  );
}

function Shot({ name, alt, size }: { name: string; alt: string; size: [number, number] }) {
  return <div className={`shot${size[1] > size[0] ? ' portrait' : ''}`}><Themed name={name} alt={alt} size={size} /></div>;
}

function FeatureRow({ f, flip }: { f: Feature; flip: boolean }) {
  return (
    <article className={`feature${flip ? ' flip' : ''}`} id={`feature-${f.id}`}>
      <div className="feature-copy">
        <h3>{f.title}</h3>
        <p>{f.body}</p>
        <ul>{f.points.map(p => <li key={p}><Check size={16} aria-hidden />{p}</li>)}</ul>
      </div>
      <div className="feature-media"><Shot name={f.shot} alt={f.alt} size={f.size} /></div>
    </article>
  );
}

function Features() {
  return (
    <section className="section" id="features">
      <div className="wrap">
        <SectionHead kicker="Features" title="Everything your agent does, in one place">From the first file it reads to the last test it runs, with the evidence one click away.</SectionHead>
        <div className="features">{FEATURES.map((f, i) => <FeatureRow key={f.id} f={f} flip={i % 2 === 1} />)}</div>
      </div>
    </section>
  );
}

function HookCallout() {
  return (
    <section className="section tight">
      <div className="wrap">
        <div className="callout">
          <span className="callout-icon" aria-hidden><Plug size={20} /></span>
          <div>
            <h3>Optional: see approval prompts while they wait</h3>
            <p>Claude Code and Codex only log an approval once you have answered it. One more command adds a small background hook that shows their prompts the moment they open. It never answers for you, backs up your settings first, and uninstalls cleanly.</p>
          </div>
          <CopyCommand command={HOOKS} size="small" />
        </div>
      </div>
    </section>
  );
}

function Privacy() {
  return (
    <section className="section alt" id="privacy">
      <div className="wrap">
        <SectionHead kicker="Privacy" title="Your code never leaves your machine">Session logs hold your source code and sometimes your secrets. Behind Everything treats them that way.</SectionHead>
        <ul className="grid-3">
          {PRIVACY.map(p => (
            <li key={p.title} className="card"><h3>{p.title}</h3><p>{p.body}</p></li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const SUPPORT: Record<Support, { label: string; icon: ReactNode }> = {
  yes: { label: 'Yes', icon: <Check size={16} /> },
  partial: { label: 'Partly', icon: <Minus size={16} /> },
  hook: { label: 'With the optional hook', icon: <Plug size={15} /> },
  no: { label: 'No', icon: <X size={15} /> },
};

function Cell({ s }: { s: Support }) {
  return <td className={`support ${s}`}><span aria-hidden>{SUPPORT[s].icon}</span><span className="sr-only">{SUPPORT[s].label}</span></td>;
}

function Matrix() {
  return (
    <section className="section" id="assistants">
      <div className="wrap">
        <SectionHead kicker="Assistants" title="What it sees, assistant by assistant">Each assistant records different things. Here is exactly what Behind Everything can show for each.</SectionHead>
        <div className="matrix-scroll">
          <table className="matrix">
            <caption className="sr-only">Capabilities by assistant</caption>
            <thead>
              <tr>
                <th scope="col">Signal</th>
                {ASSISTANTS.map(a => (
                  <th key={a.id} scope="col"><span className="th-mark"><AgentMascot mascot={mascotFor(a.id, true, 0)} color={ASSISTANT_COLOR[a.id]!} /></span>{a.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {MATRIX.map(r => (
                <tr key={r.signal}>
                  <th scope="row">{r.signal}{r.note && <small>{r.note}</small>}</th>
                  <Cell s={r.claude} /><Cell s={r.codex} /><Cell s={r.copilot} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="legend">
          {(Object.keys(SUPPORT) as Support[]).map(s => <span key={s} className={`support ${s}`}><span aria-hidden>{SUPPORT[s].icon}</span>{SUPPORT[s].label}</span>)}
        </p>
        <ul className="reads">
          {ASSISTANTS.map(a => <li key={a.id}><b>{a.mascot}</b> reads <code>{a.reads}</code></li>)}
        </ul>
      </div>
    </section>
  );
}

function Faq() {
  return (
    <section className="section alt" id="faq">
      <div className="wrap narrow">
        <SectionHead kicker="FAQ" title="Questions, answered" />
        <div className="faq">
          {FAQ.map(f => (
            <details key={f.q}>
              <summary>{f.q}<ChevronDown size={18} aria-hidden /></summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function Closing() {
  return (
    <section className="closing">
      <div className="wrap closing-inner">
        <div className="closing-cast" aria-hidden>
          {ASSISTANTS.map(a => <span key={a.id} className="mascot-badge big"><AgentMascot mascot={mascotFor(a.id, true, 0)} color={ASSISTANT_COLOR[a.id]!} /></span>)}
        </div>
        <h2>{CLOSING.title}</h2>
        <p>{CLOSING.body}</p>
        <CopyCommand command={INSTALL} />
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="wrap footer-inner">
        <div>
          <a className="brand" href="#top"><BrandMark /><span>Behind Everything</span></a>
          <p>A live, local-first view of what AI coding agents actually do.</p>
        </div>
        <nav aria-label="Footer">
          <a href={REPO}>GitHub <ExternalLink size={12} aria-hidden /></a>
          <a href={`${REPO}#readme`}>Documentation <ExternalLink size={12} aria-hidden /></a>
          <a href={`${REPO}/blob/main/docs/CAPABILITIES.md`}>Coverage details <ExternalLink size={12} aria-hidden /></a>
          <a href={`${REPO}/issues`}>Report an issue <ExternalLink size={12} aria-hidden /></a>
          <a href={`${REPO}/blob/main/LICENSE`}>Apache-2.0 licence <ExternalLink size={12} aria-hidden /></a>
        </nav>
      </div>
      <div className="wrap footer-fine">
        <p>Claude Code, Codex and GitHub Copilot are trademarks of their respective owners. Behind Everything is an independent project and is not affiliated with Anthropic, OpenAI or GitHub.</p>
      </div>
    </footer>
  );
}
