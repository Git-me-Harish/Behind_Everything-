import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { AgentMascot } from '../../web/src/components/ui.tsx';
import { PHASE_LABEL, ZONE } from '../../web/src/lib/meta.ts';
import { World, type LabelPos } from '../../web/src/world/engine.ts';
import { layoutLabels } from '../../web/src/world/labels.ts';
import { readPalette } from '../../web/src/world/palette.ts';
import { BEAT_MS, BEATS, ROOMS, storyAt } from './story.ts';

/**
 * The real 3D workspace playing the scripted story. Loaded after first paint (three.js is the heavy part); while
 * it loads, or if WebGL is unavailable, the poster screenshot stays. It pauses whenever it is off screen or the
 * tab is hidden, and it does not take the pointer: the page scrolls as usual over it.
 */
export default function HeroWorld({ onReady, onFail }: { onReady: () => void; onFail: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const tags = useRef(new Map<string, HTMLElement>());
  const worldRef = useRef<World | undefined>(undefined);
  // ?hero-beat=N holds the story on one beat: how the poster screenshot is taken.
  const still = Number(new URLSearchParams(location.search).get('hero-beat') ?? NaN);
  const [beat, setBeat] = useState(Number.isFinite(still) ? still : 0);
  const model = storyAt(beat);

  useEffect(() => {
    let world: World;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    try {
      world = new World(canvas.current!, host.current!, readPalette(), {
        zone: () => {}, agent: () => {}, hint: () => {}, manual: () => {}, contextLost: () => {},
        labels: (pos: Map<string, LabelPos>) => {
          // The app's own label layout: room names stay readable, a tag in the way drops below its agent.
          const placement = layoutLabels(pos, tags.current);
          for (const [key, p] of pos) {
            const el = tags.current.get(key);
            if (!el) continue;
            const at = placement.get(key);
            el.style.transform = at?.below
              ? `translate3d(${p.x.toFixed(1)}px, ${(p.foot! + 6).toFixed(1)}px, 0) translate(-50%, 0)`
              : `translate3d(${p.x.toFixed(1)}px, ${(p.y + (at?.dy ?? 0)).toFixed(1)}px, 0) translate(-50%, -100%)`;
            el.classList.toggle('below', !!at?.below);
            el.style.visibility = p.on ? '' : 'hidden';
          }
        },
      }, { reducedMotion: reduced });
    } catch {
      onFail();
      return;
    }
    world.update(storyAt(Number.isFinite(still) ? still : 0), { snap: true, timeScale: 1 });
    onReady();
    (window as unknown as { __hero?: World }).__hero = world;

    // Follow the theme: the world reads its colours from the same tokens as the page.
    const themeWatch = new MutationObserver(() => world.setPalette(readPalette()));
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    // Advance only while it can be seen.
    let visible = true;
    let timer = 0;
    const tick = () => {
      if (visible && !document.hidden && !reduced && !Number.isFinite(still)) setBeat(b => (b + 1) % BEATS);
      timer = window.setTimeout(tick, BEAT_MS);
    };
    timer = window.setTimeout(tick, BEAT_MS);
    const io = new IntersectionObserver(([e]) => { visible = !!e?.isIntersecting; }, { threshold: 0.15 });
    io.observe(host.current!);
    worldRef.current = world;
    return () => {
      clearTimeout(timer);
      io.disconnect();
      themeWatch.disconnect();
      world.dispose();
      worldRef.current = undefined;
    };
  }, []);

  useEffect(() => { worldRef.current?.update(model, { snap: false, timeScale: 1 }); }, [beat]);

  const tag = (key: string) => (el: HTMLElement | null) => { if (el) tags.current.set(key, el); else tags.current.delete(key); };
  return (
    <div className="hero-world" ref={host} aria-hidden>
      <canvas ref={canvas} />
      {ROOMS.map(z => (
        <span key={z} ref={tag(`zone:${z}`)} className="hw-room" style={{ '--zb': `var(--z-${z}-b)`, visibility: 'hidden' } as CSSProperties}>{ZONE[z].name}</span>
      ))}
      {model.agents.map(a => (
        <span key={a.id} ref={tag(`agent:${a.id}`)} className={`hw-agent${a.finished ? ' done' : ''}${a.waiting ? ' waiting' : ''}`} style={{ '--ac': a.color, visibility: 'hidden' } as CSSProperties}>
          {a.waiting && <i className="hw-ask">?</i>}
          <span className="hw-mark"><AgentMascot mascot={a.avatar === 'person' ? undefined : a.avatar} color={a.color} /></span>
          <b>{a.label}</b>
          <span className="hw-phase">{a.waiting ? 'Waiting for you' : PHASE_LABEL[a.phase]}</span>
        </span>
      ))}
    </div>
  );
}
