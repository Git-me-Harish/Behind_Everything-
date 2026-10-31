import path from 'node:path';
import { classifyShell, readTargets } from '../../core/classify.js';
import { clip, redactValue, truncate, type Redaction } from '../../core/redact.js';
import type { CanonicalEvent, EventKind, Resource, SessionInfo, Status } from '../../core/schema.js';
import { clipLine, lineCount, MAX_PATCH_LINES, oneLine, parsePatch, patchFromContent, relativeTo } from '../shared.js';

export const ADAPTER = { name: 'copilot-log', version: '1', capture: 'log' } as const;

/**
 * Copilot CLI writes one typed event per line to `session-state/<id>/events.jsonl`, the same stream its SDK
 * exposes (`session-events.schema.json` ships with the CLI). Streaming deltas, idle and title events are ephemeral
 * and never reach the file. A Copilot "turn" is one model call, so a user interaction (our turn) runs from the
 * prompt to the first model call that requests no tools.
 */

/** Persisted events with nothing for us; anything else unknown is surfaced as `system.unknown` (format drift). */
const IGNORED = new Set([
  'system.message', 'system.notification', 'session.auto_mode_resolved', 'session.usage_checkpoint', 'session.remote_steerable_changed',
  'session.schedule_created', 'session.schedule_cancelled', 'session.schedule_rearmed', 'session.autopilot_objective_changed',
  'session.info', 'session.warning', 'session.mode_changed', 'session.session_limits_changed', 'session.permissions_changed',
  'session.plan_changed', 'session.workspace_file_changed', 'session.handoff', 'session.binary_asset', 'session.task_complete',
  'session.canvas.recorded', 'session.canvas.removed', 'session.compaction_start',
  'hook.start', 'hook.end', 'skill.invoked', 'skill.invoked_ref', 'skill.context_delivered_ref',
  // Client-side tools (VS Code) are also reported as ordinary tool executions.
  'external_tool.requested', 'external_tool.completed', 'tool.user_requested',
  // Picking a custom agent for the main session, not a subagent.
  'subagent.selected', 'subagent.deselected',
]);

const SHELL_TOOLS = new Set(['bash', 'powershell']);
/** read_powershell, write_bash…: report on a shell started earlier, never activities themselves. */
const SHELL_PLUMBING = /^(read|write|stop|list)_(bash|powershell)$/;
const QUIET_TOOLS = new Set(['report_intent', 'read_agent', 'list_agents', 'write_agent']);
/** Trailers Copilot appends to shell output: `<shellId: 3 completed with exit code 0>`, `<command with shellId: 3 is still running…>`. */
const SHELL_DONE = /shellId: (\S+) completed with exit code (-?\d+)/;
const SHELL_RUNNING = /shellId: (\S+) is still running/;

type Json = Record<string, any>;

interface Call {
  kind: EventKind;
  tool: string;
  ts: string;
  agent: string;
  summary: string;
  resources: Resource[];
  shell?: boolean;
  file?: { path: string; added: number; removed: number; patch: string[]; op: string };
}

interface Outcome {
  status: Status;
  exit_code?: number;
  output?: string;
  payload?: Json;
  source_class?: 'observed' | 'inferred';
  error_category?: CanonicalEvent['error_category'];
}

interface Permission { call?: string; agent: string; summary: string; line: number; ts: string; surfaced: boolean; intention?: string }

/**
 * Stateful parser for one Copilot session log. Feed lines in order; call `idle()` whenever everything written so
 * far has been read. Event ids come from Copilot's own ids, so re-reading a file never duplicates an event.
 */
