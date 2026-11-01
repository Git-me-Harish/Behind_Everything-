import { z } from 'zod';

/** How we know a signal: seen directly, derived from other signals, or not exposed by the provider. */
export const SourceClass = z.enum(['observed', 'inferred', 'unavailable']);
export type SourceClass = z.infer<typeof SourceClass>;

export const Assistant = z.enum(['claude-code', 'codex', 'copilot-cli', 'copilot-vscode']);
export type Assistant = z.infer<typeof Assistant>;

export const EventKind = z.enum([
  'session.start', 'session.meta', 'session.compaction',
  'turn.start', 'turn.end',
  'user.prompt', 'user.question',
  'assistant.message', 'assistant.reasoning',
  'file.read', 'file.search', 'file.edit',
  'command.run', 'test.run', 'build.run', 'dependency.change',
  'plan.update', 'permission.decision',
  'subagent.start', 'subagent.end',
  'web.fetch', 'mcp.call', 'tool.call',
  'usage.tokens', 'system.error', 'system.unknown',
]);
export type EventKind = z.infer<typeof EventKind>;

export const Status = z.enum(['started', 'succeeded', 'failed', 'pending', 'cancelled']);
export type Status = z.infer<typeof Status>;

export const Resource = z.object({
  type: z.enum(['file', 'dir', 'command', 'url', 'tool', 'mcp']),
  ref: z.string(),
});
export type Resource = z.infer<typeof Resource>;

export const CanonicalEvent = z.object({
  /** Stable across re-ingestion: derived from provider ids, used for dedupe. */
  id: z.string(),
  session_id: z.string(),
  turn_id: z.string().optional(),
  /** 'main' or a subagent id; each agent gets its own avatar. */
  agent_id: z.string(),
  ts: z.string(),
  assistant: Assistant,
  adapter: z.object({ name: z.string(), version: z.string(), capture: z.enum(['log', 'hook', 'workspace']) }),
  kind: EventKind,
  status: Status.optional(),
  source_class: SourceClass,
  actor: z.enum(['user', 'assistant', 'tool', 'system']),
  /** Native tool name, when the event came from a tool call. */
  tool: z.string().optional(),
  resources: z.array(Resource).optional(),
  summary: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
  duration_ms: z.number().optional(),
  exit_code: z.number().optional(),
  error_category: z.enum(['test_failure', 'build_error', 'tool_error', 'permission_denied', 'interrupted', 'other']).optional(),
  correlation: z.object({ call_id: z.string().optional(), parent_agent: z.string().optional() }).optional(),
  redactions: z.array(z.object({ path: z.string(), rule: z.string() })).optional(),
  /** Where the raw provider record lives, for drill-through. */
  evidence: z.object({ file: z.string(), line: z.number() }).optional(),
});
export type CanonicalEvent = z.infer<typeof CanonicalEvent>;

export interface SessionInfo {
  id: string;
  assistant: Assistant;
  native_id: string;
  cwd?: string;
  git_branch?: string;
  title?: string;
  model?: string;
  version?: string;
  source_path: string;
  started_at: string;
  last_ts: string;
}
