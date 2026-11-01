import { CircleHelp, LocateFixed, Maximize2, Minimize2, Minus, Plus, Scan } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { SessionState, ZoneId } from '../../../src/core/state.ts';
import { pickAgent, toggleZone, ZONE_ICON, zoneDot } from '../components/Overview.tsx';
import { AgentMascot, zoneVars } from '../components/ui.tsx';
import { assistantMeta, PHASE_LABEL, ZONE, ZONE_LAYOUT } from '../lib/meta.ts';
import { store, useApp, useAssistant } from '../lib/store.ts';
import { World, type LabelPos } from './engine.ts';
import { worldModel, type AgentModel } from './model.ts';
import { readPalette } from './palette.ts';
import './world.css';

type Density = 'tiny' | 'far' | 'mid' | 'near';

/** How much a label says depends on how big a room is on screen. */
const densityFor = (roomPx: number): Density => (roomPx < 84 ? 'tiny' : roomPx < 120 ? 'far' : roomPx < 270 ? 'mid' : 'near');

const HINTS = {
  wheel: 'Use Ctrl + scroll (or pinch) to zoom the map',
  touch: 'Use two fingers to move the map, or expand it',
} as const;

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/**
 * The isometric workspace. three.js draws the building and the agents; everything you read or click
 * (room labels, agent tags, controls) is ordinary DOM laid over it, so it stays sharp, accessible
 * and keyboard-reachable.
 */
