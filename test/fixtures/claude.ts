/**
 * Builds synthetic Claude Code transcript lines that mirror the real record shapes
 * (verified against Claude Code 2.1.x transcripts) without containing any real user data.
 */
type Json = Record<string, unknown>;

export const SESSION = '11111111-2222-3333-4444-555555555555';
export const CWD = 'C:\\work\\demo';

export class TranscriptBuilder {
  lines: Json[] = [];
  private n = 0;
  private t = Date.parse('2026-10-29T10:00:00.000Z');
  private last: string | null = null;
  private prompt = '';

  constructor(private agentId?: string, private session = SESSION) {}

  private base(type: string): Json {
    this.t += 1000;
    // Real record uuids are unique across sessions; a second fixture session must not collide with the demo one.
    const uuid = `${this.session === SESSION ? '' : `${this.session}-`}${this.agentId ?? 'm'}-${String(++this.n).padStart(4, '0')}`;
    const rec: Json = {
      parentUuid: this.last, isSidechain: Boolean(this.agentId), type, uuid,
      timestamp: new Date(this.t).toISOString(), userType: 'external', entrypoint: 'cli',
      cwd: CWD, sessionId: this.session, version: '2.1.251', gitBranch: 'main',
      ...(this.agentId ? { agentId: this.agentId } : {}),
    };
    this.last = uuid;
    return rec;
  }

  userPrompt(text: string, origin = 'human') {
    this.prompt = `p-${this.n + 1}`;
    this.lines.push({ ...this.base('user'), promptId: this.prompt, origin: { kind: origin }, message: { role: 'user', content: text } });
    return this;
  }

  thinking(ms: number) {
    this.lines.push({ ...this.base('assistant'), thinkingDurationMs: ms, message: { id: `msg-${this.n}`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: 'SECRET INTERNAL REASONING', signature: 'sig' }], stop_reason: null, usage: {} } });
    return this;
  }

  text(text: string, stop: 'end_turn' | null = null) {
    this.lines.push({ ...this.base('assistant'), message: { id: `msg-${this.n}`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: stop, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000 } } });
    return this;
  }

  toolUse(id: string, name: string, input: Json) {
    this.lines.push({ ...this.base('assistant'), message: { id: `msg-${this.n}`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 20 } } });
    return this;
  }

  toolResult(id: string, content: string, opts: { isError?: boolean; result?: unknown; permission?: Json } = {}) {
    this.lines.push({
      ...this.base('user'), promptId: this.prompt,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: opts.isError ?? false }] },
      toolUseResult: opts.result ?? content,
      permissionDecision: opts.permission ?? { decision: 'accept', source: 'config', reasonType: 'mode' },
      sourceToolAssistantUUID: 'x',
    });
    return this;
  }

  raw(rec: Json) {
    this.lines.push(rec);
    return this;
  }

  jsonl() {
    return this.lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  }
}

/** A full turn: explore → plan → edit → failing test → repair → passing test → question → subagent → done. */
export function demoSession() {
  const b = new TranscriptBuilder()
    .raw({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-29T10:00:00.000Z', sessionId: SESSION })
    .userPrompt('Fix the failing date parser')
    .thinking(2300)
    .toolUse('t-read', 'Read', { file_path: `${CWD}\\src\\date.ts` })
    .toolResult('t-read', 'export function parse() {}', { result: { type: 'text', file: { filePath: `${CWD}\\src\\date.ts` } } })
    .toolUse('t-grep', 'Grep', { pattern: 'parse\\(', path: CWD })
    .toolResult('t-grep', 'src/date.ts', { result: { mode: 'files_with_matches', numFiles: 1, filenames: ['src/date.ts'] } })
    .toolUse('t-todo', 'TodoWrite', { todos: [{ content: 'Fix parser', status: 'in_progress' }, { content: 'Run tests', status: 'pending' }] })
    .toolResult('t-todo', 'ok')
    .toolUse('t-edit1', 'Edit', { file_path: `${CWD}\\src\\date.ts`, old_string: 'a', new_string: 'b' })
    .toolResult('t-edit1', 'updated', { result: { type: 'update', filePath: `${CWD}\\src\\date.ts`, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-a', '+b', '+c'] }] } })
    .toolUse('t-test1', 'Bash', { command: 'pnpm test', description: 'Run unit tests' })
    .toolResult('t-test1', 'Exit code 1\nFAIL src/date.test.ts', { isError: true, result: 'Error: Exit code 1' })
    .toolUse('t-edit2', 'Edit', { file_path: `${CWD}\\src\\date.ts`, old_string: 'b', new_string: 'd' })
    .toolResult('t-edit2', 'updated', { result: { type: 'update', filePath: `${CWD}\\src\\date.ts`, structuredPatch: [{ lines: ['-b', '+d'] }] } })
    .toolUse('t-test2', 'Bash', { command: 'pnpm test', description: 'Run unit tests' })
    .toolResult('t-test2', 'Tests 4 passed', { result: { stdout: 'Tests 4 passed', stderr: '', interrupted: false } })
    .toolUse('t-env', 'Bash', { command: 'API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz0123 node deploy.js', description: 'Deploy with key' })
    .toolResult('t-env', 'deployed', { result: { stdout: 'deployed', stderr: '', interrupted: false }, permission: { decision: 'accept', source: 'user_temporary', grantScope: 'once' } })
    .toolUse('t-rm', 'Bash', { command: 'rm -rf build', description: 'Clean build dir' })
    .toolResult('t-rm', 'Permission to use Bash has been denied.', { isError: true, permission: { decision: 'reject', source: 'config', reasonType: 'classifier', reasonCode: 'classifier:auto-mode' } })
    .toolUse('t-ask', 'AskUserQuestion', { questions: [{ question: 'Ship it now?' }] })
    .toolResult('t-ask', 'User answered: yes')
    .toolUse('t-agent', 'Agent', { description: 'Review the diff', subagent_type: 'general-purpose', prompt: 'Review' })
    .toolResult('t-agent', 'Looks good', { result: { status: 'completed', agentId: 'a-review', totalDurationMs: 4000 } })
    .raw({ type: 'system', subtype: 'api_error', timestamp: '2026-10-29T10:01:00.000Z', uuid: 'sys-1', sessionId: SESSION, retryAttempt: 1, maxRetries: 10, error: { message: 'overloaded' } })
    .text('Fixed the parser; tests pass.', 'end_turn')
    .raw({ type: 'ai-title', aiTitle: 'Fix date parser', sessionId: SESSION });

  const sub = new TranscriptBuilder('a-review')
    .toolUse('s-read', 'Read', { file_path: `${CWD}\\src\\date.ts` })
    .toolResult('s-read', 'contents');

  return { main: b, sub };
}