export function createCopilotParser(file: string) {
  let session: SessionInfo | undefined;
  let turnId: string | undefined;
  let turnOpen = false;
  /** The last model call ended without asking for tools or saying anything: an error usually follows. */
  let stalled = false;
  let lastTs = new Date(0).toISOString();
  let lineNo = 0;
  let out: CanonicalEvent[] = [];
  const calls = new Map<string, Call>();
  const done = new Set<string>();
  /** apply_patch: one activity per file, by call id. */
  const patches = new Map<string, string[]>();
  /** Shells still running after the call returned, by shell id. */
  const shells = new Map<string, string>();
  const denied = new Set<string>();
  /** Subagents whose own start/finish records arrived: those, not the task tool's return, end them. */
  const subagents = new Set<string>();
  /** Tool calls and messages per model call (Copilot turn id), to spot the call that ends the interaction. */
  const modelCalls = new Map<string, { tools: number; messages: number }>();
  const reasoned = new Set<string>();
  const permissions = new Map<string, Permission>();
  const todos = new Map<string, { text: string; status: string }>();

  const rel = (p: string) => relativeTo(session?.cwd, p);
  const native = () => session?.native_id ?? path.basename(path.dirname(file));

  const ev = (suffix: string, e: Omit<CanonicalEvent, 'id' | 'session_id' | 'agent_id' | 'ts' | 'assistant' | 'adapter' | 'source_class'> & Partial<CanonicalEvent>): CanonicalEvent => {
    const redactions: Redaction[] = [];
    const summary = redactValue(e.summary, 'summary', redactions);
    const payload = e.payload && redactValue(e.payload, 'payload', redactions);
    const resources = e.resources && redactValue(e.resources, 'resources', redactions);
    return {
      id: `cp:${native()}:${suffix}`,
      session_id: session?.id ?? `copilot-cli:${native()}`,
      turn_id: turnId,
      agent_id: 'main',
      ts: lastTs,
      assistant: 'copilot-cli',
      adapter: ADAPTER,
      source_class: 'observed',
      evidence: { file, line: lineNo },
      ...e,
      summary, payload, resources,
      ...(redactions.length ? { redactions } : {}),
    };
  };
  const emit = (suffix: string, e: Parameters<typeof ev>[1]) => { out.push(ev(suffix, e)); };

  // ── calls ──

  const open = (id: string, c: Call, payload?: Json) => {
    calls.set(id, c);
    emit(`${id}:call`, {
      kind: c.kind, actor: 'assistant', tool: c.tool, status: c.kind === 'user.question' ? 'pending' : 'started', resources: c.resources,
      summary: c.summary, payload, agent_id: c.agent, correlation: { call_id: id },
    });
  };

  const finish = (id: string, r: Outcome) => {
    const c = calls.get(id);
    if (!c || done.has(id)) return;
    done.add(id);
    calls.delete(id);
    const payload: Json = { ...(r.output ? { output: clip(r.output) } : {}), ...r.payload };
    if (c.file && r.status === 'succeeded') Object.assign(payload, { op: c.file.op, added: c.file.added, removed: c.file.removed, ...(c.file.patch.length ? { patch: c.file.patch } : {}) });
    emit(`${id}:result`, {
      kind: c.kind === 'subagent.start' ? 'subagent.end' : c.kind, actor: 'tool', tool: c.tool, status: r.status, resources: c.resources, summary: c.summary,
      payload, source_class: r.source_class ?? 'observed', agent_id: c.agent,
      duration_ms: Math.max(0, Date.parse(lastTs) - Date.parse(c.ts)), exit_code: r.exit_code,
      error_category: r.error_category ?? (r.status !== 'failed' ? undefined : c.kind === 'test.run' ? 'test_failure' : c.kind === 'build.run' ? 'build_error' : 'tool_error'),
      correlation: { call_id: id },
    });
  };

  const call = (agent: string, kind: EventKind, tool: string, summary: string, resources: Resource[], extra: Partial<Call> = {}): Call =>
    ({ kind, tool, ts: lastTs, agent, summary, resources, ...extra });

  const startTool = (d: Json) => {
    const id = String(d.toolCallId);
    const name = String(d.toolName);
    const agent = typeof d.parentToolCallId === 'string' ? d.parentToolCallId : 'main';
    const args: Json = d.arguments && typeof d.arguments === 'object' ? d.arguments : { input: d.arguments };
    if (calls.has(id) || done.has(id) || QUIET_TOOLS.has(name) || SHELL_PLUMBING.test(name)) return;
    if (d.mcpServerName) {
      const tool = String(d.mcpToolName ?? name);
      return open(id, call(agent, 'mcp.call', name, `${d.mcpServerName} · ${tool}`, [{ type: 'mcp', ref: `${d.mcpServerName}/${tool}` }]), { input: shallow(args) });
    }
    if (SHELL_TOOLS.has(name)) {
      const command = String(args.command ?? '');
      const kind = classifyShell(command);
      const reads = kind === 'file.read' ? readTargets(command).map(rel) : [];
      return open(id, call(agent, kind, name,
        reads.length ? `Read ${reads.join(', ')}` : kind === 'file.search' ? `Search: ${oneLine(command, 120)}` : oneLine(String(args.description || command), 140),
        reads.length ? reads.map(ref => ({ type: 'file' as const, ref })) : [{ type: 'command', ref: truncate(command, 500) }], { shell: true }),
      { command: truncate(command, 2000), description: args.description, mode: args.mode });
    }
    const target = rel(String(args.path ?? ''));
    switch (name) {
      case 'view': case 'show_file':
        return open(id, call(agent, 'file.read', name, `Read ${target}`, [{ type: 'file', ref: target }]), { view_range: args.view_range });
      case 'create': {
        const text = String(args.file_text ?? '');
        return open(id, call(agent, 'file.edit', name, `Create ${target}`, [{ type: 'file', ref: target }], { file: { path: target, op: 'add', added: lineCount(text), removed: 0, patch: patchFromContent(text) } }));
      }
      case 'edit':
        return open(id, call(agent, 'file.edit', name, `Edit ${target}`, [{ type: 'file', ref: target }], { file: { path: target, op: 'update', ...replaceDiff(String(args.old_str ?? ''), String(args.new_str ?? '')) } }));
      case 'str_replace_editor':
        if (args.command === 'view') return startTool({ ...d, toolName: 'view' });
        if (args.command === 'create') return startTool({ ...d, toolName: 'create' });
        return startTool({ ...d, toolName: 'edit', arguments: { ...args, old_str: args.old_str ?? '', new_str: args.new_str ?? args.insert_text ?? '' } });
      case 'apply_patch': {
        const files = parsePatch(String(args.input ?? args.patch ?? ''));
        patches.set(id, files.map((f, i) => {
          const sub = files.length === 1 ? id : `${id}#${i}`;
          const ref = rel(f.path);
          open(sub, call(agent, 'file.edit', name, `${f.op === 'add' ? 'Create' : f.op === 'delete' ? 'Delete' : 'Edit'} ${ref}`, [{ type: 'file', ref }], { file: { ...f, path: ref } }));
          return sub;
        }));
        return;
      }
      case 'rg': case 'grep': case 'glob': {
        const where = [args.paths ?? args.path].flat().filter(Boolean).map(p => rel(String(p))).join(', ');
        const what = name === 'glob' ? `Find ${args.pattern}` : `Search "${oneLine(String(args.pattern ?? ''), 80)}"`;
        return open(id, call(agent, 'file.search', name, where ? `${what} in ${where}` : what, [{ type: 'tool', ref: name }]), { pattern: args.pattern, glob: args.glob });
      }
      case 'ask_user':
        return open(id, call(agent, 'user.question', name, oneLine(String(args.question ?? 'Question'), 160), [{ type: 'tool', ref: name }]), { question: truncate(String(args.question ?? ''), 1000), choices: args.choices });
      case 'task':
        return open(id, call(agent, 'subagent.start', name, `Subagent: ${oneLine(String(args.description ?? args.name ?? args.agent_type ?? 'task'), 100)}`, [{ type: 'tool', ref: name }]),
          { description: args.description ?? args.name, subagent_type: args.agent_type, prompt: truncate(String(args.prompt ?? ''), 1000) });
      case 'web_fetch':
        return open(id, call(agent, 'web.fetch', name, `Fetch ${oneLine(String(args.url ?? ''), 120)}`, [{ type: 'url', ref: String(args.url ?? '') }]));
      case 'web_search':
        return open(id, call(agent, 'web.fetch', name, `Search web "${oneLine(String(args.query ?? ''), 80)}"`, [{ type: 'url', ref: String(args.query ?? '') }]), { query: args.query });
      case 'sql': {
        const plan = applyTodoSql(String(args.query ?? ''), todos);
        if (plan) {
          const list = [...todos.values()];
          return open(id, call(agent, 'plan.update', name, `Plan ${list.filter(t => t.status === 'completed').length}/${list.length} done`, [{ type: 'tool', ref: name }]), { todos: list });
        }
        return open(id, call(agent, 'tool.call', name, `SQL: ${oneLine(String(args.description || args.query || ''), 120)}`, [{ type: 'tool', ref: name }]), { query: truncate(String(args.query ?? ''), 1000) });
      }
      case 'exit_plan_mode':
        return open(id, call(agent, 'plan.update', name, 'Plan proposed', [{ type: 'tool', ref: name }]), { proposal: true, summary: truncate(String(args.summary ?? ''), 2000) });
      case 'skill':
        return open(id, call(agent, 'tool.call', name, `Skill: ${args.skill ?? ''}`, [{ type: 'tool', ref: name }]));
      case 'runTests': {
        const files = (Array.isArray(args.files) ? args.files : []).map((f: unknown) => rel(String(f)));
        return open(id, call(agent, 'test.run', name, files.length ? `Run tests in ${files.join(', ')}` : 'Run tests', [{ type: 'tool', ref: name }]), { files });
      }
      default:
        return open(id, call(agent, 'tool.call', name, d.toolTitle ? `${name}: ${oneLine(String(d.toolTitle), 100)}` : name, [{ type: 'tool', ref: name }]), { input: shallow(args) });
    }
  };

  const finishTool = (d: Json) => {
    const id = String(d.toolCallId);
    const text = String(d.result?.content ?? d.error?.message ?? '');
    // A report on an earlier shell (read_powershell…) may carry its exit code.
    const report = SHELL_DONE.exec(text);
    if (report && shells.has(report[1]!) && !calls.get(id)?.shell) {
      const owner = shells.get(report[1]!)!;
      shells.delete(report[1]!);
      const exit = Number(report[2]);
      finish(owner, { status: exit === 0 ? 'succeeded' : 'failed', exit_code: exit, output: text });
    }
    const subs = patches.get(id);
    if (subs) {
      patches.delete(id);
      for (const s of subs) finish(s, outcome(id, d, text));
      return;
    }
    const c = calls.get(id);
    if (!c) return;
    if (c.kind === 'subagent.start' && subagents.has(id)) return;
    if (c.shell) {
      const exit = shellExit(d, text);
      const running = SHELL_RUNNING.exec(text);
      if (exit === undefined && running && d.success !== false) return void shells.set(running[1]!, id);
      return finish(id, { ...outcome(id, d, text), ...(exit !== undefined ? { status: exit === 0 ? 'succeeded' : 'failed', exit_code: exit } : {}) });
    }
    finish(id, { ...outcome(id, d, text), ...(c.kind === 'subagent.start' ? { payload: { agent_id: id } } : {}) });
  };

  const outcome = (id: string, d: Json, text: string): Outcome => ({
    status: d.success === false ? 'failed' : 'succeeded',
    output: text,
    error_category: d.success === false && denied.has(id) ? 'permission_denied' : undefined,
  });

  // ── permissions ──

  const ask = (requestId: string, p: Permission) => {
    p.surfaced = true;
    out.push({
      ...ev(`${requestId}:ask`, {
        kind: 'permission.decision', actor: 'assistant', status: 'pending', summary: `Waiting for approval: ${p.summary}`, agent_id: p.agent,
        payload: { request_id: requestId, intention: p.intention }, ...(p.call ? { correlation: { call_id: p.call } } : {}),
      }),
      ts: p.ts, evidence: { file, line: p.line },
    });
  };

  const decide = (requestId: string, d: Json) => {
    const p = permissions.get(requestId);
    if (!p) return;
    permissions.delete(requestId);
    const kind = String(d.result?.kind ?? '');
    const approved = kind.startsWith('approved');
    const byUser = d.decisionSource === 'human_response' || kind === 'approved-for-session' || kind === 'approved-for-location' || kind === 'denied-interactively-by-user';
    if (!approved && kind !== 'cancelled' && p.call) denied.add(p.call);
    // Routine approvals by Copilot's own policy are not shown, like Claude Code's auto-accepts.
    if (approved && !byUser && !p.surfaced) return;
    if (kind === 'cancelled' && !p.surfaced) return;
    const verdict = DECISION[kind] ?? (approved ? 'Approved' : 'Blocked');
    emit(`${requestId}:decision`, {
      kind: 'permission.decision', actor: byUser ? 'user' : 'system', agent_id: p.agent,
      status: approved ? 'succeeded' : kind === 'cancelled' ? 'cancelled' : 'failed',
      summary: `${approved && !byUser ? 'Approved automatically' : verdict}: ${p.summary}`,
      payload: {
        request_id: requestId, decision: approved ? 'accept' : kind === 'cancelled' ? 'cancel' : 'reject', reason: kind,
        source: byUser ? 'you' : d.decisionSource === 'host_policy' ? 'policy' : kind.startsWith('denied-by-') ? kind.slice('denied-by-'.length) : d.decisionSource,
        feedback: d.result?.feedback, intention: p.intention,
      },
      ...(p.call ? { correlation: { call_id: p.call } } : {}),
    });
  };

  // ── turns ──

  const startTurn = (id: string, actor: 'user' | 'system') => {
    if (turnOpen) endTurn('succeeded', 'inferred');
    turnId = id;
    turnOpen = true;
    stalled = false;
    emit(`${id}:turn-start`, { kind: 'turn.start', actor, summary: 'Turn started' });
  };

  /** Closes the interaction; calls Copilot never reported on are closed with it, outcome unknown. */
  const endTurn = (status: Status, source: 'observed' | 'inferred', error?: string) => {
    for (const [id, c] of calls) if (!(c.shell && [...shells.values()].includes(id))) {
      finish(id, { status: status === 'succeeded' ? 'cancelled' : status, source_class: 'inferred', payload: { note: 'Copilot did not record how this ended; the turn finished' } });
    }
    for (const [req, p] of permissions) if (p.surfaced) decide(req, { result: { kind: 'cancelled' } });
    permissions.clear();
    if (!turnOpen) return;
    turnOpen = false;
    stalled = false;
    emit(`${turnId}:turn-end`, {
      kind: 'turn.end', actor: status === 'cancelled' ? 'user' : 'assistant', status, source_class: source,
      summary: status === 'cancelled' ? 'Turn interrupted' : status === 'failed' ? 'Turn failed' : 'Turn complete',
      ...(status === 'cancelled' ? { error_category: 'interrupted' } : {}), ...(error ? { payload: { error } } : {}),
    });
  };

  /** The session process went away (quit, crash, resume elsewhere): background shells died with it. */
  const endProcess = () => {
    for (const id of shells.values()) finish(id, { status: 'cancelled', source_class: 'inferred', payload: { note: 'The Copilot session ended while this was still running' } });
    shells.clear();
    if (turnOpen) endTurn('cancelled', 'inferred');
  };

  function parse(line: string, n: number): CanonicalEvent[] {
    let o: Json;
    try { o = JSON.parse(line); } catch { return []; }
    if (!o || typeof o !== 'object' || typeof o.type !== 'string') return [];
    lineNo = n;
    out = [];
    if (typeof o.timestamp === 'string') lastTs = o.timestamp;
    const d: Json = o.data && typeof o.data === 'object' ? o.data : {};
    const id = String(o.id ?? `${path.basename(file)}:${n}`);
    if (d.model && session) session.model = d.model;

    switch (o.type) {
      case 'session.start': {
        if (session) break;
        const version = d.copilotVersion && d.copilotVersion !== '0.0.0' ? String(d.copilotVersion) : undefined;
        session = {
          id: `copilot-cli:${d.sessionId ?? native()}`, assistant: 'copilot-cli', native_id: String(d.sessionId ?? native()), source_path: file,
          started_at: d.startTime ?? lastTs, last_ts: lastTs, version, model: d.selectedModel,
        };
        context(d.context);
        emit('session-start', { kind: 'session.start', actor: 'system', summary: 'Session started', ts: d.startTime ?? lastTs, payload: { producer: d.producer } });
        break;
      }
      case 'session.resume':
        endProcess();
        context(d.context);
        if (session && d.selectedModel) session.model = d.selectedModel;
        break;
      case 'session.shutdown': endProcess(); break;
      case 'session.context_changed': context(d); break;
      case 'session.model_change': if (session && d.newModel) session.model = d.newModel; break;
      case 'session.error':
        emit(`err:${id}`, { kind: 'system.error', actor: 'system', status: 'failed', summary: oneLine(`${d.errorType ?? 'Error'}: ${d.message ?? ''}`, 200), payload: { type: d.errorType, code: d.errorCode, status: d.statusCode } });
        if (turnOpen && stalled) endTurn('failed', 'observed', truncate(String(d.message ?? ''), 500));
        break;
      case 'session.compaction_complete':
        if (d.success !== false) emit(`compact:${id}`, { kind: 'session.compaction', actor: 'system', summary: 'Context compacted', payload: { tokens_before: d.preCompactionTokens, tokens_after: d.postCompactionTokens } });
        break;
      case 'session.truncation':
        emit(`compact:${id}`, { kind: 'session.compaction', actor: 'system', summary: 'Context truncated', payload: { tokens_removed: d.tokensRemovedDuringTruncation } });
        break;
      case 'user.message': {
        if (d.source) break; // injected by a skill or extension, hidden in Copilot's own timeline too
        const steering = (d.delivery === 'steering' || d.delivery === 'queued') && turnOpen;
        if (!steering) startTurn(String(d.interactionId ?? id), d.isAutopilotContinuation ? 'system' : 'user');
        const text = String(d.content ?? '').trim();
        if (!text || d.isAutopilotContinuation) break;
        const attachments = (Array.isArray(d.attachments) ? d.attachments : []).map((a: Json) => String(a.displayName ?? a.path ?? a.type));
        emit(`${id}:prompt`, { kind: 'user.prompt', actor: 'user', summary: oneLine(text), payload: { text: truncate(text), ...(attachments.length ? { attachments } : {}), ...(steering ? { delivery: d.delivery } : {}) } });
        if (session && !session.title) {
          session.title = oneLine(text, 80);
          emit('title', { kind: 'session.meta', actor: 'system', summary: session.title, payload: { title: session.title } });
        }
        break;
      }
      case 'assistant.turn_start':
        if (!turnOpen) startTurn(String(d.interactionId ?? d.turnId ?? id), 'system');
        modelCalls.set(String(d.turnId), { tools: 0, messages: 0 });
        break;
      case 'assistant.turn_end': {
        const m = modelCalls.get(String(d.turnId));
        modelCalls.delete(String(d.turnId));
        const delegating = [...calls.values()].some(c => c.kind === 'subagent.start');
        if (!m || m.tools || delegating || !turnOpen) break;
        if (m.messages) endTurn('succeeded', 'observed');
        else stalled = true;
        break;
      }
      case 'assistant.message': {
        const agent = typeof d.parentToolCallId === 'string' ? d.parentToolCallId : 'main';
        const text = String(d.content ?? '').trim();
        const m = modelCalls.get(String(d.turnId));
        if (m && agent === 'main' && text) m.messages++;
        // That reasoning happened, once per model call, never its content.
        const key = `${agent}:${d.turnId ?? id}`;
        if ((d.reasoningText || d.reasoningOpaque || d.reasoningBlocks) && !reasoned.has(key)) {
          reasoned.add(key);
          emit(`rs:${id}`, { kind: 'assistant.reasoning', actor: 'assistant', summary: 'Reasoning', agent_id: agent, payload: { content: 'unavailable' } });
        }
        if (text) emit(`msg:${d.messageId ?? id}`, { kind: 'assistant.message', actor: 'assistant', summary: oneLine(text), agent_id: agent, payload: { text: truncate(text) } });
        break;
      }
      case 'assistant.reasoning': {
        const key = `main:${d.reasoningId ?? id}`;
        if (!reasoned.has(key)) {
          reasoned.add(key);
          emit(`rs:${d.reasoningId ?? id}`, { kind: 'assistant.reasoning', actor: 'assistant', summary: 'Reasoning', payload: { content: 'unavailable' } });
        }
        break;
      }
      case 'abort':
        endTurn('cancelled', 'observed');
        break;
      case 'tool.execution_start': {
        const m = modelCalls.get(String(d.turnId));
        if (m && typeof d.parentToolCallId !== 'string') m.tools++;
        startTool(d);
        break;
      }
      case 'tool.execution_complete': finishTool(d); break;
      case 'subagent.started': {
        const tc = String(d.toolCallId);
        subagents.add(tc);
        if (!calls.has(tc) && !done.has(tc)) {
          open(tc, call('main', 'subagent.start', 'task', `Subagent: ${oneLine(String(d.agentDescription || d.agentDisplayName || d.agentName), 100)}`, [{ type: 'tool', ref: String(d.agentName) }]),
            { description: d.agentDisplayName ?? d.agentName, subagent_type: d.agentName });
        }
        break;
      }
      case 'subagent.completed': case 'subagent.failed':
        finish(String(d.toolCallId), {
          status: o.type === 'subagent.completed' ? 'succeeded' : 'failed', output: d.error,
          payload: { agent_id: String(d.toolCallId), duration_ms: d.durationMs, tokens: d.totalTokens, tool_calls: d.totalToolCalls },
        });
        break;
      case 'permission.requested': {
        const req: Json = d.permissionRequest ?? {};
        if (d.resolvedByHook) break;
        const callId = typeof req.toolCallId === 'string' ? req.toolCallId : undefined;
        permissions.set(String(d.requestId), {
          call: callId, agent: (callId && calls.get(callId)?.agent) || 'main', summary: permissionSummary(req, rel),
          line: n, ts: lastTs, surfaced: false, intention: req.intention ? truncate(String(req.intention), 300) : undefined,
        });
        break;
      }
      case 'permission.completed': decide(String(d.requestId), d); break;
      default:
        if (!IGNORED.has(o.type)) emit(`unknown:${id}`, { kind: 'system.unknown', actor: 'system', summary: `Unrecognised record type "${o.type}"`, payload: { type: o.type } });
    }
    if (session) session.last_ts = lastTs;
    return out;
  }

  function context(c: Json | undefined) {
    if (!session || !c) return;
    if (c.cwd) session.cwd = c.cwd;
    if (c.branch) session.git_branch = c.branch;
  }

  /**
   * Called once everything written so far has been read. A permission request still open at that point is one
   * Copilot is waiting on (usually for you), so it is shown as pending until its decision arrives.
   */
  function idle(): CanonicalEvent[] {
    out = [];
    for (const [req, p] of permissions) if (!p.surfaced) ask(req, p);
    return out;
  }

  return { parse, idle, get session() { return session; } };
}

