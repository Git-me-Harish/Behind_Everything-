import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSessionLog, listSessionLogs } from '../src/adapters/copilot-cli/discover.js';
import { applyTodoSql, createCopilotParser } from '../src/adapters/copilot-cli/parse.js';
import { CanonicalEvent } from '../src/core/schema.js';
import { reduce } from '../src/core/state.js';
import { at, COPILOT_SESSION, CopilotLogBuilder, copilotSession } from './fixtures/copilot.js';

const FILE = `C:\\Users\\me\\.copilot\\session-state\\${COPILOT_SESSION}\\events.jsonl`;

function parseAll(jsonl: string) {
  const p = createCopilotParser(FILE);
  const events = jsonl.split('\n').flatMap((l, i) => (l ? p.parse(l, i + 1) : []));
  return { events, session: p.session, parser: p };
}

describe('Copilot CLI adapter', () => {
  const { events, session } = parseAll(copilotSession().jsonl());
  const byCall = (id: string) => events.filter(e => e.correlation?.call_id === id);
  const result = (id: string) => byCall(id).find(e => e.actor === 'tool')!;

  it('emits schema-valid events with unique, stable ids', () => {
    for (const e of events) CanonicalEvent.parse(e);
    expect(new Set(events.map(e => e.id)).size).toBe(events.length);
    expect(parseAll(copilotSession().jsonl()).events.map(e => e.id)).toEqual(events.map(e => e.id));
  });

  it('captures session identity and metadata', () => {
    expect(session).toMatchObject({ id: `copilot-cli:${COPILOT_SESSION}`, assistant: 'copilot-cli', cwd: 'C:\\work\\notes', git_branch: 'feature/tags', version: '1.0.75', model: 'gpt-6-luna', title: 'Add tags to notes' });
    expect(events[0]!.kind).toBe('session.start');
  });

  it('runs one turn from the prompt to the model call that requests no tools', () => {
    expect(events.filter(e => e.kind === 'turn.start')).toHaveLength(1);
    expect(events.filter(e => e.kind === 'turn.end').map(e => [e.status, e.source_class])).toEqual([['succeeded', 'observed']]);
    expect(events.at(-1)!.kind).toBe('turn.end');
    expect(events.find(e => e.kind === 'user.prompt')?.summary).toBe('Add tags to notes');
  });

  it('records that reasoning happened once per model call, never its content', () => {
    expect(events.filter(e => e.kind === 'assistant.reasoning')).toHaveLength(5);
    expect(JSON.stringify(events)).not.toContain('SECRET COPILOT REASONING');
  });

  it('reads and searches, with workspace-relative paths', () => {
    expect(result('c-view')).toMatchObject({ kind: 'file.read', status: 'succeeded', summary: 'Read src/notes.ts', resources: [{ type: 'file', ref: 'src/notes.ts' }] });
    expect(result('c-rg')).toMatchObject({ kind: 'file.search', summary: 'Search "save\\(" in src' });
  });

  it('records edits from apply_patch, edit and create with line counts and diffs', () => {
    expect(result('c-patch').payload).toMatchObject({ op: 'update', added: 2, removed: 1 });
    expect(result('c-patch').resources).toEqual([{ type: 'file', ref: 'src/notes.ts' }]);
    expect(result('c-edit').payload).toMatchObject({ op: 'update', added: 2, removed: 1, patch: ['@@', '-export const TAGS = [];', '+export const TAGS: string[] = [];', '+export const MAX_TAGS = 8;'] });
    expect(result('c-create')).toMatchObject({ summary: 'Create tests/tags.test.ts', payload: { op: 'add', added: 3, removed: 0 } });
  });

  it('classifies shell runs with exit codes, including PowerShell call syntax', () => {
    expect(result('c-test1')).toMatchObject({ kind: 'test.run', status: 'failed', exit_code: 1, error_category: 'test_failure', summary: 'Run the test suite' });
    expect(result('c-test2')).toMatchObject({ kind: 'test.run', status: 'succeeded', exit_code: 0 });
  });

  it('keeps a shell Copilot stopped waiting for running until its exit code is reported', () => {
    const server = byCall('c-server');
    expect(server.map(e => e.status)).toEqual(['started', 'succeeded']);
    expect(server[1]).toMatchObject({ exit_code: 0, source_class: 'observed' });
    expect(events.indexOf(server[1]!)).toBeGreaterThan(events.findIndex(e => e.correlation?.call_id === 'c-ask'));
  });

  it('follows the todo list Copilot keeps in its SQL table', () => {
    expect(byCall('c-todo')[0]).toMatchObject({ kind: 'plan.update', summary: 'Plan 0/2 done', payload: { todos: [{ text: 'Store tags', status: 'in_progress' }, { text: 'Show tags', status: 'pending' }] } });
    expect(byCall('c-todo2')[0]).toMatchObject({ summary: 'Plan 1/2 done', payload: { todos: [{ text: 'Store tags', status: 'completed' }, { text: 'Show tags', status: 'in_progress' }] } });
  });

  it('shows your decisions but not routine policy approvals', () => {
    const decisions = events.filter(e => e.kind === 'permission.decision');
    expect(decisions.map(d => [d.correlation?.call_id, d.status, d.actor, d.summary])).toEqual([
      ['c-patch', 'succeeded', 'user', 'Approved by you: Edit src/notes.ts'],
      ['c-rm', 'failed', 'user', 'Blocked by you: Run Remove-Item -Recurse -Force build'],
    ]);
    expect(decisions[1]!.payload).toMatchObject({ decision: 'reject', source: 'you', feedback: 'keep the build' });
    expect(result('c-rm')).toMatchObject({ status: 'failed', error_category: 'permission_denied' });
  });

  it('marks questions pending until answered', () => {
    expect(byCall('c-ask').map(e => [e.kind, e.status])).toEqual([['user.question', 'pending'], ['user.question', 'succeeded']]);
  });

  it('gives a subagent its own agent, named after the call that started it', () => {
    expect(byCall('c-task').map(e => e.kind)).toEqual(['subagent.start', 'subagent.end']);
    expect(byCall('c-task')[1]!.payload).toMatchObject({ agent_id: 'c-task', duration_ms: 4000 });
    expect(byCall('c-sub-view').every(e => e.agent_id === 'c-task')).toBe(true);
    const s = reduce(session!.id, events);
    expect(s.agents['c-task']).toMatchObject({ parent: 'main', label: 'Review the tagging change', finished: true });
  });

  it('reports MCP calls by server and tool', () => {
    expect(result('c-mcp')).toMatchObject({ kind: 'mcp.call', summary: 'github-mcp-server · list_issues', resources: [{ type: 'mcp', ref: 'github-mcp-server/list_issues' }] });
  });

  it('reduces to a coherent workspace state', () => {
    const s = reduce(session!.id, events);
    expect(s.tests).toMatchObject({ runs: 2, passed: 1, failed: 1, last: 'passed' });
    expect(s.plan.items).toHaveLength(2);
    expect(s.approvals).toMatchObject({ pending: {}, approved: 1, blocked: 1 });
    expect(s.commands.running).toEqual({});
    expect(s.totals).toMatchObject({ files_edited: 3, files_read: 1 });
    expect(s.turn.open).toBe(false);
  });
});