export default function WorldView({ view, onFail }: { view: SessionState; onFail: (reason: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const world = useRef<World | null>(null);
  const labels = useRef(new Map<string, HTMLElement>());
  const [density, setDensity] = useState<Density>('mid');
  const densityRef = useRef<Density>('mid');
  const [hint, setHint] = useState<keyof typeof HINTS>();
  const [lost, setLost] = useState(false);
  const [follow, setFollow] = useState(false);
  const [legend, setLegend] = useState(false);
  const reduced = useReducedMotion();

  const sessionId = useApp(s => s.sessionId);
  const cursor = useApp(s => s.cursor);
  const playing = useApp(s => s.playing);
  const speed = useApp(s => s.speed);
  const eventCount = useApp(s => s.events.length);
  const expanded = useApp(s => s.expanded);
  const selectedZone = useApp(s => (s.selection?.type === 'zone' ? s.selection.id : undefined));
  const filterAgent = useApp(s => s.filter.agent);
  const assistant = useAssistant();
  const model = useMemo(() => worldModel(view, assistant), [view, assistant]);

  // ── engine lifecycle ──
  useEffect(() => {
    let w: World;
    try {
      w = new World(canvas.current!, host.current!, readPalette(), {
        zone: toggleZone,
        agent: id => pickAgent(id, modelRef.current.agents.find(a => a.id === id)?.call_id),
        labels: (pos: Map<string, LabelPos>, roomPx: number) => {
          const placement = layoutLabels(pos, labels.current);
          for (const [key, p] of pos) {
            const el = labels.current.get(key);
            if (!el) continue;
            const at = placement.get(key);
            el.style.transform = at?.below
              ? `translate3d(${p.x.toFixed(1)}px, ${(p.foot! + 6).toFixed(1)}px, 0) translate(-50%, 0)`
              : `translate3d(${p.x.toFixed(1)}px, ${(p.y + (at?.dy ?? 0)).toFixed(1)}px, 0) translate(-50%, -100%)`;
            el.classList.toggle('below', !!at?.below);
            el.style.visibility = p.on ? '' : 'hidden';
          }
          const d = densityFor(roomPx);
          if (d !== densityRef.current) setDensity((densityRef.current = d));
        },
        hint: kind => setHint(kind),
        manual: () => setFollow(false),
        contextLost: setLost,
      }, { reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches });
    } catch (err) {
      onFail(`WebGL 2 is not available here (${err instanceof Error ? err.message : String(err)})`);
      return;
    }
    world.current = w;
    // Read-only hooks for the debug overlay and the browser tests.
    (window as unknown as { __be?: object }).__be = { world: w.stats, room: (z: ZoneId) => w.roomOnScreen(z), agent: (id: string) => w.agentOnScreen(id) };
    // Follow the theme: re-read the CSS tokens whenever <html data-theme> changes.
    const mo = new MutationObserver(() => w.setPalette(readPalette()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      mo.disconnect();
      w.dispose();
      world.current = null;
    };
  }, [onFail]);

  const modelRef = useRef(model);
  modelRef.current = model;

  // ── state → world ──
  const prev = useRef<{ session?: string; cursor: number | null; events: number }>({ cursor: null, events: 0 });
  useEffect(() => {
    const w = world.current;
    if (!w) return;
    const p = prev.current;
    const pos = (c: number | null, n: number) => c ?? n;
    // Jumps (a new session, dragging the scrubber, going live from a replay) re-place agents instead of walking them.
    const jump = Math.abs(pos(cursor, eventCount) - pos(p.cursor, p.events));
    const snap = sessionId !== p.session || (!playing && cursor !== null && jump > 3) || (cursor === null && p.cursor !== null) || reduced;
    if (cursor === null && eventCount > p.events && store.arrivedAt) w.markArrival(store.arrivedAt);
    w.update(model, {
      snap,
      timeScale: playing ? Math.max(1, speed / 2) : 1,
      selectedZone,
      focusAgent: follow ? 'main' : filterAgent,
    });
    prev.current = { session: sessionId, cursor, events: eventCount };
  }, [model, selectedZone, filterAgent, follow, sessionId, cursor, playing, speed, eventCount, reduced]);

  useEffect(() => world.current?.setReducedMotion(reduced), [reduced]);

  useEffect(() => {
    const w = world.current;
    if (!w) return;
    w.expanded = expanded;
    w.resize();
    if (expanded) host.current?.focus();
  }, [expanded]);

  useEffect(() => {
    if (!hint) return;
    const t = window.setTimeout(() => setHint(undefined), 2200);
    return () => window.clearTimeout(t);
  }, [hint]);

  // A context that does not come back (driver crash, GPU removed) → fall back to the board.
  useEffect(() => {
    if (!lost) return;
    const t = window.setTimeout(() => onFail('the graphics context was lost'), 4000);
    return () => window.clearTimeout(t);
  }, [lost, onFail]);

  const ref = (key: string) => (el: HTMLElement | null) => {
    if (el) labels.current.set(key, el);
    else labels.current.delete(key);
  };

  return (
    <div
      ref={host}
      className={`world density-${density}${expanded ? ' expanded' : ''}`}
      data-world=""
      tabIndex={0}
      role="group"
      aria-roledescription="map"
      aria-label="Workspace map. Arrow keys move, + and − zoom, 0 resets. Rooms and agents are buttons."
    >
      <canvas ref={canvas} aria-hidden />
      <div className="wl-layer">
        {ZONE_LAYOUT.map(id => {
          const r = model.rooms[id];
          const meta = ZONE[id];
          const Icon = ZONE_ICON[id];
          const here = model.agents.filter(a => a.zone === id).map(a => a.label);
          return (
            <button
              key={id}
              ref={ref(`zone:${id}`)}
              className={`wl wl-room status-${r.status}`}
              style={{ ...zoneVars(id), visibility: 'hidden' }}
              aria-pressed={selectedZone === id}
              aria-label={`${meta.name}: ${r.label}${here.length ? `, ${here.join(', ')} here` : ''}`}
              title={meta.blurb}
              onClick={() => toggleZone(id)}
            >
              <span className={`pill${r.source_class === 'inferred' ? ' inferred' : ''}`}>
                <span className={`dot ${zoneDot(r.status)}`} />
                <span className="pill-text">{r.label}</span>
              </span>
              <span className="badge"><Icon size={12} aria-hidden /><span className="badge-name">{meta.name}</span><span className={`badge-dot dot ${zoneDot(r.status)}`} /></span>
            </button>
          );
        })}
        {model.agents.map(a => <AgentTag key={a.id} a={a} ref={ref(`agent:${a.id}`)} pressed={filterAgent === a.id} />)}
      </div>

      <div className="world-tools" role="toolbar" aria-label="Map controls">
        <button className="icon-btn" onClick={() => world.current?.zoomBy(1.4)} aria-label="Zoom in" title="Zoom in (+)"><Plus size={15} /></button>
        <button className="icon-btn" onClick={() => world.current?.zoomBy(1 / 1.4)} aria-label="Zoom out" title="Zoom out (−)"><Minus size={15} /></button>
        <button className="icon-btn" onClick={() => { setFollow(false); world.current?.resetView(); }} aria-label="Fit the map" title="Fit (0)"><Scan size={15} /></button>
        <button className="icon-btn" aria-pressed={follow} onClick={() => setFollow(!follow)} aria-label={`Follow ${assistantMeta(assistant).agent}`} title={`Follow ${assistantMeta(assistant).agent}`}><LocateFixed size={15} /></button>
        <button className="icon-btn" aria-pressed={legend} onClick={() => setLegend(!legend)} aria-label="Map legend" title="What am I looking at?"><CircleHelp size={15} /></button>
        <button className="icon-btn" onClick={() => store.toggleExpanded()} aria-label={expanded ? 'Exit full screen map' : 'Full screen map'} title={expanded ? 'Exit full screen (Esc)' : 'Full screen'}>
          {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
      </div>

      {model.hiddenAgents > 0 && <span className="chip world-more">+{model.hiddenAgents} more agents</span>}
      {legend && <Legend assistant={assistant} onClose={() => setLegend(false)} />}
      {hint && <div className="world-hint" role="status">{HINTS[hint]}</div>}
      {lost && <div className="world-hint" role="status">Graphics paused by the browser. Restoring…</div>}
      {new URLSearchParams(location.search).has('debug') && <DebugHud />}
    </div>
  );
}

function AgentTag({ a, pressed, ref }: { a: AgentModel; pressed: boolean; ref: (el: HTMLElement | null) => void }) {
  const phase = a.waiting ? 'Waiting for you' : PHASE_LABEL[a.phase];
  return (
    <button
      ref={ref}
      className={`wl wl-agent${a.finished ? ' finished' : ''}${a.inferred ? ' inferred' : ''}`}
      style={{ '--ac': a.color, visibility: 'hidden' } as CSSProperties}
      aria-pressed={pressed}
      aria-label={`${a.label}: ${a.inferred ? 'probably ' : ''}${phase}${a.summary ? `, ${a.summary}` : ''}`}
      title={a.summary ?? phase}
      onClick={() => pickAgent(a.id, a.call_id)}
    >
      {a.thinking && <span className="bubble" aria-hidden><i /><i /><i /></span>}
      {a.waiting && <span className="bubble ask" aria-hidden>?</span>}
      <span className="agent-tag">
        {a.avatar !== 'person'
          ? <span className="initial mascot" aria-hidden><AgentMascot mascot={a.avatar} color={a.color} /></span>
          : <span className="initial" aria-hidden>{a.initial}</span>}
        <span className="name">{a.label}</span>
        <span className="phase">{a.inferred ? '~ ' : ''}{phase}</span>
      </span>
      {a.summary && <span className="doing">{a.summary}</span>}
    </button>
  );
}

const MASCOT_LEGEND: Record<string, ReactNode> = {
  'claude-code': <><b>Claude</b> is its pixel crab; subagents are smaller crabs in their own colours. They scuttle to the room of what they are doing now, type while a tool runs and wave while waiting for you.</>,
  codex: <><b>Codex</b> is the blue cloud in a beret; its subagents are the heart, the frog and the triangle. They hop to the room of what they are doing now, wobble while a tool runs and bounce while waiting for you.</>,
  'copilot-cli': <><b>Copilot</b> is the goggled head; subagents are smaller heads in their own colours. It glides to the room of what it is doing now and rocks while waiting for you.</>,
};

function Legend({ assistant, onClose }: { assistant: string; onClose: () => void }) {
  const meta = assistantMeta(assistant);
  return (
    <div className="world-legend" role="dialog" aria-label="Map legend">
      <header><b>Reading the map</b><button className="link" onClick={onClose}>Close</button></header>
      <ul>
        <li><b>Rooms</b> are the zones of the work. A coloured light on the back wall shows each room’s status; a ripple crosses the floor when something happens there.</li>
        <li>{MASCOT_LEGEND[assistant] ?? <><b>{meta.agent}</b> is the figure in its colour and walks to the room of what it is doing now.</>} Dots above a head: thinking. <b>?</b>: waiting for you.</li>
        <li><b>Props are real counts</b>: books = files read, notes = plan items, lit monitors = files changed, tubes = test and check verdicts, crates = files ready for review, lamps in the Repair Bay = failures and reruns.</li>
        <li><b>Dashed</b> outlines and <b>~</b> mean inferred from a pattern, not read directly. The Approval Gate’s barrier is down while something waits for you.</li>
        <li>Drag to move · Ctrl+scroll or pinch to zoom · click a room or a person for details.</li>
      </ul>
    </div>
  );
}

function DebugHud() {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick(n => n + 1), 500);
    return () => window.clearInterval(t);
  }, []);
  const s = (window as unknown as { __be?: { world: World['stats'] } }).__be?.world;
  if (!s) return null;
  return (
    <pre className="world-debug">
      {`fps ${s.fps}  frames ${s.frames}\ndraws ${s.drawCalls}  tris ${s.triangles}\ndpr ${s.dpr}  event→pixel ${s.eventToPixelMs?.toFixed(0) ?? '–'} ms`}
    </pre>
  );
}

/** Room for the thought or question bubble that floats above an agent's tag. */
const BUBBLE_PX = 24;
const MAX_NUDGE_PX = 40;

interface Placement { dy: number; below?: boolean }
interface Rect { left: number; right: number; top: number; bottom: number }
const overlaps = (a: Rect, b: Rect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/**
 * Keeps every name on the map readable. Room labels are placed back to front, and one that would cover a label already
 * placed moves down just clear of it. An agent tag that would cover a room's name drops below the agent's feet
 * instead (waiting at the Approval Gate, say). Sizes are read before any position is written, so this costs no
 * extra layout.
 */
function layoutLabels(pos: Map<string, LabelPos>, els: Map<string, HTMLElement>): Map<string, Placement> {
  const out = new Map<string, Placement>();
  const rect = (key: string, extraTop = 0): Rect | undefined => {
    const p = pos.get(key), el = els.get(key);
    if (!p?.on || !el) return undefined;
    const w = el.offsetWidth, h = el.offsetHeight;
    return { left: p.x - w / 2, right: p.x + w / 2, top: p.y - h - extraTop, bottom: p.y };
  };
  const placed: Rect[] = [];
  const rooms = [...pos.keys()].filter(k => k.startsWith('zone:')).sort((a, b) => pos.get(a)!.y - pos.get(b)!.y);
  for (const key of rooms) {
    const r = rect(key);
    if (!r) continue;
    let dy = 0;
    for (let guard = 0; guard < 4; guard++) {
      const hit = placed.find(o => overlaps({ ...r, top: r.top + dy, bottom: r.bottom + dy }, o));
      if (!hit) break;
      dy = Math.min(MAX_NUDGE_PX, hit.bottom - r.top + 3);
      if (dy >= MAX_NUDGE_PX) break;
    }
    placed.push({ ...r, top: r.top + dy, bottom: r.bottom + dy });
    if (dy) out.set(key, { dy });
  }
  for (const key of pos.keys()) {
    if (!key.startsWith('agent:')) continue;
    const a = rect(key, BUBBLE_PX), foot = pos.get(key)?.foot;
    if (a && foot !== undefined && placed.some(o => overlaps(a, o))) out.set(key, { dy: 0, below: true });
  }
  return out;
}
