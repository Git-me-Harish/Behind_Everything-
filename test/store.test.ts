import { describe, expect, it } from 'vitest';
import { Store } from '../src/collector/store.js';
import type { CanonicalEvent } from '../src/core/schema.js';

const ev = (id: string, summary: string): CanonicalEvent => ({
  id, session_id: 's', agent_id: 'main', ts: '2026-10-29T10:00:00Z', assistant: 'claude-code',
  adapter: { name: 'a', version: '1', capture: 'log' }, kind: 'command.run', source_class: 'observed', actor: 'tool', summary,
});

describe('Store', () => {
  it('assigns per-session sequence numbers and returns only new events', () => {
    const s = new Store(':memory:');
    expect(s.insert([ev('a', 'x'), ev('b', 'y')]).map(e => e.seq)).toEqual([1, 2]);
    expect(s.insert([ev('a', 'x'), ev('c', 'z')]).map(e => [e.id, e.seq])).toEqual([['c', 3]]);
  });

  it('upgrades stored content on re-ingestion without changing order', () => {
    const s = new Store(':memory:');
    s.insert([ev('a', 'old'), ev('b', 'y')]);
    expect(s.insert([ev('a', 'new')])).toEqual([]);
    expect(s.events('s').map(e => [e.id, e.seq, e.summary])).toEqual([['a', 1, 'new'], ['b', 2, 'y']]);
  });
});
