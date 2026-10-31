import path from 'node:path';
import { classifyShell, readTargets } from '../../core/classify.js';
import { clip, redactValue, truncate, type Redaction } from '../../core/redact.js';
import type { CanonicalEvent, EventKind, Resource, SessionInfo, Status } from '../../core/schema.js';
import { clipLine, lineCount, MAX_PATCH_LINES, oneLine, parsePatch, patchFromContent, relativeTo } from '../shared.js';

export const ADAPTER = { name: 'codex-log', version: '1', capture: 'log' } as const;

/**
 * Codex writes two streams into one rollout file: what the model asked for (`response_item`: messages, reasoning,
 * tool calls and their raw outputs) and what Codex itself did (`event_msg`: turns, token counts and, in newer
 * versions, `item_completed` records with exact exit codes, durations and file changes). Calls open activities;
 * whichever of the raw output or the structured item arrives first closes them, and the other is dropped.
 */

/** Records with nothing for us; anything else unknown is surfaced as `system.unknown` (format drift). */
const IGNORED_RECORDS = new Set(['world_state', 'token_usage_record']);
const IGNORED_EVENTS = new Set([
  'thread_settings_applied', 'thread_goal_updated', 'agent_message', 'agent_reasoning', 'agent_reasoning_raw_content',
  'agent_reasoning_section_break', 'entered_review_mode', 'exited_review_mode', 'context_compacted',
]);
const IGNORED_RESPONSES = new Set(['tool_search_call', 'tool_search_output']);
/** Structured items already covered by the response stream (messages, reasoning) or by `compacted` records. */
const IGNORED_ITEMS = new Set(['AgentMessage', 'Reasoning', 'ContextCompaction', 'Extension']);

const SHELL_TOOLS = new Set(['shell', 'shell_command', 'exec_command', 'local_shell', 'container.exec']);
const SHELL_EXE = /(^|[\\/])(pwsh|powershell|bash|sh|zsh|cmd)(\.exe)?$/i;
const REJECTED = /rejected by (the )?user|declined by (the )?user|user (denied|declined|rejected)|not approved/i;

type Json = Record<string, any>;

interface Call {
  kind: EventKind;
  tool: string;
  ts: string;
  turn?: string;
  summary: string;
  resources: Resource[];
  command?: string;
  /** Asked to run outside the sandbox, which needs the user's approval. */
  escalated?: string;
  /** apply_patch: one call per file, with the patch's own line counts as a fallback. */
  file?: { path: string; added: number; removed: number; patch: string[]; op: string };
}

interface Outcome {
  status: Status;
  exit_code?: number;
  duration_ms?: number;
  output?: string;
  resources?: Resource[];
  payload?: Json;
  source_class?: 'observed' | 'inferred';
  error_category?: CanonicalEvent['error_category'];
}

/**
 * Stateful parser for one Codex rollout file (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`). Feed lines in
 * order. Event ids come from Codex's own ids (call ids, turn ids, item ids), so a thread continued in a second
 * file, or a file read twice, never duplicates an event.
 */