// ── helpers ──────────────────────────────────────────────────────────────────

const DECISION: Record<string, string> = {
  'approved': 'Approved by you',
  'approved-for-session': 'Approved by you for this session',
  'approved-for-location': 'Approved by you for this location',
  'denied-interactively-by-user': 'Blocked by you',
  'denied-by-rules': 'Blocked by your rules',
  'denied-by-content-exclusion-policy': 'Blocked by content exclusion policy',
  'denied-by-permission-request-hook': 'Blocked by a hook',
  'denied-no-approval-rule-and-could-not-request-from-user': 'Blocked: no rule allows it and Copilot could not ask',
  'cancelled': 'Approval prompt cancelled',
};

function permissionSummary(r: Json, rel: (p: string) => string): string {
  switch (r.kind) {
    case 'shell': return `Run ${oneLine(String(r.fullCommandText ?? ''), 120)}`;
    case 'write': return `Edit ${rel(String(r.fileName ?? ''))}`;
    case 'read': return `Read ${rel(String(r.path ?? ''))}`;
    case 'mcp': return `${r.serverName} · ${r.toolTitle ?? r.toolName}`;
    case 'url': return `Fetch ${oneLine(String(r.url ?? ''), 120)}`;
    case 'memory': return `Remember “${oneLine(String(r.fact ?? ''), 80)}”`;
    case 'custom-tool': case 'hook': return String(r.toolName ?? r.kind);
    default: return String(r.kind ?? 'action');
  }
}