describe('Copilot CLI adapter: waiting approvals', () => {
  const lines = (b: CopilotLogBuilder) => b.jsonl().split('\n').filter(Boolean);
  const begin = () => new CopilotLogBuilder().prompt('Clean up').modelCall()
    .start('c-rm', 'powershell', { command: 'Remove-Item build -Recurse', mode: 'sync' })
    .ask('r-rm', { kind: 'shell', fullCommandText: 'Remove-Item build -Recurse', intention: 'Delete the build folder', toolCallId: 'c-rm' });

  it('shows a request Copilot is still waiting on, and resolves it with your answer', () => {
    const p = createCopilotParser(FILE);
    const first = lines(begin()).flatMap((l, i) => p.parse(l, i + 1));
    const waiting = p.idle();
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ kind: 'permission.decision', status: 'pending', summary: 'Waiting for approval: Run Remove-Item build -Recurse', correlation: { call_id: 'c-rm' } });
    expect(p.idle()).toEqual([]);

    let s = reduce('s', [...first, ...waiting]);
    expect(Object.keys(s.approvals.pending)).toHaveLength(1);
    expect(s.agents.main).toMatchObject({ phase: 'awaiting_input', zone: 'approval' });
    expect(s.commands.running['c-rm']).toBeDefined();

    const rest = lines(begin().decision('r-rm', { kind: 'approved' }, 'human_response').complete('c-rm', true, '<shellId: 0 completed with exit code 0>', { shellExecution: { exitCode: 0 } }));
    const later = rest.slice(-2).flatMap((l, i) => p.parse(l, 100 + i));
    expect(later.map(e => [e.kind, e.status, e.actor])).toEqual([['permission.decision', 'succeeded', 'user'], ['command.run', 'succeeded', 'tool']]);
    s = reduce('s', [...first, ...waiting, ...later]);
    expect(s.approvals).toMatchObject({ pending: {}, approved: 1 });
    expect(s.attention.filter(a => !a.resolved && a.severity === 'info')).toEqual([]);
  });

  it('labels a policy approval that arrived after a read as automatic, and does not count it as yours', () => {
    const p = createCopilotParser(FILE);
    lines(begin()).forEach((l, i) => p.parse(l, i + 1));
    p.idle();
    const [decision] = p.parse(JSON.stringify({ type: 'permission.completed', id: 'x', timestamp: '2026-10-29T10:00:00Z', data: { requestId: 'r-rm', result: { kind: 'approved' }, decisionSource: 'host_policy' } }), 99);
    expect(decision).toMatchObject({ status: 'succeeded', actor: 'system', summary: 'Approved automatically: Run Remove-Item build -Recurse', payload: { source: 'policy' } });
  });

  it('never surfaces requests that were decided before the read finished', () => {
    const { parser } = parseAll(copilotSession().jsonl());
    expect(parser.idle()).toEqual([]);
  });

  it('cancels a waiting request when the turn is interrupted', () => {
    const p = createCopilotParser(FILE);
    lines(begin()).forEach((l, i) => p.parse(l, i + 1));
    p.idle();
    const ev = p.parse(JSON.stringify({ type: 'abort', id: 'a', timestamp: '2026-10-29T10:00:00Z', data: { reason: 'user_initiated' } }), 99);
    expect(ev.map(e => [e.kind, e.status])).toEqual([['command.run', 'cancelled'], ['permission.decision', 'cancelled'], ['turn.end', 'cancelled']]);
    expect(ev.at(-1)).toMatchObject({ error_category: 'interrupted', summary: 'Turn interrupted' });
  });
});

