import { describe, expect, it } from 'vitest';
import { commandText, createCodexParser, innerCalls } from '../src/adapters/codex/parse.js';
import { parsePatch } from '../src/adapters/shared.js';
import { CanonicalEvent, type CanonicalEvent as Event } from '../src/core/schema.js';
import { reduce } from '../src/core/state.js';
import { codexSession, CODEX_SESSION, RolloutBuilder } from './fixtures/codex.js';

function parse(jsonl: string, file = 'C:/x/rollout-2026-10-29T11-00-00-test.jsonl') {
  const p = createCodexParser(file);
  const events = jsonl.split('\n').filter(Boolean).flatMap((l, i) => p.parse(l, i + 1));
  return { events, session: p.session };
}
const byKind = (es: Event[], kind: string) => es.filter(e => e.kind === kind);

describe('Codex adapter', () => {
  const { events, session } = parse(codexSession().jsonl());

  it('produces schema-valid events with unique, stable ids', () => {
    for (const e of events) expect(() => CanonicalEvent.parse(e)).not.toThrow();
    expect(new Set(events.map(e => e.id)).size).toBe(events.length);
    expect(parse(codexSession().jsonl()).events.map(e => e.id)).toEqual(events.map(e => e.id));
  });

  it('reads the session: id, cwd, branch, version, model and a title from the first prompt', () => {
    expect(session).toMatchObject({ id: `codex:${CODEX_SESSION}`, assistant: 'codex', cwd: 'C:\\work\\shop', git_branch: 'feature/cart', version: '0.162.0', model: 'gpt-5.5', title: 'Fix the cart total rounding bug' });
    expect(events.every(e => e.assistant === 'codex' && e.agent_id === 'main')).toBe(true);
  });

  it('takes the prompt from what the user typed, not the injected context', () => {
    const prompts = byKind(events, 'user.prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.summary).toBe('Fix the cart total rounding bug');
    expect(byKind(events, 'turn.start')).toHaveLength(1);
    expect(byKind(events, 'turn.end')[0]).toMatchObject({ status: 'succeeded', duration_ms: 30_000 });
  });

  it('records that reasoning happened, never its content', () => {
    expect(byKind(events, 'assistant.reasoning')).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain('SECRET');
    expect(JSON.stringify(events)).not.toContain('BASE INSTRUCTIONS');
  });

  it('classifies shell reads and searches, and counts the files read', () => {
    const read = byKind(events, 'file.read');
    expect(read.map(e => e.status)).toEqual(['started', 'succeeded']);
    expect(read[1]!.resources).toEqual([{ type: 'file', ref: 'src/cart.py' }]);
    expect(byKind(events, 'file.search').map(e => e.status)).toEqual(['started', 'succeeded']);
  });

  it('closes each command once, with the exit code and duration, whichever report comes first', () => {
    const tests = byKind(events, 'test.run');
    expect(tests.filter(e => e.status === 'started')).toHaveLength(2);
    const results = tests.filter(e => e.status !== 'started');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ status: 'failed', exit_code: 1, duration_ms: 2500, error_category: 'test_failure' });
    // The test run inside a code-mode cell is matched to its CommandExecution item by command text.
    expect(results[1]).toMatchObject({ status: 'succeeded', exit_code: 0, correlation: { call_id: 'call_cell.0' } });
  });

  it('marks a command that asked to leave the sandbox as approved (inferred, since it ran)', () => {
    const perm = byKind(events, 'permission.decision');
    expect(perm).toHaveLength(1);
    expect(perm[0]).toMatchObject({ status: 'succeeded', source_class: 'inferred', actor: 'user' });
    expect(perm[0]!.payload).toMatchObject({ reason: 'Run the test suite' });
  });

  it('turns patches and file changes into edits with real line counts and diffs', () => {
    const edits = byKind(events, 'file.edit').filter(e => e.status === 'succeeded');
    expect(edits.map(e => e.resources?.[0]?.ref)).toEqual(['src/cart.py', 'tests/test_rounding.py']);
    expect(edits[0]!.payload).toMatchObject({ added: 1, removed: 1 });
    expect(edits[0]!.payload?.patch).toContain('+    return round(sum(items), 2)');
    expect(edits[1]!.payload).toMatchObject({ op: 'add', added: 3, removed: 0 });
  });

  it('feeds the same state engine: plan, tests, edits, repair, tokens', () => {
    const s = reduce(session!.id, events);
    expect(s.plan.items.map(i => i.status)).toEqual(['completed', 'in_progress', 'pending']);
    expect(s.tests).toMatchObject({ runs: 2, passed: 1, failed: 1, last: 'passed' });
    expect(s.totals).toMatchObject({ files_read: 1, files_edited: 2, added: 4, removed: 1 });
    expect(s.repair.failures).toBe(1);
    expect(s.tokens).toMatchObject({ input: 4000, output: 900, cache_read: 8000 });
    expect(Object.keys(s.commands.running)).toEqual([]);
    expect(s.agents.main!.label).toBe('Codex');
  });

  it('follows background processes and code-mode cells that finish later', () => {
    const b = new RolloutBuilder()
      .startTurn('t', 'Run the dev server check')
      .exec('call_bg', 'npm run build')
      .output('call_bg', 'Chunk ID: 1\nWall time: 10.0 seconds\nProcess running with session ID 42\nOutput:\n')
      .raw('response_item', { type: 'function_call', name: 'write_stdin', arguments: JSON.stringify({ session_id: 42, chars: '' }), call_id: 'call_poll' })
      .output('call_poll', 'Chunk ID: 2\nWall time: 4.0 seconds\nProcess exited with code 2\nOutput:\nerror TS2322')
      .cell('call_c', 'await tools.shell_command({"command":"git status --short"});')
      .output('call_c', 'Script running with cell ID 7\nWall time 10.0 seconds\nOutput:\n', 'custom_tool_call_output')
      .raw('response_item', { type: 'function_call', name: 'wait', arguments: JSON.stringify({ cell_id: '7' }), call_id: 'call_wait' })
      .output('call_wait', 'Script completed\nExit code: 0\nWall time: 1 seconds\nOutput:\n')
      .endTurn();
    const { events: es } = parse(b.jsonl());
    expect(byKind(es, 'build.run').map(e => [e.status, e.exit_code])).toEqual([['started', undefined], ['failed', 2]]);
    expect(byKind(es, 'command.run').map(e => [e.status, e.exit_code])).toEqual([['started', undefined], ['succeeded', 0]]);
  });

  it('closes calls the log never finished when the turn ends or is interrupted, marked inferred', () => {
    const { events: es } = parse(new RolloutBuilder().startTurn('t', 'go').exec('call_x', 'npm start').abort().jsonl());
    const end = byKind(es, 'command.run').at(-1)!;
    expect(end).toMatchObject({ status: 'cancelled', source_class: 'inferred' });
    expect(byKind(es, 'turn.end')[0]).toMatchObject({ status: 'cancelled', error_category: 'interrupted' });
  });

  it('a thread continued in a second file adds no duplicates', () => {
    const one = parse(codexSession().jsonl(), 'C:/x/rollout-a.jsonl').events;
    const two = parse(codexSession().jsonl(), 'C:/x/rollout-a_b.jsonl').events.filter(e => e.kind !== 'usage.tokens');
    const ids = new Set(one.map(e => e.id));
    expect(two.every(e => ids.has(e.id))).toBe(true);
  });

  it('surfaces record types it does not know as drift', () => {
    const { events: es } = parse(new RolloutBuilder().raw('brand_new_record', {}).raw('event_msg', { type: 'mystery' }).jsonl());
    expect(byKind(es, 'system.unknown').map(e => e.payload?.type)).toEqual(['brand_new_record', 'event:mystery']);
  });
});