/** Exit code of a shell call: the structured field, the result's shell-exit content, or the trailer Copilot appends. */
function shellExit(d: Json, text: string): number | undefined {
  if (typeof d.shellExecution?.exitCode === 'number') return d.shellExecution.exitCode;
  const c = (Array.isArray(d.result?.contents) ? d.result.contents : []).find((x: Json) => (x.type === 'shell_exit' || x.type === 'terminal') && typeof x.exitCode === 'number');
  if (c) return c.exitCode;
  const m = SHELL_DONE.exec(text);
  return m ? Number(m[2]) : undefined;
}

/** An edit's replaced text as diff lines. Copilot does not log line numbers, so the hunk header has none. */
function replaceDiff(before: string, after: string): { added: number; removed: number; patch: string[] } {
  const removed = before ? before.split('\n') : [];
  const added = after ? after.split('\n') : [];
  const patch = ['@@', ...removed.map(l => `-${clipLine(l)}`), ...added.map(l => `+${clipLine(l)}`)].slice(0, MAX_PATCH_LINES);
  return { added: added.length, removed: removed.length, patch };
}

function shallow(args: Json): Json {
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === 'string' ? truncate(v, 500) : v]));
}

// ── todos ────────────────────────────────────────────────────────────────────

const TODO_STATUS: Record<string, string> = { done: 'completed', complete: 'completed', completed: 'completed', in_progress: 'in_progress', pending: 'pending', blocked: 'blocked' };

