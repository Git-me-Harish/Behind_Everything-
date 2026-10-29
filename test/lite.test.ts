import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClaudeParser } from '../src/adapters/claude-code/parse.js';
import { liteEvent } from '../src/collector/lite.js';
import { Store } from '../src/collector/store.js';
import { reduce } from '../src/core/state.js';
import { inferredFailure } from '../src/core/verdict.js';
import { demoSession } from './fixtures/claude.js';

const parsed = () => {
  const p = createClaudeParser(path.join(os.tmpdir(), '.claude', 'projects', 'x', 's.jsonl'));
  return demoSession().main.jsonl().split('\n').flatMap((l, i) => (l ? p.parse(l, i + 1) : []));
};

describe('liteEvent', () => {
  const events = parsed();

  it('drops bulky detail fields but keeps what the state engine needs', () => {
    const edit = events.find(e => e.correlation?.call_id === 't-edit1' && e.status === 'succeeded')!;
    const lite = liteEvent(edit);
    expect(lite.payload).toEqual({ op: 'update', added: 2, removed: 1 });
    expect(lite.evidence).toEqual({ file: 's.jsonl', line: edit.evidence!.line });
    expect(edit.payload?.patch).toBeDefined(); // the original is untouched
  });

  it('produces the same state as the full events', () => {
    expect(reduce('s', events.map(liteEvent))).toEqual(reduce('s', events));
  });

  it('carries the test verdict when the output is dropped', () => {
    const e = { ...events.find(x => x.kind === 'test.run' && x.status === 'succeeded')!, payload: { output: 'Tests  2 failed | 5 passed' } };
    const lite = liteEvent(e);
    expect(lite.payload?.output).toBeUndefined();
    expect(inferredFailure(lite)).toBe(inferredFailure(e));
  });
});

describe('Store list form', () => {
  it('serves list-form JSON and backfills rows written before the column existed', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'be-lite-')), 'db.sqlite');
    const events = parsed();
    let s = new Store(file);
    s.insert(events);
    s.close();

    // Simulate a v0.1 database: no list form stored.
    const raw = new Database(file);
    raw.exec('UPDATE events SET lite = NULL');
    raw.close();

    s = new Store(file);
    const list = JSON.parse(s.eventsJson(events[0]!.session_id));
    expect(list).toHaveLength(events.length);
    expect(list.every((e: { payload?: Record<string, unknown> }) => !e.payload?.patch && typeof e.payload?.output !== 'string')).toBe(true);
    expect(list.map((e: { seq: number }) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(s.event(events[0]!.id)?.evidence?.file).toContain('.claude');
    s.close();
  });
});
