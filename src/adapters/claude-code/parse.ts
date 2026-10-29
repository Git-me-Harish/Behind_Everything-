import path from 'node:path';
import { classifyClaudeTool } from '../../core/classify.js';
import { redactValue, truncate, type Redaction } from '../../core/redact.js';
import type { CanonicalEvent, EventKind, Resource, SessionInfo } from '../../core/schema.js';

export const ADAPTER = { name: 'claude-code-log', version: '1', capture: 'log' } as const;

/** Record types we deliberately ignore; anything else unknown is surfaced as `system.unknown` (format drift). */
const IGNORED = new Set([
  'queue-operation', 'attachment', 'file-history-snapshot', 'file-history-delta', 'atis-latch',
  'api-request', 'api-request-shape', 'api-request-blob', 'last-prompt', 'tools-used', 'progress',
  'custom-title', 'tag', 'agent-name', 'pr-link', 'mode', 'bridge-session',
]);

const DENIED = /^(The user doesn't want to proceed|Permission to use .* (has been )?denied|.*auto mode cannot determine)/s;
const INTERRUPTED = /\[Request interrupted by user/;

interface PendingCall { kind: EventKind; tool: string; input: Record<string, unknown>; ts: string; resources: Resource[]; summary: string }

type Json = Record<string, any>;

/**
 * Stateful parser for one Claude Code transcript file. Feed lines in order;
 * the state (open tool calls, current turn) is rebuilt by replaying the file.
 */
export function createClaudeParser(file: string) {
  const calls = new Map<string, PendingCall>();
  const finishedMessages = new Set<string>();
  let session: SessionInfo | undefined;
  let turnId: string | undefined;
  let lastTs = new Date(0).toISOString();

  function parse(line: string, lineNo: number): CanonicalEvent[] {
    let o: Json;
    try { o = JSON.parse(line); } catch { return []; }
    if (!o || typeof o !== 'object') return [];
    const out: CanonicalEvent[] = [];
    if (typeof o.timestamp === 'string') lastTs = o.timestamp;
    const base = (suffix: string) => `cc:${o.uuid ?? `${path.basename(file)}:${lineNo}`}:${suffix}`;

    if (typeof o.sessionId === 'string' && !session) {
      session = {
        id: `claude-code:${o.sessionId}`, assistant: 'claude-code', native_id: o.sessionId,
        source_path: file, started_at: lastTs, last_ts: lastTs,
      };
      if (o.timestamp) out.push(ev(o, 'session-start', { kind: 'session.start', actor: 'system', summary: 'Session started' }));
    }
    if (session) {
      session.last_ts = lastTs;
      if (o.cwd) session.cwd = o.cwd;
      if (o.gitBranch) session.git_branch = o.gitBranch;
      if (o.version) session.version = o.version;
      if (session.started_at === new Date(0).toISOString()) session.started_at = lastTs;
    }

    function ev(rec: Json, suffix: string, e: Omit<CanonicalEvent, 'id' | 'session_id' | 'agent_id' | 'ts' | 'assistant' | 'adapter' | 'source_class'> & Partial<CanonicalEvent>): CanonicalEvent {
      const redactions: Redaction[] = [];
      const summary = redactValue(e.summary, 'summary', redactions);
      const payload = e.payload && redactValue(e.payload, 'payload', redactions);
      const resources = e.resources && redactValue(e.resources, 'resources', redactions);
      return {
        id: base(suffix),
        session_id: session?.id ?? `claude-code:${rec.sessionId}`,
        turn_id: turnId,
        agent_id: rec.isSidechain ? String(rec.agentId ?? 'subagent') : 'main',
        ts: rec.timestamp ?? lastTs,
        assistant: 'claude-code',
        adapter: ADAPTER,
        source_class: 'observed',
        evidence: { file, line: lineNo },
        ...e,
        summary, payload, resources,
        ...(redactions.length ? { redactions } : {}),
      };
    }

    switch (o.type) {
      case 'user': parseUser(o, out, ev); break;
      case 'assistant': parseAssistant(o, out, ev); break;
      case 'ai-title': case 'summary': {
        const title = o.aiTitle ?? o.summary;
        // Claude Code rewrites the title record often; only a change is an event.
        if (typeof title === 'string' && session && title !== session.title) {
          session.title = title;
          out.push(ev(o, 'title', { kind: 'session.meta', actor: 'system', summary: title, payload: { title } }));
        }
        break;
      }
      case 'system':
        if (o.subtype === 'compact_boundary') out.push(ev(o, 'compact', { kind: 'session.compaction', actor: 'system', summary: 'Context compacted', payload: { trigger: o.compactMetadata?.trigger, pre_tokens: o.compactMetadata?.preTokens } }));
        if (o.subtype === 'api_error') out.push(ev(o, 'api-error', {
          kind: 'system.error', actor: 'system', status: 'failed', error_category: 'other',
          summary: `API error${o.retryAttempt ? ` · retry ${o.retryAttempt}/${o.maxRetries ?? '?'}` : ''}`,
          payload: { error: truncate(String(o.error?.message ?? o.content ?? ''), 500), retry: o.retryAttempt },
        }));
        break;
      default:
        if (!IGNORED.has(o.type)) out.push(ev(o, `unknown:${lineNo}`, { kind: 'system.unknown', actor: 'system', summary: `Unrecognised record type "${o.type}"`, payload: { type: o.type } }));
    }
    return out;
  }

  type Ev = (rec: Json, suffix: string, e: any) => CanonicalEvent;

  function parseUser(o: Json, out: CanonicalEvent[], ev: Ev) {
    const content = o.message?.content;
    const blocks: Json[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    const results = blocks.filter(b => b.type === 'tool_result');
    if (results.length === 0) {
      if (o.isMeta || o.isCompactSummary || o.isSidechain) return;
      // Background-task notifications arrive as user lines but are not prompts.
      if (o.origin?.kind && o.origin.kind !== 'human') return;
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (!text || text.startsWith('<local-command-') || text.startsWith('<system-reminder>')) return;
      turnId = o.promptId ?? o.uuid;
      out.push(ev(o, 'turn-start', { kind: 'turn.start', actor: 'user', summary: 'Turn started' }));
      out.push(ev(o, 'prompt', { kind: 'user.prompt', actor: 'user', summary: oneLine(text), payload: { text: truncate(text) } }));
      return;
    }
    if (o.promptId && !o.isSidechain) turnId = o.promptId;
    for (const r of results) parseResult(o, r, out, ev);
  }

  function parseResult(o: Json, r: Json, out: CanonicalEvent[], ev: Ev) {
    const callId = String(r.tool_use_id);
    const call = calls.get(callId);
    calls.delete(callId);
    const text = resultText(r.content);
    const tur: Json = o.toolUseResult && typeof o.toolUseResult === 'object' ? o.toolUseResult : {};
    const kind: EventKind = call?.kind === 'subagent.start' ? 'subagent.end' : call?.kind ?? 'tool.call';
    const exit = /^Exit code (\d+)/.exec(text);
    const interrupted = tur.interrupted === true || INTERRUPTED.test(text);
    const denied = r.is_error === true && DENIED.test(text);
    const status = interrupted ? 'cancelled' : r.is_error ? 'failed' : 'succeeded';
    const errorCategory = !r.is_error && !interrupted ? undefined
      : interrupted ? 'interrupted' : denied ? 'permission_denied'
      : kind === 'test.run' ? 'test_failure' : kind === 'build.run' ? 'build_error' : 'tool_error';

    // Auto-accepted calls (source "config") are routine; surface human decisions and every rejection.
    const pd: Json | undefined = o.permissionDecision;
    const rejected = denied || pd?.decision === 'reject';
    const byUser = typeof pd?.source === 'string' && pd.source.startsWith('user');
    if (rejected || byUser) {
      out.push(ev(o, `${callId}:permission`, {
        kind: 'permission.decision', actor: byUser ? 'user' : 'system', tool: call?.tool,
        status: rejected ? 'failed' : 'succeeded', resources: call?.resources,
        summary: `${rejected ? 'Blocked' : 'Approved by you'}: ${call?.summary ?? call?.tool ?? 'tool call'}`,
        payload: { decision: rejected ? 'reject' : 'accept', source: pd?.source, reason: pd?.reasonCode ?? pd?.reasonType, category: pd?.classifierCategory },
        correlation: { call_id: callId },
      }));
    }

    const payload: Json = { output: truncate(text, 2000) };
    if (kind === 'file.edit') {
      const stats = patchStats(tur.structuredPatch);
      if (tur.type === 'create' && typeof tur.content === 'string') stats.added = lineCount(tur.content);
      Object.assign(payload, { op: tur.type ?? 'update', ...stats });
      delete payload.output;
    }
    if (typeof tur.stdout === 'string') Object.assign(payload, { output: truncate(tur.stdout, 2000), stderr: truncate(tur.stderr ?? '', 2000) });
    if (typeof tur.numFiles === 'number') payload.matches = tur.numFiles;
    if (kind === 'subagent.end') Object.assign(payload, { agent_id: tur.agentId, duration_ms: tur.totalDurationMs, tokens: tur.totalTokens, tool_uses: tur.totalToolUseCount });

    out.push(ev(o, `${callId}:result`, {
      kind, actor: 'tool', tool: call?.tool, status, resources: call?.resources,
      summary: call?.summary ?? (r.is_error ? 'Tool call failed' : 'Tool call finished'),
      payload,
      duration_ms: call ? Math.max(0, Date.parse(o.timestamp) - Date.parse(call.ts)) : undefined,
      exit_code: exit ? Number(exit[1]) : status === 'succeeded' && (call?.tool === 'Bash' || call?.tool === 'PowerShell') ? 0 : undefined,
      error_category: errorCategory,
      correlation: { call_id: callId },
    }));

    // Shell commands that changed files (Claude Code reports these itself).
    const changed: unknown = tur.bashEditDiff?.changedFiles;
    if (Array.isArray(changed)) changed.forEach((f, i) => out.push(ev(o, `${callId}:bashedit:${i}`, {
      kind: 'file.edit', actor: 'tool', tool: call?.tool, status: 'succeeded',
      resources: [{ type: 'file', ref: rel(String(f)) }], summary: `${rel(String(f))} changed by command`,
      payload: { op: 'command' }, correlation: { call_id: callId },
    })));
  }

  function parseAssistant(o: Json, out: CanonicalEvent[], ev: Ev) {
    const msg = o.message ?? {};
    if (session && msg.model && msg.model !== '<synthetic>') session.model = msg.model;
    (Array.isArray(msg.content) ? msg.content : []).forEach((b: Json, i: number) => {
      if (b.type === 'text' && b.text?.trim()) {
        out.push(ev(o, `text:${i}`, { kind: 'assistant.message', actor: 'assistant', summary: oneLine(b.text), payload: { text: truncate(b.text) } }));
      } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        // We record that reasoning happened, never its content.
        const secs = o.thinkingDurationMs ? ` · ${(o.thinkingDurationMs / 1000).toFixed(1)}s` : '';
        out.push(ev(o, `thinking:${i}`, {
          kind: 'assistant.reasoning', actor: 'assistant', summary: `Reasoning${secs}`,
          duration_ms: o.thinkingDurationMs, payload: { content: 'unavailable' },
        }));
      } else if (b.type === 'tool_use') {
        const input: Json = b.input ?? {};
        const kind = classifyClaudeTool(b.name, input);
        const call: PendingCall = { kind, tool: b.name, input, ts: o.timestamp ?? lastTs, resources: resourcesOf(b.name, input), summary: callSummary(b.name, input) };
        calls.set(b.id, call);
        out.push(ev(o, `${b.id}:call`, {
          kind, actor: 'assistant', tool: b.name, status: kind === 'user.question' ? 'pending' : 'started',
          resources: call.resources, summary: call.summary, payload: callPayload(b.name, input),
          correlation: { call_id: b.id, ...(kind === 'subagent.start' ? { parent_agent: o.isSidechain ? String(o.agentId) : 'main' } : {}) },
        }));
      }
    });
    if (msg.id && msg.stop_reason && !finishedMessages.has(msg.id)) {
      finishedMessages.add(msg.id);
      const u = msg.usage ?? {};
      out.push(ev(o, `usage:${msg.id}`, {
        kind: 'usage.tokens', actor: 'system', summary: `${u.output_tokens ?? 0} output tokens`,
        payload: { model: msg.model, input: u.input_tokens, output: u.output_tokens, cache_read: u.cache_read_input_tokens, cache_creation: u.cache_creation_input_tokens },
      }));
      if (msg.stop_reason === 'end_turn' && !o.isSidechain) out.push(ev(o, `turn-end:${msg.id}`, { kind: 'turn.end', actor: 'assistant', status: 'succeeded', summary: 'Turn complete' }));
    }
  }

  function rel(p: string): string {
    const cwd = session?.cwd;
    const norm = p.replace(/\\/g, '/');
    if (cwd) {
      const c = cwd.replace(/\\/g, '/').replace(/\/$/, '');
      if (norm.toLowerCase().startsWith(c.toLowerCase() + '/')) return norm.slice(c.length + 1);
    }
    return norm;
  }

  function resourcesOf(tool: string, input: Json): Resource[] {
    const file = input.file_path ?? input.notebook_path;
    if (typeof file === 'string') return [{ type: 'file', ref: rel(file) }];
    if (typeof input.command === 'string') return [{ type: 'command', ref: truncate(input.command, 500) }];
    if (typeof input.url === 'string') return [{ type: 'url', ref: input.url }];
    if (tool === 'Glob' || tool === 'Grep') return [{ type: 'dir', ref: rel(String(input.path ?? session?.cwd ?? '.')) }];
    if (tool.startsWith('mcp__')) return [{ type: 'mcp', ref: tool }];
    return [{ type: 'tool', ref: tool }];
  }

  function callSummary(tool: string, input: Json): string {
    const file = input.file_path ?? input.notebook_path;
    switch (tool) {
      case 'Read': return `Read ${rel(String(file))}`;
      case 'Write': return `Write ${rel(String(file))}`;
      case 'Edit': case 'MultiEdit': case 'NotebookEdit': return `Edit ${rel(String(file))}`;
      case 'Glob': return `Find ${input.pattern}`;
      case 'Grep': return `Search "${oneLine(String(input.pattern), 80)}"`;
      case 'Bash': case 'PowerShell': return oneLine(String(input.description || input.command), 140);
      case 'WebFetch': return `Fetch ${input.url}`;
      case 'WebSearch': return `Search web "${oneLine(String(input.query), 80)}"`;
      case 'Agent': case 'Task': return `Subagent: ${oneLine(String(input.description ?? input.subagent_type ?? 'task'), 100)}`;
      case 'TodoWrite': {
        const todos: Json[] = Array.isArray(input.todos) ? input.todos : [];
        return `Plan ${todos.filter(t => t.status === 'completed').length}/${todos.length} done`;
      }
      case 'TaskCreate': return `Task: ${oneLine(String(input.subject ?? input.description ?? ''), 100)}`;
      case 'TaskUpdate': return `Task ${input.taskId ?? ''} → ${input.status ?? 'updated'}`;
      case 'EnterPlanMode': return 'Entered plan mode';
      case 'ExitPlanMode': return 'Proposed a plan';
      case 'AskUserQuestion': return `Asked: ${oneLine(String(input.questions?.[0]?.question ?? 'a question'), 120)}`;
      default: return tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' · ') : tool;
    }
  }

  function callPayload(tool: string, input: Json): Json {
    switch (tool) {
      case 'Bash': case 'PowerShell': return { command: truncate(String(input.command ?? ''), 2000), description: input.description, background: input.run_in_background };
      case 'TodoWrite': return { todos: (input.todos ?? []).map((t: Json) => ({ text: t.content, status: t.status })) };
      case 'TaskCreate': return { subject: input.subject, description: truncate(String(input.description ?? ''), 500) };
      case 'TaskUpdate': return { task_id: input.taskId, status: input.status };
      case 'ExitPlanMode': return { plan: truncate(String(input.plan ?? ''), 4000) };
      case 'AskUserQuestion': return { questions: (input.questions ?? []).map((q: Json) => q.question) };
      case 'Agent': case 'Task': return { subagent_type: input.subagent_type, description: input.description, prompt: truncate(String(input.prompt ?? ''), 1000) };
      case 'Edit': case 'Write': case 'MultiEdit': case 'Read': case 'NotebookEdit': return {};
      default: return { input: Object.fromEntries(Object.entries(input).map(([k, v]) => [k, typeof v === 'string' ? truncate(v, 500) : v])) };
    }
  }

  return { parse, get session() { return session; } };
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => (c && typeof c === 'object' && 'text' in c ? String(c.text) : c && typeof c === 'object' && 'type' in c ? `[${c.type}]` : '')).join('\n');
  return '';
}

function patchStats(patch: unknown): { added: number; removed: number } {
  let added = 0, removed = 0;
  if (Array.isArray(patch)) for (const h of patch) for (const l of h?.lines ?? []) {
    if (typeof l !== 'string') continue;
    if (l.startsWith('+')) added++; else if (l.startsWith('-')) removed++;
  }
  return { added, removed };
}

const lineCount = (s: string) => (s ? s.split('\n').length : 0);

function oneLine(s: string, max = 200): string {
  const first = s.replace(/\s+/g, ' ').trim();
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}