/**
 * Copilot keeps its todo list in a per-session SQL table and edits it with the `sql` tool. Applies the statements
 * that change `todos` to our copy and reports whether any did. Only statements whose effect is certain are applied:
 * inserts, and updates or deletes that name rows by id.
 */
export function applyTodoSql(sql: string, todos: Map<string, { text: string; status: string }>): boolean {
  let changed = false;
  for (const stmt of splitOutside(sql, ';')) {
    const s = stmt.trim();
    const ins = /^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+todos\s*\(([^)]*)\)\s*VALUES\s*([\s\S]*)$/i.exec(s);
    if (ins) {
      const cols = ins[1]!.split(',').map(c => c.trim().toLowerCase());
      for (const tuple of tuples(ins[2]!)) {
        const row = Object.fromEntries(cols.map((c, i) => [c, tuple[i]]));
        if (!row.id) continue;
        todos.set(row.id, { text: row.title ?? row.description ?? row.id, status: TODO_STATUS[row.status ?? 'pending'] ?? String(row.status) });
        changed = true;
      }
      continue;
    }
    const upd = /^UPDATE\s+todos\s+SET\s+([\s\S]*?)\s+WHERE\s+([\s\S]*)$/i.exec(s);
    if (upd) {
      const ids = whereIds(upd[2]!);
      if (!ids) continue;
      const set = Object.fromEntries(splitOutside(upd[1]!, ',').map(a => {
        const [k, ...v] = a.split('=');
        return [k!.trim().toLowerCase(), literal(v.join('=').trim())];
      }));
      for (const id of ids) {
        const t = todos.get(id);
        if (!t) continue;
        if (set.status !== undefined) t.status = TODO_STATUS[set.status] ?? set.status;
        if (set.title !== undefined) t.text = set.title;
        changed = true;
      }
      continue;
    }
    const del = /^DELETE\s+FROM\s+todos(?:\s+WHERE\s+([\s\S]*))?$/i.exec(s);
    if (del) {
      const ids = del[1] ? whereIds(del[1]) : [...todos.keys()];
      for (const id of ids ?? []) changed = todos.delete(id) || changed;
    }
  }
  return changed;
}

