import { describe, expect, it } from 'vitest';
import { createClaudeParser } from '../src/adapters/claude-code/parse.js';
import { CanonicalEvent } from '../src/core/schema.js';
import { demoSession, SESSION } from './fixtures/claude.js';

function parseAll(jsonl: string, file = 'C:\\x\\s.jsonl') {
  const p = createClaudeParser(file);
  const events = jsonl.split('\n').flatMap((l, i) => (l ? p.parse(l, i + 1) : []));
  return { events, session: p.session };
}

describe('Claude Code adapter', () => {
  const { main } = demoSession();
  const { events, session } = parseAll(main.jsonl());
  const byCall = (id: string) => events.filter(e => e.correlation?.call_id === id);

  it('emits schema-valid events with unique, stable ids', () => {
    for (const e of events) CanonicalEvent.parse(e);
    expect(new Set(events.map(e => e.id)).size).toBe(events.length);
    expect(parseAll(main.jsonl()).events.map(e => e.id)).toEqual(events.map(e => e.id));
  });

  it('captures session identity and metadata', () => {
    expect(session).toMatchObject({ id: `claude-code:${SESSION}`, cwd: 'C:\\work\\demo', git_branch: 'main', version: '2.1.251', model: 'claude-opus-5-5', title: 'Fix date parser' });
    expect(events[0]!.kind).toBe('session.start');
  });

  it('starts a turn on a human prompt and ends it on end_turn', () => {
    expect(events.filter(e => e.kind === 'turn.start')).toHaveLength(1);
    expect(events.filter(e => e.kind === 'turn.end')).toHaveLength(1);
    expect(events.find(e => e.kind === 'user.prompt')?.summary).toBe('Fix the failing date parser');
  });

  it('never exposes reasoning content', () => {
    const r = events.find(e => e.kind === 'assistant.reasoning')!;
    expect(r.summary).toBe('Reasoning · 2.3s');
    expect(JSON.stringify(events)).not.toContain('SECRET INTERNAL REASONING');
  });

  it('pairs tool calls with results and makes file paths workspace-relative', () => {
    const [call, result] = byCall('t-read');
    expect(call).toMatchObject({ kind: 'file.read', status: 'started', tool: 'Read', resources: [{ type: 'file', ref: 'src/date.ts' }] });
    expect(result).toMatchObject({ kind: 'file.read', status: 'succeeded', actor: 'tool', duration_ms: 1000 });
  });

  it('records edit diff stats', () => {
    expect(byCall('t-edit1')[1]!.payload).toMatchObject({ op: 'update', added: 2, removed: 1 });
  });

  it('classifies failing and passing test runs with exit codes', () => {
    expect(byCall('t-test1')[1]).toMatchObject({ kind: 'test.run', status: 'failed', exit_code: 1, error_category: 'test_failure' });
    expect(byCall('t-test2')[1]).toMatchObject({ kind: 'test.run', status: 'succeeded', exit_code: 0 });
  });

  it('surfaces user approvals and rejections but not routine auto-accepts', () => {
    const decisions = events.filter(e => e.kind === 'permission.decision');
    expect(decisions.map(d => [d.correlation?.call_id, d.status, d.actor])).toEqual([['t-env', 'succeeded', 'user'], ['t-rm', 'failed', 'system']]);
    expect(byCall('t-rm').at(-1)).toMatchObject({ status: 'failed', error_category: 'permission_denied' });
  });

  it('redacts secrets in summaries, payloads and resources', () => {
    const json = JSON.stringify(byCall('t-env'));
    expect(json).not.toContain('sk-ant-abc');
    expect(json).toContain('[REDACTED:');
    expect(byCall('t-env')[0]!.redactions?.length).toBeGreaterThan(0);
  });

  it('marks questions pending until answered', () => {
    expect(byCall('t-ask').map(e => [e.kind, e.status])).toEqual([['user.question', 'pending'], ['user.question', 'succeeded']]);
  });

  it('turns an Agent call into subagent.start/end', () => {
    expect(byCall('t-agent').map(e => e.kind)).toEqual(['subagent.start', 'subagent.end']);
    expect(byCall('t-agent')[1]!.payload).toMatchObject({ agent_id: 'a-review', duration_ms: 4000 });
  });

  it('reports API errors and ignores bookkeeping records', () => {
    expect(events.filter(e => e.kind === 'system.error')).toHaveLength(1);
    expect(events.filter(e => e.kind === 'system.unknown')).toHaveLength(0);
  });

  it('emits a title only when it changes', () => {
    const t = (title: string) => JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: SESSION });
    const { events: ev } = parseAll([t('A'), t('A'), t('B'), t('B')].join('\n'));
    expect(ev.filter(e => e.kind === 'session.meta').map(e => e.summary)).toEqual(['A', 'B']);
  });

  it('flags unknown record types as drift', () => {
    const { events: ev } = parseAll(JSON.stringify({ type: 'brand-new-thing', sessionId: SESSION, timestamp: '2026-10-29T10:00:00Z' }));
    expect(ev.map(e => e.kind)).toEqual(['session.start', 'system.unknown']);
  });

  it('ignores session bookkeeping records (permission mode, cost summary)', () => {
    const rec = (o: object) => JSON.stringify({ sessionId: SESSION, ...o });
    const { events: ev } = parseAll([rec({ type: 'permission-mode', permissionMode: 'auto' }), rec({ type: 'cost-state', totalCostUSD: 1.2 })].join('\n'));
    expect(ev.filter(e => e.kind === 'system.unknown')).toEqual([]);
  });

  it('does not treat background task notifications as prompts', () => {
    const { events: ev } = parseAll(JSON.stringify({ type: 'user', uuid: 'u', sessionId: SESSION, timestamp: '2026-10-29T10:00:00Z', origin: { kind: 'task-notification' }, message: { role: 'user', content: 'task done' } }));
    expect(ev.some(e => e.kind === 'user.prompt')).toBe(false);
  });

  it('tags subagent transcript events with the subagent id', () => {
    const { sub } = demoSession();
    const ev = parseAll(sub.jsonl()).events.filter(e => e.kind === 'file.read');
    expect(ev.every(e => e.agent_id === 'a-review')).toBe(true);
  });

  it('tolerates malformed and partial lines', () => {
    const p = createClaudeParser('f');
    expect(p.parse('{"type":"user",', 1)).toEqual([]);
    expect(p.parse('null', 2)).toEqual([]);
  });
});

