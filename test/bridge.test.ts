import { describe, expect, it } from 'vitest';
import { createClaudeParser } from '../src/adapters/claude-code/parse.js';
import { createCodexParser } from '../src/adapters/codex/parse.js';
import { createBridge } from '../src/collector/bridge.js';
import { CanonicalEvent } from '../src/core/schema.js';
import { reduce } from '../src/core/state.js';
import { WaitingTracker } from '../src/core/waiting.js';
import { CWD, SESSION, TranscriptBuilder } from './fixtures/claude.js';
import { CODEX_CWD, CODEX_SESSION, RolloutBuilder } from './fixtures/codex.js';

const parse = (create: (f: string) => { parse(l: string, n: number): CanonicalEvent[] }, jsonl: string) => {
  const p = create('f');
  return jsonl.split('\n').flatMap((l, i) => (l ? p.parse(l, i + 1) : []));
};

/** A Claude session whose Bash call is waiting for permission — the hook's view of it, as Claude Code sends it. */
const claudeAsking = () => new TranscriptBuilder().userPrompt('Clean up').toolUse('t-rm', 'Bash', { command: 'rm -rf build', description: 'Remove the build folder' });
const claudeHook = (extra: object = {}) => ({
  session_id: SESSION, transcript_path: 'x.jsonl', cwd: CWD, permission_mode: 'default', hook_event_name: 'PermissionRequest',
  tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: 'Remove the build folder' }, ...extra,
});

function bridge(t = 0) {
  const out: CanonicalEvent[] = [];
  let now = Date.parse('2026-10-29T10:00:30Z') + t;
  const b = createBridge(e => out.push(...e), () => now);
  return { b, out, tick: (ms: number) => { now += ms; } };
}

describe('hook bridge', () => {
  it('marks the running call the request is about as waiting for approval', () => {
    const { b, out } = bridge();
    b.observe(parse(createClaudeParser, claudeAsking().jsonl()));
    b.ingest('claude-code', claudeHook());
    expect(out).toHaveLength(1);
    CanonicalEvent.parse(out[0]);
    expect(out[0]).toMatchObject({
      session_id: `claude-code:${SESSION}`, kind: 'permission.decision', status: 'pending', actor: 'assistant',
      summary: 'Waiting for approval: Remove the build folder', correlation: { call_id: 't-rm' },
      adapter: { capture: 'hook' }, payload: { source: 'hook', permission_mode: 'default' },
    });
    expect(b.stats()['claude-code']).toMatchObject({ events: 1, matched: 1, unmatched: 0 });
  });

  it('waits for the log when the hook arrives first, and asks once per call', () => {
    const { b, out } = bridge();
    b.ingest('claude-code', claudeHook());
    expect(out).toEqual([]);
    b.observe(parse(createClaudeParser, claudeAsking().jsonl()));
    b.ingest('claude-code', claudeHook());
    expect(out.map(e => e.correlation?.call_id)).toEqual(['t-rm']);
  });

  it('drops a request whose call already finished, and counts one that never appears', () => {
    const { b, out, tick } = bridge();
    b.observe(parse(createClaudeParser, claudeAsking().toolResult('t-rm', 'removed').jsonl()));
    b.ingest('claude-code', claudeHook());
    b.ingest('claude-code', claudeHook({ session_id: 'other', tool_input: { command: 'ls' } }));
    tick(31_000);
    b.sweep();
    expect(out).toEqual([]);
    expect(b.stats()['claude-code']).toMatchObject({ events: 2, matched: 0, unmatched: 1 });
  });

  it('matches Codex shell escalations by the same command summary', () => {
    const { b, out } = bridge();
    const log = new RolloutBuilder().startTurn('turn-1', 'Run the tests').exec('call_t', 'python -m pytest -q', { sandbox_permissions: 'require_escalated', justification: 'Run tests' });
    b.observe(parse(createCodexParser, log.jsonl()));
    b.ingest('codex', { session_id: CODEX_SESSION, turn_id: 'turn-1', cwd: CODEX_CWD, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'python -m pytest -q', description: 'Run tests' } });
    expect(out[0]).toMatchObject({ session_id: `codex:${CODEX_SESSION}`, correlation: { call_id: 'call_t' }, summary: 'Waiting for approval: python -m pytest -q' });
  });

  it('ignores other hook events', () => {
    const { b, out } = bridge();
    b.ingest('claude-code', { ...claudeHook(), hook_event_name: 'PreToolUse' });
    expect([out, b.stats()['claude-code'].events]).toEqual([[], 0]);
  });
});

describe('waiting approvals in the state and across sessions', () => {
  const asking = parse(createClaudeParser, claudeAsking().jsonl());
  const { b, out } = bridge();
  b.observe(asking);
  b.ingest('claude-code', claudeHook());
  const pending = out[0]!;

  it('parks the agent at the Approval Gate until the call runs', () => {
    let s = reduce('s', [...asking, pending]);
    expect(Object.keys(s.approvals.pending)).toEqual(['perm:t-rm']);
    expect(s.agents.main).toMatchObject({ phase: 'awaiting_input', zone: 'approval' });
    const done = parse(createClaudeParser, claudeAsking().toolResult('t-rm', 'removed').jsonl()).slice(asking.length);
    s = reduce('s', [...asking, pending, ...done]);
    expect(s.approvals.pending).toEqual({});
    expect(s.attention.filter(a => !a.resolved && a.id === 'perm:t-rm')).toEqual([]);
  });

  it('lists what each session waits on, and forgets it once answered', () => {
    const w = new WaitingTracker();
    const now = Date.parse(pending.ts);
    expect([...w.apply([...asking, pending])]).toEqual([`claude-code:${SESSION}`]);
    expect(w.list(`claude-code:${SESSION}`, now)).toEqual([expect.objectContaining({ key: 'perm:t-rm', kind: 'approval', summary: 'Waiting for approval: Remove the build folder' })]);
    // Replaying the same events changes nothing (the collector feeds every parsed event, duplicates included).
    w.apply([...asking, pending]);
    expect(w.list(`claude-code:${SESSION}`, now)).toHaveLength(1);
    w.apply(parse(createClaudeParser, claudeAsking().toolResult('t-rm', 'removed').jsonl()));
    expect(w.list(`claude-code:${SESSION}`, now)).toEqual([]);
  });

  it('treats a request from long ago as stale', () => {
    const w = new WaitingTracker();
    w.apply([pending]);
    expect(w.list(`claude-code:${SESSION}`, Date.parse(pending.ts) + 13 * 3_600_000)).toEqual([]);
  });
});