describe('Copilot CLI adapter: turn edges', () => {
  it('fails the turn when a model call returns nothing and an error follows', () => {
    const b = new CopilotLogBuilder().prompt('Hello').modelCall('', false).endModelCall()
      .raw('session.error', { errorType: 'quota', errorCode: 'quota_exceeded', message: 'You have run out of premium requests', statusCode: 402 });
    const { events } = parseAll(b.jsonl());
    expect(events.filter(e => e.kind === 'system.error').map(e => e.summary)).toEqual(['quota: You have run out of premium requests']);
    expect(events.at(-1)).toMatchObject({ kind: 'turn.end', status: 'failed' });
  });

  it('treats steering messages as part of the running turn and hides injected ones', () => {
    const b = new CopilotLogBuilder().prompt('Build it').modelCall()
      .start('c1', 'view', { path: at('a.ts') })
      .prompt('Use TypeScript', { delivery: 'steering' })
      .prompt('Skill instructions', { source: 'skill-pdf' })
      .complete('c1', true, 'x').endModelCall();
    const { events } = parseAll(b.jsonl());
    expect(events.filter(e => e.kind === 'turn.start')).toHaveLength(1);
    expect(events.filter(e => e.kind === 'user.prompt').map(e => e.summary)).toEqual(['Build it', 'Use TypeScript']);
  });

  it('closes what was running when the session process ends', () => {
    const b = new CopilotLogBuilder().prompt('Serve').modelCall();
    b.shellTimeout('c-srv', 'npm run dev');
    b.raw('session.shutdown', { shutdownType: 'routine', codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] }, modelMetrics: {}, sessionStartTime: 0, totalApiDurationMs: 0 });
    const { events } = parseAll(b.jsonl());
    expect(events.find(e => e.correlation?.call_id === 'c-srv' && e.actor === 'tool')).toMatchObject({ status: 'cancelled', source_class: 'inferred' });
    expect(events.at(-1)).toMatchObject({ kind: 'turn.end', status: 'cancelled', source_class: 'inferred' });
    expect(reduce('s', events).commands.running).toEqual({});
  });

  it('flags unknown record types as drift and tolerates malformed lines', () => {
    const p = createCopilotParser(FILE);
    expect(p.parse('{"type":"user.message",', 1)).toEqual([]);
    expect(p.parse('null', 2)).toEqual([]);
    const ev = p.parse(JSON.stringify({ type: 'brand.new_thing', id: 'z', timestamp: '2026-10-29T10:00:00Z', data: {} }), 3);
    expect(ev.map(e => [e.kind, e.payload?.type])).toEqual([['system.unknown', 'brand.new_thing']]);
  });

  it('does not report a version for the VS Code-hosted runtime (it logs 0.0.0)', () => {
    const { session } = parseAll(new CopilotLogBuilder(COPILOT_SESSION, '0.0.0').jsonl());
    expect(session?.version).toBeUndefined();
  });
});

