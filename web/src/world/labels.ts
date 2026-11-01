import type { LabelPos } from './engine.ts';

/** Room for the thought or question bubble that floats above an agent's tag. */
const BUBBLE_PX = 24;
const MAX_NUDGE_PX = 40;

export interface Placement { dy: number; below?: boolean }
interface Rect { left: number; right: number; top: number; bottom: number }
/** How much of the placed labels a rectangle hides, in square pixels. */
const covered = (r: Rect, placed: Rect[]) => placed.reduce((sum, o) => sum + Math.max(0, Math.min(r.right, o.right) - Math.max(r.left, o.left)) * Math.max(0, Math.min(r.bottom, o.bottom) - Math.max(r.top, o.top)), 0);
const overlaps = (a: Rect, b: Rect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/**
 * Keeps every name on the map readable. Room labels are placed back to front, and one that would cover a label already
 * placed moves down just clear of it. An agent tag that would cover a room's name drops below the agent's feet
 * instead (waiting at the Approval Gate, say). Sizes are read before any position is written, so this costs no
 * extra layout.
 */
export function layoutLabels(pos: Map<string, LabelPos>, els: Map<string, HTMLElement>): Map<string, Placement> {
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
    if (!a || foot === undefined || !placed.some(o => overlaps(a, o))) continue;
    // Below the feet only if that covers less of the room names than above does.
    const h = a.bottom - a.top;
    const below = { ...a, top: foot + 6, bottom: foot + 6 + h };
    if (covered(below, placed) < covered(a, placed)) out.set(key, { dy: 0, below: true });
  }
  return out;
}