describe('Claude Code adapter — inspector payloads', () => {
  const { events } = parseAll(demoSession().main.jsonl());
  it('keeps unified-diff lines for edits', () => {
    const r = events.find(e => e.correlation?.call_id === 't-edit1' && e.status === 'succeeded')!;
    expect(r.payload?.patch).toEqual(['@@ -1,1 +1,2 @@', '-a', '+b', '+c']);
  });
  it('keeps the end of long command output', () => {
    const p = createClaudeParser('f');
    const long = 'x'.repeat(10_000) + '\nTests 3 failed';
    const lines = [
      { type: 'assistant', uuid: 'a1', sessionId: SESSION, timestamp: '2026-10-29T10:00:00Z', message: { id: 'm', content: [{ type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'pnpm test' } }] } },
      { type: 'user', uuid: 'u1', sessionId: SESSION, timestamp: '2026-10-29T10:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: 'c', content: long, is_error: true }] }, toolUseResult: { stdout: long, stderr: '' } },
    ];
    const out = lines.flatMap((l, i) => p.parse(JSON.stringify(l), i + 1));
    const output = String(out.at(-1)!.payload?.output);
    expect(output.length).toBeLessThan(4200);
    expect(output.endsWith('Tests 3 failed')).toBe(true);
  });
});

describe('Claude Code adapter — prompt context', () => {
  const prompt = (content: unknown) => parseAll(JSON.stringify({ type: 'user', uuid: 'u', promptId: 'p', sessionId: SESSION, timestamp: '2026-10-29T10:00:00Z', origin: { kind: 'human' }, message: { role: 'user', content } })).events;

  it('strips IDE context tags from the prompt and records which were present', () => {
    const ev = prompt([{ type: 'text', text: '<ide_opened_file>The user opened src/cli.ts</ide_opened_file>' }, { type: 'text', text: 'Fix the CLI flags' }]);
    const p = ev.find(e => e.kind === 'user.prompt')!;
    expect(p.summary).toBe('Fix the CLI flags');
    expect(p.payload).toMatchObject({ text: 'Fix the CLI flags', context: ['ide_opened_file'] });
  });

  it('does not start a turn for context-only messages', () => {
    expect(prompt('<system-reminder>note</system-reminder>').some(e => e.kind === 'turn.start')).toBe(false);
  });
});