describe('applyTodoSql', () => {
  const run = (...sql: string[]) => {
    const todos = new Map<string, { text: string; status: string }>();
    const changed = sql.map(q => applyTodoSql(q, todos));
    return { todos: [...todos.entries()], changed };
  };

  it('applies inserts, id-targeted updates and deletes', () => {
    const { todos } = run(
      "INSERT INTO todos (id, title, status) VALUES ('a', 'It''s A', 'pending'), ('b', 'B; with semicolon', 'pending'), ('c', 'C', 'pending')",
      "UPDATE todos SET status = 'done', updated_at = CURRENT_TIMESTAMP WHERE id IN ('a', 'b')",
      "UPDATE todos SET status = 'blocked', description = 'x = y, z' WHERE id = 'c'",
      "DELETE FROM todos WHERE id = 'b'",
    );
    expect(todos).toEqual([['a', { text: "It's A", status: 'completed' }], ['c', { text: 'C', status: 'blocked' }]]);
  });

  it('ignores reads, other tables and conditions it cannot evaluate', () => {
    const { todos, changed } = run(
      "INSERT INTO todos (id, title, status) VALUES ('a', 'A', 'pending')",
      'SELECT * FROM todos',
      "INSERT INTO todo_deps (todo_id, depends_on) VALUES ('a', 'b')",
      "UPDATE todos SET status = 'done' WHERE status = 'pending'",
    );
    expect(changed).toEqual([true, false, false, false]);
    expect(todos).toEqual([['a', { text: 'A', status: 'pending' }]]);
  });
});

describe('Copilot session discovery', () => {
  it('finds events.jsonl in each session folder and skips lock folders', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'be-copilot-'));
    try {
      for (const d of ['s1', 's2', '.session-operation-locks']) fs.mkdirSync(path.join(root, d));
      fs.writeFileSync(path.join(root, 's1', 'events.jsonl'), '');
      fs.writeFileSync(path.join(root, '.session-operation-locks', 'events.jsonl'), '');
      expect(listSessionLogs(root)).toEqual([path.join(root, 's1', 'events.jsonl')]);
      expect(isSessionLog(path.join(root, 's2', 'events.jsonl'), root)).toBe(true);
      expect(isSessionLog(path.join(root, 's2', 'session.db'), root)).toBe(false);
      expect(isSessionLog(path.join(root, '.session-operation-locks', 'events.jsonl'), root)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
