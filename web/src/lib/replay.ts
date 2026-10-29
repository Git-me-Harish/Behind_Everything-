import { applyEvent, initialState, type SessionState } from '../../../src/core/state.ts';
import type { StoredEvent } from './types.ts';

const EVERY = 250;

/**
 * State at any point in a session, fast enough for dragging a scrubber: keeps a snapshot every
 * 250 events and replays at most 249 events on top of the nearest one.
 */
export class ReplayIndex {
  private snapshots: SessionState[] = [];

  constructor(private sessionId: string, private events: StoredEvent[]) {}

  /** State after applying events[0..count). */
  at(count: number): SessionState {
    const target = Math.max(0, Math.min(count, this.events.length));
    this.fill(Math.floor(target / EVERY));
    const k = Math.floor(target / EVERY);
    const s = structuredClone(this.snapshots[k]!);
    for (let i = k * EVERY; i < target; i++) applyEvent(s, this.events[i]!);
    return s;
  }

  private fill(k: number) {
    if (!this.snapshots.length) this.snapshots.push(initialState(this.sessionId));
    while (this.snapshots.length <= k) {
      const i = this.snapshots.length;
      const s = structuredClone(this.snapshots[i - 1]!);
      for (let j = (i - 1) * EVERY; j < i * EVERY && j < this.events.length; j++) applyEvent(s, this.events[j]!);
      this.snapshots.push(s);
    }
  }
}

/** Delay before showing the next event during playback: real gaps, compressed and clamped. */
export function playbackDelay(prev: StoredEvent | undefined, next: StoredEvent | undefined, speed: number): number {
  if (!prev || !next) return 0;
  const gap = Date.parse(next.ts) - Date.parse(prev.ts);
  return Math.min(1500, Math.max(40, (Number.isFinite(gap) ? gap : 0) / speed));
}
