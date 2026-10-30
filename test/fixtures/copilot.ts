/**
 * Builds synthetic Copilot CLI session logs that mirror the real record shapes (verified against Copilot CLI 1.0.75
 * sessions and the CLI's own session-events schema) without containing any real user data.
 */
type Json = Record<string, unknown>;

export const COPILOT_SESSION = '0c0p1107-0000-4000-8000-00000000c0b1';
export const COPILOT_CWD = 'C:\\work\\notes';
export const at = (rel: string) => `${COPILOT_CWD}\\${rel.replace(/\//g, '\\')}`;

export class CopilotLogBuilder {
  lines: Json[] = [];
  private t = Date.parse('2026-10-29T09:00:00.000Z');
  private n = 0;
  private interaction = '';
  private turn = 0;
  private shell = 0;

  constructor(private id = COPILOT_SESSION, version = '1.0.75') {
    this.rec('session.start', {
      sessionId: id, version: 1, producer: 'copilot-agent', copilotVersion: version, startTime: new Date(this.t).toISOString(),
      selectedModel: 'gpt-6-luna', context: { cwd: COPILOT_CWD, gitRoot: COPILOT_CWD, branch: 'feature/tags', repository: 'me/notes' }, alreadyInUse: false,
    });
  }

  private rec(type: string, data: Json, ms = 1000) {
    this.t += ms;
    const id = `${this.id.slice(0, 8)}-e${++this.n}`;
    this.lines.push({ type, data, id, timestamp: new Date(this.t).toISOString(), parentId: this.n > 1 ? `${this.id.slice(0, 8)}-e${this.n - 1}` : null });
    return this;
  }
  private get turnId() { return String(this.turn); }

  prompt(text: string, extra: Json = {}) {
    this.interaction = `int-${this.n + 1}`;
    this.rec('system.message', { role: 'system', content: 'SYSTEM PROMPT', interactionId: this.interaction });
    return this.rec('user.message', { content: text, transformedContent: `<context>${text}</context>`, attachments: [], delivery: 'idle', interactionId: this.interaction, ...extra });
  }

  /** One model call: optional reasoning and text, then the tools it requests (run with `tool`). */
  modelCall(text = '', reasoning = true) {
    this.rec('assistant.turn_start', { turnId: String(++this.turn), interactionId: this.interaction });
    return this.rec('assistant.message', {
      messageId: `m${this.n}`, content: text, toolRequests: [], interactionId: this.interaction, turnId: this.turnId, model: 'gpt-6-luna',
      ...(reasoning ? { reasoningText: 'SECRET COPILOT REASONING', reasoningOpaque: 'opaque', encryptedContent: 'enc' } : {}),
    });
  }
  endModelCall() { return this.rec('assistant.turn_end', { turnId: this.turnId }); }

  start(callId: string, toolName: string, args: unknown, extra: Json = {}) {
    return this.rec('tool.execution_start', { toolCallId: callId, toolName, arguments: args, turnId: this.turnId, model: 'gpt-6-luna', ...extra });
  }
  complete(callId: string, success: boolean, content: string, extra: Json = {}) {
    return this.rec('tool.execution_complete', {
      toolCallId: callId, success, interactionId: this.interaction, turnId: this.turnId, model: 'gpt-6-luna',
      ...(success ? { result: { content, detailedContent: content } } : { error: { message: content, code: 'failure' } }), ...extra,
    });
  }

  /** A permission request and Copilot's decision on it. */
  permission(req: string, request: Json, result: Json, decisionSource?: string) {
    this.rec('permission.requested', { requestId: req, permissionRequest: request, promptRequest: request, permissionMode: 'manual', agentMode: 'interactive' });
    return this.decision(req, result, decisionSource);
  }
  ask(req: string, request: Json) {
    return this.rec('permission.requested', { requestId: req, permissionRequest: request, promptRequest: request, permissionMode: 'manual', agentMode: 'interactive' });
  }
  decision(req: string, result: Json, decisionSource?: string) {
    return this.rec('permission.completed', { requestId: req, result, ...(decisionSource ? { decisionSource } : {}), toolCallId: undefined }, 50);
  }

