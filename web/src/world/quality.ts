/**
 * Keeps the map smooth on weak GPUs: watches how long frames take while something moves and trades resolution for
 * speed. Steps the pixel ratio down when motion runs below ~30 fps and back up, slowly, once frames are quick again.
 * Only frames drawn back to back count; the map sleeps when nothing moves, so idle gaps say nothing.
 */

const WINDOW = 40;
const SLOW_MS = 34;
const FAST_MS = 18;
/** Never step up within this long of the last change: going back and forth would be worse than either. */
const SETTLE_MS = 10_000;
const STEP = 0.5;

export class QualityGovernor {
  private samples: number[] = [];
  private fastRun = 0;
  private changedAt = -Infinity;

  constructor(public dpr: number, private readonly max: number, private readonly min = 1) {}

  /** One frame interval during motion. Returns a new pixel ratio when it should change. */
  sample(intervalMs: number, now: number): number | undefined {
    this.samples.push(intervalMs);
    if (this.samples.length > WINDOW) this.samples.shift();
    if (this.samples.length < WINDOW) return undefined;
    const median = [...this.samples].sort((a, b) => a - b)[WINDOW >> 1]!;
    if (median > SLOW_MS && this.dpr > this.min) return this.change(Math.max(this.min, this.dpr - STEP), now);
    this.fastRun = median < FAST_MS ? this.fastRun + 1 : 0;
    if (this.fastRun >= WINDOW * 3 && this.dpr < this.max && now - this.changedAt > SETTLE_MS) return this.change(Math.min(this.max, this.dpr + STEP), now);
    return undefined;
  }

  private change(dpr: number, now: number): number {
    this.dpr = dpr;
    this.samples = [];
    this.fastRun = 0;
    this.changedAt = now;
    return dpr;
  }
}