describe('Codex helpers', () => {
  it('unwraps shell invocations', () => {
    expect(commandText(['pwsh.exe', '-NoProfile', '-Command', 'ls'])).toBe('ls');
    expect(commandText(['/bin/bash', '-lc', 'pnpm test'])).toBe('pnpm test');
    expect(commandText(['git', 'status'])).toBe('git status');
    expect(commandText('rg x')).toBe('rg x');
  });

  it('finds tool calls inside code-mode cells, braces in strings included', () => {
    const calls = innerCalls('const a = await tools.shell_command({"command":"Get-ChildItem | % { $_.Name }"});\nawait tools.update_plan({"plan":[]});\ntools.x(notJson);');
    expect(calls.map(c => c.name)).toEqual(['shell_command', 'update_plan']);
    expect(calls[0]!.args.command).toBe('Get-ChildItem | % { $_.Name }');
  });

  it('reads apply_patch envelopes', () => {
    expect(parsePatch('*** Begin Patch\n*** Add File: a.ts\n+x\n+y\n*** Update File: b.ts\n@@\n-old\n+new\n*** Delete File: c.ts\n*** End Patch').map(f => [f.path, f.op, f.added, f.removed]))
      .toEqual([['a.ts', 'add', 2, 0], ['b.ts', 'update', 1, 1], ['c.ts', 'delete', 0, 0]]);
  });
});