  /** A synchronous shell call that finished with `exit`. */
  shellRun(callId: string, command: string, exit: number, out = '', description?: string) {
    const shellId = this.shell++;
    this.start(callId, 'powershell', { command, description, mode: 'sync', initial_wait: 60 });
    return this.complete(callId, true, `${out}\n<shellId: ${shellId} completed with exit code ${exit}>`, { shellExecution: { exitCode: exit } });
  }
  /** A shell call still running when Copilot stopped waiting; returns its shell id. */
  shellTimeout(callId: string, command: string) {
    const shellId = this.shell++;
    this.start(callId, 'powershell', { command, description: 'Start the dev server', mode: 'sync', initial_wait: 30 });
    this.complete(callId, true, `listening on :3000\n<command with shellId: ${shellId} is still running after 30 seconds. The command is still running. Use stop_powershell to stop it.>`);
    return shellId;
  }

  raw(type: string, data: Json) { return this.rec(type, data); }
  jsonl() { return this.lines.map(l => JSON.stringify(l)).join('\n') + '\n'; }
}

const PATCH = `*** Begin Patch\n*** Update File: ${at('src/notes.ts')}\n@@\n export function save(note) {\n-  db.put(note);\n+  db.put({ ...note, tags: note.tags ?? [] });\n+  index(note);\n }\n*** End Patch`;

/**
 * One interaction: explore, plan in the todo table, edit three ways (patch, edit, create), a failing then passing
 * test, a background server, a question, a blocked command, a subagent, an MCP call — then a final answer.
 */
