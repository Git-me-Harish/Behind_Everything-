import { describe, expect, it } from 'vitest';
import { createClaudeParser } from '../src/adapters/claude-code/parse.js';
import type { CanonicalEvent } from '../src/core/schema.js';
import { applyEvent, initialState, reduce, type SessionState } from '../src/core/state.js';
import { demoSession } from './fixtures/claude.js';

const parse = (jsonl: string) => {
  const p = createClaudeParser('f');
  return jsonl.split('\n').flatMap((l, i) => (l ? p.parse(l, i + 1) : []));
};

/** Main transcript with the subagent's events spliced in while the Agent call is open — the order the collector sees them. */
function arrivalOrder(): CanonicalEvent[] {
  const { main, sub } = demoSession();
  const m = parse(main.jsonl());
  const at = m.findIndex(e => e.correlation?.call_id === 't-agent') + 1;
  return [...m.slice(0, at), ...parse(sub.jsonl()).filter(e => e.kind !== 'session.start'), ...m.slice(at)];
}

/** Replays events and snapshots the state right after the event matching `pred`. */
function stateAfter(events: CanonicalEvent[], pred: (e: CanonicalEvent) => boolean): SessionState {
  const s = initialState('s');
  for (const e of events) {
    applyEvent(s, e);
    if (pred(e)) return structuredClone(s);
  }
  throw new Error('event not found');
}

describe('state engine', () => {
  const events = arrivalOrder();
  const final = reduce('s', events);
  const call = (id: string, status?: string) => (e: CanonicalEvent) => e.correlation?.call_id === id && (!status || e.status === status) && e.kind !== 'permission.decision';

  it('moves the agent through observed phases', () => {
    expect(stateAfter(events, call('t-read', 'started')).agents.main!.phase).toBe('exploring');
    expect(stateAfter(events, call('t-todo', 'started')).agents.main!.phase).toBe('planning');
    expect(stateAfter(events, call('t-edit1', 'started')).agents.main).toMatchObject({ phase: 'implementing', phase_source: 'observed' });
    expect(stateAfter(events, call('t-test1', 'started')).agents.main!.phase).toBe('testing');
    expect(final.agents.main!.phase).toBe('delivering');
  });

  it('infers repair after a failure, with evidence, and clears it on a green run', () => {
    const s = stateAfter(events, call('t-edit2', 'started'));
    expect(s.agents.main).toMatchObject({ phase: 'repairing', phase_source: 'inferred' });
    expect(s.agents.main!.phase_evidence[0]).toContain('t-test1');
    expect(s.zones.repair).toMatchObject({ status: 'warn', source_class: 'inferred' });
    expect(s.zones.lab.status).toBe('error');

    const after = stateAfter(events, call('t-test2', 'succeeded'));
    expect(after.repair.active).toBe(false);
    expect(after.attention.find(a => a.id === 'fail:test.run')?.resolved).toBe(true);
    expect(after.zones.lab.status).not.toBe('error');
  });

  it('aggregates files, tests and approvals', () => {
    expect(final.files['src/date.ts']).toMatchObject({ reads: 2, edits: 2, added: 3, removed: 2 });
    expect(final.tests).toMatchObject({ runs: 2, passed: 1, failed: 1, last: 'passed' });
    expect(final.approvals).toMatchObject({ approved: 1, blocked: 1, pending: {} });
    expect(final.plan.items).toHaveLength(2);
    expect(final.zones.implementation.label).toBe('1 FILE · +3 −2');
  });

  it('holds questions as pending in the approval zone until answered', () => {
    const s = stateAfter(events, call('t-ask', 'pending'));
    expect(s.agents.main!.phase).toBe('awaiting_input');
    expect(s.zones.approval).toMatchObject({ status: 'warn', label: '1 WAITING' });
    expect(final.zones.approval.label).toBe('1 APPROVED · 1 BLOCKED');
  });

  it('spawns a subagent avatar labelled from its Agent call and retires it', () => {
    const s = stateAfter(events, e => e.agent_id === 'a-review' && e.status === 'started');
    expect(s.agents['a-review']).toMatchObject({ parent: 'main', label: 'Review the diff', phase: 'exploring', finished: false });
    expect(final.agents['a-review']).toMatchObject({ finished: true, phase: 'done' });
  });

  it('flags edit loops as inferred attention', () => {
    const base = events.find(e => e.correlation?.call_id === 't-edit1' && e.status === 'succeeded')!;
    const s = reduce('s', [events[0]!, ...[1, 2, 3, 4].map(i => ({ ...base, id: `x${i}` }))]);
    expect(s.attention.find(a => a.id.startsWith('loop:'))).toMatchObject({ severity: 'warn', source_class: 'inferred' });
  });

  it('is deterministic', () => {
    expect(reduce('s', events)).toEqual(final);
  });
});