export function createCodexParser(file: string) {
  let session: SessionInfo | undefined;
  let turnId: string | undefined;
  let lastTs = new Date(0).toISOString();
  const calls = new Map<string, Call>();
  const done = new Set<string>();
  const prompted = new Set<string>();
  /** Unified exec: a command still running after its first output, by process session id. */
  const running = new Map<string, string>();
  /** Code-mode cells: the calls made inside each cell, and cells still running by runtime cell id. */
  const cells = new Map<string, string[]>();
  const runningCells = new Map<string, string>();
  /** Plumbing calls that report on earlier ones. */
  const stdin = new Map<string, string>();
  const waits = new Map<string, string>();
  const patches = new Map<string, string[]>();

  const rel = (p: string) => relativeTo(session?.cwd, p);
  const native = () => session?.native_id ?? path.basename(file, '.jsonl');

  function parse(line: string, lineNo: number): CanonicalEvent[] {
    let o: Json;
    try { o = JSON.parse(line); } catch { return []; }
    if (!o || typeof o !== 'object') return [];
    if (typeof o.timestamp === 'string') lastTs = o.timestamp;
    const p: Json = o.payload && typeof o.payload === 'object' ? o.payload : {};
    const out: CanonicalEvent[] = [];

    const ev = (suffix: string, e: Omit<CanonicalEvent, 'id' | 'session_id' | 'agent_id' | 'ts' | 'assistant' | 'adapter' | 'source_class'> & Partial<CanonicalEvent>): CanonicalEvent => {
      const redactions: Redaction[] = [];
      const summary = redactValue(e.summary, 'summary', redactions);
      const payload = e.payload && redactValue(e.payload, 'payload', redactions);
      const resources = e.resources && redactValue(e.resources, 'resources', redactions);
      return {
        id: `cx:${native()}:${suffix}`,
        session_id: session?.id ?? `codex:${native()}`,
        turn_id: turnId,
        agent_id: 'main',
        ts: lastTs,
        assistant: 'codex',
        adapter: ADAPTER,
        source_class: 'observed',
        evidence: { file, line: lineNo },
        ...e,
        summary, payload, resources,
        ...(redactions.length ? { redactions } : {}),
      };
    };

    // ── calls ──

    const open = (id: string, c: Call, payload?: Json) => {
      calls.set(id, c);
      out.push(ev(`${id}:call`, {
        kind: c.kind, actor: 'assistant', tool: c.tool, status: 'started', resources: c.resources, summary: c.summary,
        payload, correlation: { call_id: id },
      }));
    };

    const finish = (id: string, r: Outcome) => {
      const c = calls.get(id);
      if (!c || done.has(id)) return;
      done.add(id);
      calls.delete(id);
      const denied = r.error_category === 'permission_denied';
      if (c.escalated && r.status !== 'cancelled') {
        // Running outside the sandbox needs the user's yes (or a rule they saved); a refusal is in the output.
        out.push(ev(`${id}:permission`, {
          kind: 'permission.decision', actor: 'user', tool: c.tool, status: denied ? 'failed' : 'succeeded',
          source_class: denied ? 'observed' : 'inferred', resources: c.resources,
          summary: `${denied ? 'Blocked' : 'Approved'}: ${c.summary}`,
          payload: { decision: denied ? 'reject' : 'accept', reason: c.escalated, ...(denied ? {} : { why: 'Asked to run outside the sandbox and then ran' }) },
          correlation: { call_id: id },
        }));
      }
      const payload: Json = { ...(r.output !== undefined ? { output: clip(r.output) } : {}), ...r.payload };
      if (c.file && r.status === 'succeeded') Object.assign(payload, { op: c.file.op, added: c.file.added, removed: c.file.removed, ...(c.file.patch.length ? { patch: c.file.patch } : {}) }, r.payload);
      out.push(ev(`${id}:result`, {
        kind: c.kind, actor: 'tool', tool: c.tool, status: r.status, resources: r.resources ?? c.resources, summary: c.summary,
        payload, source_class: r.source_class ?? 'observed',
        duration_ms: r.duration_ms ?? Math.max(0, Date.parse(lastTs) - Date.parse(c.ts)),
        exit_code: r.exit_code,
        error_category: r.error_category ?? (r.status !== 'failed' ? undefined : c.kind === 'test.run' ? 'test_failure' : c.kind === 'build.run' ? 'build_error' : 'tool_error'),
        correlation: { call_id: id },
      }));
    };

    const shellCall = (tool: string, command: string, args: Json): Call => {
      const kind = classifyShell(command);
      const reads = kind === 'file.read' ? readTargets(command).map(rel) : [];
      return {
        kind, tool, ts: lastTs, turn: turnId, command,
        summary: shellSummary(command, rel),
        resources: reads.length ? reads.map(ref => ({ type: 'file' as const, ref })) : [{ type: 'command', ref: truncate(command, 500) }],
        escalated: args.sandbox_permissions === 'require_escalated' ? String(args.justification ?? 'outside the sandbox') : undefined,
      };
    };

    /** Opens the activities for one tool call. Plumbing calls (wait, write_stdin) only record what they report on. */
    const startCall = (id: string, name: string, args: Json) => {
      if (SHELL_TOOLS.has(name)) {
        const command = commandText(args.command ?? args.cmd);
        return open(id, shellCall(name, command, args), { command: truncate(command, 2000), workdir: args.workdir, justification: args.justification });
      }
      switch (name) {
        case 'write_stdin': return void stdin.set(id, String(args.session_id));
        case 'wait': return void waits.set(id, String(args.cell_id));
        case 'apply_patch': return startPatch(id, String(args.input ?? args.patch ?? ''));
        case 'update_plan': {
          const todos = (Array.isArray(args.plan) ? args.plan : []).map((t: Json) => ({ text: String(t.step ?? ''), status: String(t.status ?? 'pending') }));
          return open(id, { kind: 'plan.update', tool: name, ts: lastTs, turn: turnId, summary: `Plan ${todos.filter((t: Json) => t.status === 'completed').length}/${todos.length} done`, resources: [{ type: 'tool', ref: name }] },
            { todos, explanation: args.explanation ? truncate(String(args.explanation), 1000) : undefined });
        }
        case 'view_image': {
          const ref = rel(String(args.path ?? ''));
          return open(id, { kind: 'file.read', tool: name, ts: lastTs, turn: turnId, summary: `View ${ref}`, resources: [{ type: 'file', ref }] });
        }
        default: {
          const mcp = name.startsWith('mcp__');
          return open(id, {
            kind: mcp ? 'mcp.call' : 'tool.call', tool: name, ts: lastTs, turn: turnId,
            summary: mcp ? name.split('__').slice(1).join(' · ').replace(/\._?/g, ' · ') : name,
            resources: [{ type: mcp ? 'mcp' : 'tool', ref: name }],
          }, { input: shallow(args) });
        }
      }
    };

    /** One activity per file the patch touches, so each file is counted like any other edit. */
    const startPatch = (id: string, patch: string) => {
      const files = parsePatch(patch);
      const subs = files.map((f, i) => {
        const sub = files.length === 1 ? id : `${id}#${i}`;
        const ref = rel(f.path);
        open(sub, { kind: 'file.edit', tool: 'apply_patch', ts: lastTs, turn: turnId, summary: `${f.op === 'add' ? 'Create' : f.op === 'delete' ? 'Delete' : 'Edit'} ${ref}`, resources: [{ type: 'file', ref }], file: { ...f, path: ref } });
        return sub;
      });
      patches.set(id, subs);
    };

    /** A code-mode cell: a script that calls tools (`tools.exec_command({...})`). Each call in it is its own activity. */
    const startCell = (id: string, script: string) => {
      const inner: string[] = [];
      innerCalls(script).forEach((c, i) => {
        // Edits made inside a cell are reported as FileChange items; plumbing is not an activity.
        if (c.name === 'apply_patch' || c.name === 'wait' || c.name === 'write_stdin') return;
        const sub = `${id}.${i}`;
        startCall(sub, c.name, c.args);
        if (calls.has(sub)) inner.push(sub);
      });
      cells.set(id, inner);
    };

    /** Output of a shell call: finished, or still running in the background (unified exec). */
    const shellOutput = (id: string, text: string) => {
      const bg = /Process running with session ID (\d+)/.exec(text);
      if (bg) return void running.set(bg[1]!, id);
      const exit = exitCode(text);
      const rejected = REJECTED.test(text) && exit === undefined;
      finish(id, {
        status: rejected ? 'failed' : exit === undefined || exit === 0 ? 'succeeded' : 'failed',
        exit_code: exit, duration_ms: wallTime(text), output: text,
        error_category: rejected ? 'permission_denied' : undefined,
      });
    };

    /** Output of a cell (or a `wait` on one): exit codes in the order of the calls inside it. */
    const cellOutput = (id: string, text: string) => {
      const bg = /Script running with cell ID (\S+)/.exec(text);
      if (bg) return void runningCells.set(bg[1]!, id);
      const inner = (cells.get(id) ?? []).filter(s => !done.has(s));
      const codes = [...text.matchAll(/(?:Exit code:|Process exited with code) (\d+)/g)].map(m => Number(m[1]));
      const failed = /Script (failed|errored)|Uncaught|Error:/i.test(text.slice(0, 400)) && !/Script completed/.test(text);
      inner.forEach((sub, i) => {
        const exit = codes[i];
        finish(sub, { status: exit !== undefined ? (exit === 0 ? 'succeeded' : 'failed') : failed ? 'failed' : 'succeeded', exit_code: exit, output: inner.length === 1 ? text : undefined });
      });
      cells.delete(id);
    };

    const output = (id: string, raw: unknown) => {
      const text = outputText(raw);
      const session = stdin.get(id);
      if (session !== undefined) {
        stdin.delete(id);
        const original = running.get(session);
        if (original && exitCode(text) !== undefined) { running.delete(session); shellOutput(original, text); }
        return;
      }
      const cell = waits.get(id);
      if (cell !== undefined) {
        waits.delete(id);
        const owner = runningCells.get(cell);
        if (owner && !/Script running/.test(text)) { runningCells.delete(cell); cellOutput(owner, text); }
        return;
      }
      if (cells.has(id)) return cellOutput(id, text);
      const subs = patches.get(id);
      if (subs) {
        patches.delete(id);
        const ok = !/verification failed|error|failed to apply/i.test(text) || /^Success/i.test(text);
        for (const s of subs) finish(s, { status: ok ? 'succeeded' : 'failed', output: ok ? undefined : text });
        return;
      }
      const c = calls.get(id);
      if (!c) return;
      if (c.command !== undefined) return shellOutput(id, text);
      const failed = typeof raw === 'object' && raw !== null && (raw as Json).success === false;
      finish(id, { status: failed ? 'failed' : 'succeeded', output: text });
    };

    // ── structured items (what Codex did) ──

    const commandItem = (item: Json) => {
      const command = commandText(item.command);
      let id = String(item.id);
      if (!calls.has(id) && !done.has(id)) {
        // Run inside a code-mode cell: match it to the call the cell made, by command text.
        const match = [...calls].find(([, c]) => c.command !== undefined && sameCommand(c.command, command));
        if (match) id = match[0];
        else open(id, shellCall('exec', command, {}), { command: truncate(command, 2000) });
      }
      const exit = typeof item.exit_code === 'number' ? item.exit_code : undefined;
      const declined = item.status === 'declined';
      const parsed: Json[] = Array.isArray(item.parsed_cmd) ? item.parsed_cmd : [];
      const reads = parsed.filter(x => x.type === 'read' && typeof (x.path ?? x.name) === 'string').map(x => rel(String(x.path ?? x.name)));
      const c = calls.get(id);
      finish(id, {
        status: declined ? 'failed' : item.status === 'completed' && (exit === undefined || exit === 0) ? 'succeeded' : 'failed',
        exit_code: exit, duration_ms: durationMs(item.duration), output: String(item.aggregated_output ?? item.stdout ?? ''),
        resources: c?.kind === 'file.read' && reads.length ? reads.map(ref => ({ type: 'file', ref })) : undefined,
        error_category: declined ? 'permission_denied' : undefined,
      });
    };

    const fileChangeItem = (item: Json) => {
      const changes: Json = item.changes && typeof item.changes === 'object' ? item.changes : {};
      const status: Status = item.status === 'completed' ? 'succeeded' : 'failed';
      const subs = patches.get(String(item.id)) ?? (calls.has(String(item.id)) ? [String(item.id)] : []);
      patches.delete(String(item.id));
      Object.entries(changes).forEach(([file, ch]: [string, Json], i) => {
        const ref = rel(file);
        const stats = changeStats(ch);
        let id = subs.find(s => calls.get(s)?.file?.path === ref);
        if (!id) {
          id = `${item.id}:${i}`;
          if (done.has(id)) return;
          open(id, { kind: 'file.edit', tool: 'apply_patch', ts: lastTs, turn: turnId, summary: `${ch.type === 'add' ? 'Create' : ch.type === 'delete' ? 'Delete' : 'Edit'} ${ref}`, resources: [{ type: 'file', ref }] });
        }
        finish(id, {
          status, payload: { op: ch.type ?? 'update', ...stats },
          error_category: item.status === 'declined' ? 'permission_denied' : undefined,
        });
      });
      // Calls of this patch whose files Codex did not list: closed with the patch's outcome.
      for (const s of subs) finish(s, { status });
    };

    const prompt = (text: string) => {
      const t = text.trim();
      if (!t || t.startsWith('<') || prompted.has(turnId ?? '')) return;
      prompted.add(turnId ?? '');
      out.push(ev(`${turnId ?? lineNo}:prompt`, { kind: 'user.prompt', actor: 'user', summary: oneLine(t), payload: { text: truncate(t) } }));
      if (session && !session.title) {
        session.title = oneLine(t, 80);
        out.push(ev('title', { kind: 'session.meta', actor: 'system', summary: session.title, payload: { title: session.title } }));
      }
    };

    /** At the end of a turn, calls Codex never reported on are closed with an unknown outcome, so marked inferred. */
    const closeTurn = (turn: string | undefined, status: Status) => {
      for (const [id, c] of calls) if (c.turn === turn) finish(id, { status, source_class: 'inferred', payload: { note: 'Codex did not record how this ended; the turn finished' } });
    };

    switch (o.type) {
      case 'session_meta': {
        if (!session && typeof p.id === 'string') {
          session = { id: `codex:${p.id}`, assistant: 'codex', native_id: p.id, source_path: file, started_at: p.timestamp ?? lastTs, last_ts: lastTs };
          out.push(ev('session-start', { kind: 'session.start', actor: 'system', summary: p.forked_from_id ? 'Session started (forked)' : 'Session started', ts: p.timestamp ?? lastTs, payload: { originator: p.originator, source: p.source, forked_from: p.forked_from_id } }));
        }
        if (session) {
          if (p.cwd) session.cwd = p.cwd;
          if (p.git?.branch) session.git_branch = p.git.branch;
          if (p.cli_version) session.version = p.cli_version;
        }
        break;
      }
      case 'turn_context':
        if (session && p.model) session.model = p.model;
        if (session && p.cwd) session.cwd = p.cwd;
        break;
      case 'compacted':
        out.push(ev(`compact:${p.window_id ?? lineNo}`, { kind: 'session.compaction', actor: 'system', summary: 'Context compacted' }));
        break;
      case 'event_msg': parseEvent(p); break;
      case 'response_item': parseResponse(p); break;
      default:
        if (!IGNORED_RECORDS.has(o.type)) out.push(unknown(String(o.type)));
    }
    if (session) session.last_ts = lastTs;
    return out;

    function unknown(type: string) {
      return ev(`unknown:${path.basename(file)}:${lineNo}`, { kind: 'system.unknown', actor: 'system', summary: `Unrecognised record type "${type}"`, payload: { type } });
    }

    function parseEvent(p: Json) {
      switch (p.type) {
        case 'task_started':
          turnId = p.turn_id;
          out.push(ev(`${turnId}:turn-start`, { kind: 'turn.start', actor: 'user', summary: 'Turn started' }));
          break;
        case 'task_complete':
          closeTurn(p.turn_id ?? turnId, 'cancelled');
          out.push(ev(`${p.turn_id ?? turnId}:turn-end`, {
            kind: 'turn.end', actor: 'assistant', status: p.error ? 'failed' : 'succeeded', duration_ms: p.duration_ms,
            summary: p.error ? 'Turn failed' : 'Turn complete', payload: p.error ? { error: truncate(String(p.error?.message ?? p.error), 500) } : undefined,
          }));
          break;
        case 'turn_aborted':
          closeTurn(p.turn_id ?? turnId, 'cancelled');
          out.push(ev(`${p.turn_id ?? turnId}:turn-end`, { kind: 'turn.end', actor: 'user', status: 'cancelled', error_category: 'interrupted', duration_ms: p.duration_ms, summary: 'Turn interrupted', payload: { reason: p.reason } }));
          break;
        case 'user_message': prompt(String(p.message ?? '')); break;
        case 'token_count': {
          const u: Json | undefined = p.info?.last_token_usage;
          if (!u) break;
          const cached = num(u.cached_input_tokens);
          out.push(ev(`tokens:${path.basename(file)}:${lineNo}`, {
            kind: 'usage.tokens', actor: 'system', summary: `${num(u.output_tokens)} output tokens`,
            payload: { model: session?.model, input: Math.max(0, num(u.input_tokens) - cached), output: num(u.output_tokens), cache_read: cached, reasoning: num(u.reasoning_output_tokens) },
          }));
          break;
        }
        case 'item_completed': {
          const item: Json = p.item ?? {};
          if (p.turn_id) turnId = p.turn_id;
          switch (item.type) {
            case 'UserMessage': prompt((item.content ?? []).map((c: Json) => c.text ?? '').join('\n')); break;
            case 'CommandExecution': commandItem(item); break;
            case 'FileChange': fileChangeItem(item); break;
            case 'McpToolCall': {
              const id = String(item.id);
              if (!calls.has(id) && !done.has(id)) open(id, { kind: 'mcp.call', tool: `mcp__${item.server}__${item.tool}`, ts: lastTs, turn: turnId, summary: `${item.server} · ${item.tool}`, resources: [{ type: 'mcp', ref: `${item.server}/${item.tool}` }] });
              finish(id, { status: item.status === 'completed' ? 'succeeded' : 'failed', duration_ms: durationMs(item.duration) });
              break;
            }
            case 'WebSearch': {
              const q = String(item.query ?? item.action?.query ?? '');
              out.push(ev(`${item.id}:web`, { kind: 'web.fetch', actor: 'tool', status: 'succeeded', summary: `Search web "${oneLine(q, 80)}"`, resources: [{ type: 'url', ref: q }], payload: { query: q } }));
              break;
            }
            default:
              if (!IGNORED_ITEMS.has(item.type)) out.push(unknown(`item:${item.type}`));
          }
          break;
        }
        default:
          if (!IGNORED_EVENTS.has(p.type)) out.push(unknown(`event:${p.type}`));
      }
    }

    function parseResponse(p: Json) {
      switch (p.type) {
        case 'message': {
          if (p.role !== 'assistant') break;
          const text = (p.content ?? []).map((c: Json) => c.text ?? '').join('\n').trim();
          if (text) out.push(ev(`msg:${p.id ?? lineNo}`, { kind: 'assistant.message', actor: 'assistant', summary: oneLine(text), payload: { text: truncate(text), phase: p.phase } }));
          break;
        }
        case 'reasoning':
          // We record that reasoning happened, never its content (Codex stores it encrypted anyway).
          out.push(ev(`rs:${p.id ?? lineNo}`, { kind: 'assistant.reasoning', actor: 'assistant', summary: 'Reasoning', payload: { content: 'unavailable' } }));
          break;
        case 'function_call': {
          let args: Json = {};
          try { args = JSON.parse(p.arguments ?? '{}'); } catch { args = { raw: String(p.arguments ?? '') }; }
          startCall(String(p.call_id), p.namespace ? `${p.namespace}.${p.name}` : String(p.name), args);
          break;
        }
        case 'custom_tool_call':
          if (p.name === 'exec') startCell(String(p.call_id), String(p.input ?? ''));
          else if (p.name === 'apply_patch') startPatch(String(p.call_id), String(p.input ?? ''));
          else startCall(String(p.call_id), String(p.name), { input: p.input });
          break;
        case 'local_shell_call': {
          const id = String(p.call_id ?? p.id);
          startCall(id, 'local_shell', { command: p.action?.command, workdir: p.action?.working_directory });
          if (p.status && p.status !== 'in_progress') finish(id, { status: p.status === 'completed' ? 'succeeded' : 'failed' });
          break;
        }
        case 'function_call_output': case 'custom_tool_call_output': case 'local_shell_call_output':
          output(String(p.call_id), p.output);
          break;
        case 'web_search_call': {
          const q = String(p.action?.query ?? '');
          out.push(ev(`${p.id ?? lineNo}:web`, { kind: 'web.fetch', actor: 'tool', status: 'succeeded', summary: q ? `Search web "${oneLine(q, 80)}"` : 'Web search', resources: q ? [{ type: 'url', ref: q }] : undefined, payload: { query: q } }));
          break;
        }
        default:
          if (!IGNORED_RESPONSES.has(p.type)) out.push(unknown(`response:${p.type}`));
      }
    }
  }

  return { parse, get session() { return session; } };
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** How a shell call is named. Shared with the hook bridge, which must name a call exactly as the log does. */
export function shellSummary(command: string, rel: (p: string) => string = p => p): string {
  const kind = classifyShell(command);
  const reads = kind === 'file.read' ? readTargets(command).map(rel) : [];
  return reads.length ? `Read ${reads.join(', ')}` : kind === 'file.search' ? `Search: ${oneLine(command, 120)}` : oneLine(command, 140);
}

/** The command line a shell call runs: `["pwsh", "-Command", "ls"]` → `ls`. */
export function commandText(cmd: unknown): string {
  if (typeof cmd === 'string') return cmd;
  if (!Array.isArray(cmd)) return '';
  const parts = cmd.map(String);
  if (parts.length >= 2 && SHELL_EXE.test(parts[0]!)) return parts[parts.length - 1]!;
  return parts.join(' ');
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const sameCommand = (a: string, b: string) => {
  const x = squash(a), y = squash(b);
  return !!x && !!y && (x === y || y.includes(x) || x.includes(y));
};

function outputText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map(c => (c && typeof c === 'object' && 'text' in c ? String((c as Json).text) : '')).join('\n');
  if (raw && typeof raw === 'object') return String((raw as Json).content ?? (raw as Json).output ?? JSON.stringify(raw));
  return '';
}

function exitCode(text: string): number | undefined {
  const m = /(?:Process exited with code|Exit code:?) (-?\d+)/.exec(text);
  return m ? Number(m[1]) : undefined;
}

function wallTime(text: string): number | undefined {
  const m = /Wall time:? ([\d.]+) seconds/.exec(text);
  return m ? Math.round(Number(m[1]) * 1000) : undefined;
}

function durationMs(d: unknown): number | undefined {
  if (typeof d === 'number') return d;
  if (d && typeof d === 'object') return Math.round(num((d as Json).secs) * 1000 + num((d as Json).nanos) / 1e6);
  return undefined;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function shallow(args: Json): Json {
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === 'string' ? truncate(v, 500) : v]));
}