export function copilotSession() {
  const b = new CopilotLogBuilder();
  b.prompt('Add tags to notes')
    .modelCall('Let me look at the notes module.')
    .start('c-view', 'view', { path: at('src/notes.ts') })
    .permission('r-view', { kind: 'read', path: at('src/notes.ts'), intention: 'Read file', toolCallId: 'c-view' }, { kind: 'approved' }, 'host_policy')
    .complete('c-view', true, '1. export function save(note) {')
    .start('c-rg', 'rg', { pattern: 'save\\(', paths: [at('src')], output_mode: 'content', '-n': true })
    .complete('c-rg', true, 'src/notes.ts:1:export function save(note) {')
    .endModelCall()
    .modelCall()
    .start('c-todo', 'sql', { description: 'Track tagging work', query: "INSERT INTO todos (id, title, description, status) VALUES ('schema', 'Store tags', 'Add tags to the note record', 'in_progress'), ('ui', 'Show tags', 'Render tags, then style them', 'pending');" })
    .complete('c-todo', true, '2 row(s) inserted.')
    .start('c-patch', 'apply_patch', PATCH)
    .permission('r-patch', { kind: 'write', fileName: at('src/notes.ts'), diff: '...', intention: 'Edit file', canOfferSessionApproval: true, toolCallId: 'c-patch' }, { kind: 'approved' }, 'human_response')
    .complete('c-patch', true, `Modified 1 file(s): ${at('src/notes.ts')}`, { fileEdits: [{ kind: 'update', path: at('src/notes.ts') }] })
    .start('c-edit', 'edit', { path: at('src/tags.ts'), old_str: 'export const TAGS = [];', new_str: 'export const TAGS: string[] = [];\nexport const MAX_TAGS = 8;' })
    .complete('c-edit', true, 'File edited.')
    .start('c-create', 'create', { path: at('tests/tags.test.ts'), file_text: "import { TAGS } from '../src/tags';\ntest('empty', () => expect(TAGS).toEqual([]));\n" })
    .complete('c-create', true, 'Created file.')
    .endModelCall()
    .modelCall('Running the tests.', false)
    .shellRun('c-test1', 'npx vitest run', 1, ' FAIL  tests/tags.test.ts\n Tests  1 failed (1)', 'Run the test suite')
    .start('c-fix', 'edit', { path: at('src/tags.ts'), old_str: 'export const MAX_TAGS = 8;', new_str: 'export const MAX_TAGS = 8; // per note' })
    .complete('c-fix', true, 'File edited.')
    .shellRun('c-test2', "& 'C:\\nodejs\\npx.cmd' vitest run", 0, ' Tests  1 passed (1)', 'Run the test suite again');
  const server = b.shellTimeout('c-server', 'npm run dev');
  b.start('c-todo2', 'sql', { description: 'Advance tagging work', query: "UPDATE todos SET status = 'done', updated_at = CURRENT_TIMESTAMP WHERE id = 'schema'; UPDATE todos SET status = 'in_progress' WHERE id IN ('ui')" })
    .complete('c-todo2', true, '1 row(s) updated.')
    .endModelCall()
    .modelCall()
    .start('c-ask', 'ask_user', { question: 'Should tags be case-sensitive?', choices: ['Yes', 'No'] })
    .complete('c-ask', true, 'User selected: No')
    .start('c-rm', 'powershell', { command: 'Remove-Item -Recurse -Force build', description: 'Clean the build folder', mode: 'sync' })
    .permission('r-rm', { kind: 'shell', fullCommandText: 'Remove-Item -Recurse -Force build', intention: 'Clean the build folder', commands: [{ identifier: 'Remove-Item', readOnly: false }], possiblePaths: [], possibleUrls: [], hasWriteFileRedirection: false, canOfferSessionApproval: true, toolCallId: 'c-rm' }, { kind: 'denied-interactively-by-user', feedback: 'keep the build' }, 'human_response')
    .complete('c-rm', false, 'The user rejected this tool call. User feedback: keep the build')
    .start('c-read-server', 'read_powershell', { shellId: String(server), delay: 5 })
    .complete('c-read-server', true, `ready\n<shellId: ${server} completed with exit code 0>`)
    .endModelCall()
    .modelCall()
    .start('c-task', 'task', { description: 'Review the tagging change', prompt: 'Review src/notes.ts for bugs', agent_type: 'code-review' })
    .raw('subagent.started', { toolCallId: 'c-task', agentName: 'code-review', agentDisplayName: 'Code Review', agentDescription: 'Reviews changes' })
    .start('c-sub-view', 'view', { path: at('src/notes.ts') }, { parentToolCallId: 'c-task' })
    .complete('c-sub-view', true, '1. export function save(note) {', { parentToolCallId: 'c-task' })
    .raw('assistant.message', { messageId: 'sub-m', content: 'No issues found.', toolRequests: [], parentToolCallId: 'c-task', turnId: 'sub-1' })
    .raw('subagent.completed', { toolCallId: 'c-task', agentName: 'code-review', agentDisplayName: 'Code Review', durationMs: 4000, totalToolCalls: 1, totalTokens: 900 })
    .complete('c-task', true, 'No issues found.')
    .start('c-mcp', 'github-mcp-server-list_issues', { owner: 'me', repo: 'notes' }, { mcpServerName: 'github-mcp-server', mcpToolName: 'list_issues' })
    .complete('c-mcp', true, '[]')
    .endModelCall()
    .modelCall('Tags are stored and shown; tests pass.')
    .endModelCall();
  return b;
}

/**
 * The session above, then a second prompt whose command waits for your approval: `seed` ends with the open request,
 * `answer` is your decision and the rest of the turn.
 */
export function copilotLive(): { seed: string; answer: string } {
  const lines = copilotLiveSession().jsonl().split('\n').filter(Boolean);
  const cut = lines.findIndex(l => l.includes('"requestId":"r-clean"')) + 1;
  return { seed: lines.slice(0, cut).join('\n') + '\n', answer: lines.slice(cut).join('\n') + '\n' };
}

function copilotLiveSession() {
  return copilotSession()
    .prompt('Remove the old build output')
    .modelCall('', false)
    .start('c-clean', 'powershell', { command: 'Remove-Item -Recurse -Force dist', description: 'Remove the old build output', mode: 'sync' })
    .ask('r-clean', { kind: 'shell', fullCommandText: 'Remove-Item -Recurse -Force dist', intention: 'Remove the old build output', toolCallId: 'c-clean' })
    .decision('r-clean', { kind: 'approved' }, 'human_response')
    .complete('c-clean', true, '<shellId: 9 completed with exit code 0>', { shellExecution: { exitCode: 0 } })
    .endModelCall()
    .modelCall('Removed dist.', false)
    .endModelCall();
}
