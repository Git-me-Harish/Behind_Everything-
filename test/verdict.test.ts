import { describe, expect, it } from 'vitest';
import { inferredFailure } from '../src/core/verdict.js';
import { reduce } from '../src/core/state.js';
import type { CanonicalEvent } from '../src/core/schema.js';

const run = (kind: 'test.run' | 'build.run', output: string, status: 'succeeded' | 'failed' = 'succeeded') => ({ kind, status, payload: { output } } as const);

describe('inferredFailure', () => {
  it.each([
    ['vitest', ' Test Files  1 failed | 4 passed (5)\n      Tests  1 failed | 66 passed (68)'],
    ['jest', 'Tests:       2 failed, 10 passed, 12 total'],
    ['pytest', '==== 3 failed, 20 passed in 1.2s ===='],
    ['mocha', '  4 passing\n  1 failing'],
    ['go', '--- FAIL: TestParse (0.00s)\nFAIL\tdemo 0.01s'],
    ['cargo', 'test result: FAILED. 3 passed; 1 failed'],
  ])('detects %s failures', (_n, out) => expect(inferredFailure(run('test.run', out))).toBeTruthy());

  it.each([
    ['tsc', "src/a.ts(3,7): error TS2322: Type 'string' is not assignable"],
    ['eslint', '✖ 3 problems (2 errors, 1 warning)'],
    ['rustc', 'error[E0308]: mismatched types'],
  ])('detects %s check failures', (_n, out) => expect(inferredFailure(run('build.run', out))).toBeTruthy());

  it('leaves genuine passes alone', () => {
    for (const out of ['Tests  71 passed (71)', '0 failed, 12 passed', 'Test Files  5 passed', 'All checks passed', '']) {
      expect(inferredFailure(run('test.run', out))).toBeUndefined();
    }
    expect(inferredFailure(run('build.run', 'Found 0 errors.'))).toBeUndefined();
  });

  it('only applies to successful test and check runs', () => {
    expect(inferredFailure(run('test.run', '3 failed', 'failed'))).toBeUndefined();
    expect(inferredFailure({ kind: 'command.run', status: 'succeeded', payload: { output: '3 failed' } })).toBeUndefined();
  });

  it('counts a piped failing run as an inferred failure in the state', () => {
    const base = { session_id: 's', agent_id: 'main', ts: '2026-10-29T10:00:00Z', assistant: 'claude-code', adapter: { name: 'a', version: '1', capture: 'log' }, source_class: 'observed', actor: 'tool', correlation: { call_id: 'c' }, kind: 'test.run' } as const;
    const s = reduce('s', [
      { ...base, id: '1', status: 'started', actor: 'assistant', summary: 'pnpm test | tail' },
      { ...base, id: '2', status: 'succeeded', exit_code: 0, summary: 'pnpm test | tail', payload: { output: 'Tests  1 failed | 3 passed' } },
    ] as CanonicalEvent[]);
    expect(s.tests).toMatchObject({ runs: 1, passed: 0, failed: 1, last: 'failed', last_inferred: true });
    expect(s.zones.lab).toMatchObject({ status: 'error', source_class: 'inferred' });
    expect(s.attention[0]).toMatchObject({ source_class: 'inferred', severity: 'error' });
  });
});