/** `id = 'a'` or `id IN ('a', 'b')` and nothing else; any other condition is not ours to evaluate. */
function whereIds(where: string): string[] | undefined {
  const w = where.trim();
  const eq = /^id\s*=\s*('(?:[^']|'')*')$/i.exec(w);
  if (eq) return [literal(eq[1]!)];
  const list = /^id\s+IN\s*\(([\s\S]*)\)$/i.exec(w);
  return list ? splitOutside(list[1]!, ',').map(v => literal(v.trim())) : undefined;
}

/** `('a', 'b'), ('c', NULL)` → [['a', 'b'], ['c', 'NULL']]. */
function tuples(values: string): string[][] {
  const out: string[][] = [];
  let depth = 0, quote = false, start = 0;
  for (let i = 0; i < values.length; i++) {
    const ch = values[i];
    if (quote) { if (ch === "'") quote = values[i + 1] === "'" ? (i++, true) : false; continue; }
    if (ch === "'") quote = true;
    else if (ch === '(' && depth++ === 0) start = i + 1;
    else if (ch === ')' && --depth === 0) out.push(splitOutside(values.slice(start, i), ',').map(v => literal(v.trim())));
  }
  return out;
}

/** Splits on `sep` outside single-quoted strings and parentheses. */
function splitOutside(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0, quote = false, start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === "'") quote = s[i + 1] === "'" ? (i++, true) : false; continue; }
    if (ch === "'") quote = true;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === sep && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  parts.push(s.slice(start));
  return parts.filter(p => p.trim());
}

const literal = (v: string) => (v.startsWith("'") && v.endsWith("'") ? v.slice(1, -1).replace(/''/g, "'") : v);
