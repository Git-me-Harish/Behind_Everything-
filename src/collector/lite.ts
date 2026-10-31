import path from 'node:path';
import { truncate } from '../core/redact.js';
import type { CanonicalEvent } from '../core/schema.js';
import { inferredFailure } from '../core/verdict.js';

/** Payload fields only the inspector needs; fetched per event from /api/events/:id. */
const DETAIL_ONLY = new Set(['patch', 'output', 'stderr', 'text', 'plan', 'prompt', 'input']);

/**
 * The list form of an event: everything the timeline and the state engine use, without the bulky
 * outputs, diffs and texts. A 10k-event session drops from ~15 MB to a few MB.
 */
export function liteEvent<T extends CanonicalEvent>(e: T): T {
  const out: T = { ...e };
  if (e.payload) {
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e.payload)) {
      // Numbers are never bulky, and `input`/`output` are also token counts on usage events.
      if (DETAIL_ONLY.has(k) && typeof v !== 'number') continue;
      payload[k] = k === 'command' && typeof v === 'string' ? truncate(v, 300) : v;
    }
    // The verdict needs the output we are about to drop, so it travels as a precomputed hint.
    const hint = inferredFailure(e);
    if (hint) payload.failure_hint = hint;
    out.payload = payload;
  }
  if (e.resources) out.resources = e.resources.map(r => ({ ...r, ref: truncate(r.ref, 300) }));
  if (e.evidence) out.evidence = { file: path.basename(e.evidence.file), line: e.evidence.line };
  return out;
}