/** Calls made inside a code-mode cell: `tools.NAME({ …json… })`. Arguments that are not plain JSON are skipped. */
export function innerCalls(script: string): Array<{ name: string; args: Json }> {
  const out: Array<{ name: string; args: Json }> = [];
  const re = /tools\.([A-Za-z_][\w.]*)\(\s*\{/g;
  for (let m = re.exec(script); m; m = re.exec(script)) {
    const start = m.index + m[0].length - 1;
    const end = matchBrace(script, start);
    if (end < 0) continue;
    try { out.push({ name: m[1]!, args: JSON.parse(script.slice(start, end + 1)) }); } catch { /* not JSON: a JS expression */ }
    re.lastIndex = end + 1;
  }
  return out;
}

/** Index of the brace closing the one at `start`, skipping braces inside strings. */
function matchBrace(s: string, start: number): number {
  let depth = 0, quote = '';
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Line counts and diff lines of one FileChange entry: a unified diff, or the whole content of a new file. */
function changeStats(ch: Json): { added: number; removed: number; patch?: string[] } {
  if (typeof ch.unified_diff === 'string') {
    let added = 0, removed = 0;
    const patch: string[] = [];
    for (const l of ch.unified_diff.split('\n')) {
      if (l.startsWith('+++') || l.startsWith('---')) continue;
      if (l.startsWith('+')) added++;
      else if (l.startsWith('-')) removed++;
      if (patch.length < MAX_PATCH_LINES && l) patch.push(clipLine(l));
    }
    return { added, removed, ...(patch.length ? { patch } : {}) };
  }
  if (typeof ch.content === 'string') return ch.type === 'delete' ? { added: 0, removed: lineCount(ch.content) } : { added: lineCount(ch.content), removed: 0, patch: patchFromContent(ch.content) };
  return { added: 0, removed: 0 };
}
