import { describe, expect, it } from 'vitest';
import { createClaudeParser } from '../../src/adapters/claude-code/parse.js';
import { reduce } from '../../src/core/state.js';
import { asOf, buildActivities, buildRows, emptyFilter, activityForEvent, type Filter } from '../../web/src/lib/activities.js';
import { playbackDelay, ReplayIndex } from '../../web/src/lib/replay.js';
import type { StoredEvent } from '../../web/src/lib/types.js';
import { demoSession } from '../fixtures/claude.js';

function events(): StoredEvent[] {
  const p = createClaudeParser('f');
  return demoSession().main.jsonl().split('\n').flatMap((l, i) => (l ? p.parse(l, i + 1) : [])).map((e, i) => ({ ...e, seq: i + 1 }));
}

const filter = (patch: Partial<Filter>): Filter => ({ ...emptyFilter(), ...patch });

describe('buildActivities', () => {
  const ev = events();
  const acts = buildActivities(ev);
  const byKey = (k: string) => acts.find(a => a.key === `call:${k}`)!;

  it('pairs each tool call with its result into one activity', () => {
    const t = byKey('t-test1');
    expect(t).toMatchObject({ kind: 'test.run', status: 'failed', duration_ms: 1000 });
    expect(t.result?.exit_code).toBe(1);
    expect(acts.filter(a => a.key === 'call:t-test1')).toHaveLength(1);
  });

  it('attaches permission decisions to the call they decided', () => {
    expect(byKey('t-env').related.map(r => r.kind)).toEqual(['permission.decision']);
    expect(byKey('t-rm').related[0]?.status).toBe('failed');
  });

  it('keeps a subagent call as one activity through to its end', () => {
    expect(byKey('t-agent')).toMatchObject({ kind: 'subagent.start', status: 'succeeded' });
  });

  it('collects files touched', () => {
    expect(byKey('t-edit1').files).toEqual(['src/date.ts']);
  });

  it('finds the activity holding any event id', () => {
    const result = ev.find(e => e.correlation?.call_id === 't-edit2' && e.status === 'succeeded')!;
    expect(activityForEvent(acts, result.id)?.key).toBe('call:t-edit2');
  });
});

describe('buildRows', () => {
  const ev = events();
  const acts = buildActivities(ev);

  it('opens each turn with a header carrying the prompt, and hides bookkeeping events', () => {
    const rows = buildRows(ev, acts, emptyFilter());
    expect(rows[0]).toMatchObject({ type: 'turn', index: 1 });
    expect(rows[0]!.type === 'turn' && rows[0]!.prompt?.summary).toBe('Fix the failing date parser');
    const kinds = rows.flatMap(r => (r.type === 'activity' ? [r.activity.kind] : []));
    expect(kinds).not.toContain('usage.tokens');
    expect(kinds).not.toContain('user.prompt');
    expect(kinds).toContain('assistant.reasoning'); // 2.3s: long enough to show
  });

  it('filters by category, failure, file, and free text', () => {
    const only = (f: Partial<Filter>) => buildRows(ev, acts, filter(f)).flatMap(r => (r.type === 'activity' ? [r.activity.key] : []));
    expect(only({ categories: new Set(['verify']) })).toEqual(['call:t-test1', 'call:t-test2']);
    expect(only({ failedOnly: true })).toEqual(['call:t-test1', 'call:t-rm', 'cc:sys-1:api-error']);
    expect(only({ file: 'src/date.ts' })).toEqual(['call:t-read', 'call:t-edit1', 'call:t-edit2']);
    expect(only({ text: 'clean build' })).toEqual(['call:t-rm']);
  });
});

describe('asOf', () => {
  it('shows a call as still running before its result arrives', () => {
    const ev = events();
    const acts = buildActivities(ev);
    const call = ev.find(e => e.correlation?.call_id === 't-test1' && e.status === 'started')!;
    const t = asOf(acts, call.seq).find(a => a.key === 'call:t-test1')!;
    expect(t.status).toBe('started');
    expect(t.result).toBeUndefined();
    expect(asOf(acts, call.seq).at(-1)!.seq).toBeLessThanOrEqual(call.seq);
  });
});

describe('ReplayIndex', () => {
  it('matches a full reduce at every position, across snapshot boundaries', () => {
    // Repeat the session so it spans several 250-event snapshots.
    const base = events();
    const many = Array.from({ length: 12 }, (_, k) => base.map(e => ({ ...e, id: `${k}:${e.id}`, seq: k * base.length + e.seq }))).flat();
    const idx = new ReplayIndex('s', many);
    for (const n of [0, 1, 249, 250, 251, 499, 500, many.length - 1, many.length]) {
      expect(idx.at(n)).toEqual(reduce('s', many.slice(0, n)));
    }
  });

  it('compresses real gaps into a watchable playback delay', () => {
    const a = { ts: '2026-10-29T10:00:00Z' } as StoredEvent;
    const b = { ts: '2026-10-29T10:01:00Z' } as StoredEvent;
    expect(playbackDelay(a, b, 4)).toBe(1500);
    expect(playbackDelay(a, a, 4)).toBe(40);
  });
});
