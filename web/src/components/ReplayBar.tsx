import { Pause, Play, Radio, SkipBack, SkipForward } from 'lucide-react';
import { clock, dateTime } from '../lib/format.ts';
import { store, useApp } from '../lib/store.ts';

const SPEEDS = [1, 4, 16, 64];

export function ReplayBar() {
  const events = useApp(s => s.events);
  const cursor = useApp(s => s.cursor);
  const playing = useApp(s => s.playing);
  const speed = useApp(s => s.speed);
  const n = events.length;
  const pos = cursor ?? n;
  const at = events[Math.max(0, pos - 1)];
  const live = cursor === null;

  return (
    <footer className="replay" aria-label="Replay">
      <button className="icon-btn" onClick={() => store.step(-1)} disabled={!n || pos === 0} aria-label="Step back one event" title="Step back ([)"><SkipBack size={14} /></button>
      <button className="icon-btn" onClick={() => store.togglePlay()} disabled={!n} aria-label={playing ? 'Pause replay' : 'Replay this session'} title="Play / pause (Space)">
        {playing ? <Pause size={14} /> : <Play size={14} />} {playing ? 'Pause' : live ? 'Replay' : 'Play'}
      </button>
      <button className="icon-btn" onClick={() => store.step(1)} disabled={!n || live} aria-label="Step forward one event" title="Step forward (])"><SkipForward size={14} /></button>
      <select value={speed} onChange={e => store.setSpeed(Number(e.target.value))} aria-label="Replay speed">
        {SPEEDS.map(s => <option key={s} value={s}>{s}×</option>)}
      </select>
      <input
        type="range" min={0} max={n} value={pos} disabled={!n}
        onChange={e => store.seek(Number(e.target.value))}
        aria-label="Replay position" aria-valuetext={at ? `Event ${pos} of ${n}, ${clock(at.ts)}` : undefined}
      />
      <span className="pos" title={at ? dateTime(at.ts) : undefined}>
        {n ? `${live ? n : pos} / ${n}${at ? ` · ${clock(at.ts)}` : ''}` : 'No events'}
      </span>
      <button className="icon-btn live-btn" aria-pressed={live} onClick={() => store.goLive()} title="Follow live (L)">
        <Radio size={14} /> {live ? 'Live' : 'Go live'}
      </button>
    </footer>
  );
}
