import { z } from 'zod';
import { redactValue, type Redaction } from './redact.js';
import { CanonicalEvent, type SessionInfo } from './schema.js';

/**
 * Sharing a session as a file. Events are redacted when they are stored; an export redacts again, shortens paths
 * (the home folder becomes ~, the project folder only its name), drops what points into the sender's machine (raw
 * log references, source paths) and leaves out prompts, command output or diffs if the sender chooses. Reasoning
 * content was never captured. An import is read-only and keyed apart from live sessions.
 */

export const SHARE_FORMAT = 'behind-everything/session';
export const SHARE_VERSION = 1;
export const SHARED_PREFIX = 'shared:';

export interface ShareOptions { prompts: boolean; outputs: boolean; diffs: boolean }
export const SHARE_ALL: ShareOptions = { prompts: true, outputs: true, diffs: true };

export interface ShareStats {
  events: number;
  /** Secrets the export's own redaction pass caught (on top of those redacted when stored). */
  redacted: number;
  /** Secrets redacted when the events were first stored. */
  redacted_at_capture: number;
  paths_shortened: number;
  left_out: { prompts: number; outputs: number; diffs: number };
}

export interface ShareBundle {
  format: typeof SHARE_FORMAT;
  version: number;
  exported_at: string;
  app_version: string;
  options: ShareOptions;
  session: Omit<SessionInfo, 'source_path'>;
  events: CanonicalEvent[];
  stats: ShareStats;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every spelling of a folder in logs: back or forward slashes, any case, JSON-escaped backslashes. */
function folderPattern(dir: string): RegExp {
  const parts = dir.replace(/[\\/]+$/, '').split(/[\\/]+/).map(escape);
  return new RegExp(parts.join('(?:\\\\\\\\|\\\\|/)'), 'gi');
}

const project = (cwd?: string) => cwd?.split(/[\\/]/).filter(Boolean).at(-1);

export function exportSession(session: SessionInfo, events: CanonicalEvent[], options: ShareOptions, ctx: { home: string; appVersion: string; now?: Date }): ShareBundle {
  const left_out = { prompts: 0, outputs: 0, diffs: 0 };
  let paths = 0;
  const replacements: Array<[RegExp, string]> = [];
  const name = project(session.cwd);
  if (session.cwd && name) replacements.push([folderPattern(session.cwd), name]);
  if (ctx.home) replacements.push([folderPattern(ctx.home), '~']);
  const shorten = <T>(v: T): T => {
    if (typeof v === 'string') return replacements.reduce((s, [re, to]) => s.replace(re, () => { paths++; return to; }), v as string) as T;
    if (Array.isArray(v)) return v.map(shorten) as T;
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shorten(x)])) as T;
    return v;
  };

  const redactions: Redaction[] = [];
  let atCapture = 0;
  const out = events.map(raw => {
    const { evidence: _evidence, redactions: earlier, ...e } = raw as CanonicalEvent & { seq?: number };
    delete (e as { seq?: number }).seq;
    atCapture += earlier?.length ?? 0;
    const payload: Record<string, unknown> = { ...e.payload };
    let summary = e.summary;
    if (!options.prompts && (e.kind === 'user.prompt' || e.kind === 'assistant.message')) {
      if ('text' in payload) left_out.prompts++;
      delete payload.text;
      summary = e.kind === 'user.prompt' ? 'Prompt (not shared)' : 'Message (not shared)';
    }
    if (!options.outputs) for (const k of ['output', 'stderr']) if (k in payload) { delete payload[k]; left_out.outputs++; }
    if (!options.diffs && 'patch' in payload) { delete payload.patch; left_out.diffs++; }
    const shared = shorten({ ...e, summary, payload: Object.keys(payload).length ? payload : undefined });
    return redactValue(shared, e.id, redactions);
  });

  const { source_path: _source, ...info } = session;
  return {
    format: SHARE_FORMAT, version: SHARE_VERSION, exported_at: (ctx.now ?? new Date()).toISOString(), app_version: ctx.appVersion, options,
    session: { ...shorten(info), cwd: name },
    events: out,
    stats: { events: out.length, redacted: redactions.length, redacted_at_capture: atCapture, paths_shortened: paths, left_out },
  };
}

const Bundle = z.object({
  format: z.literal(SHARE_FORMAT),
  version: z.number().int().min(1),
  session: z.object({ id: z.string().min(1), assistant: z.string(), native_id: z.string(), started_at: z.string(), last_ts: z.string() }).passthrough(),
  events: z.array(z.unknown()).max(500_000),
});

/** Checks a file someone shared and re-keys it as a read-only shared session. Throws with a readable reason. */
export function importBundle(input: unknown): { session: SessionInfo; events: CanonicalEvent[] } {
  const parsed = Bundle.safeParse(input);
  if (!parsed.success) {
    const fmt = (input as { format?: unknown } | null)?.format;
    throw new Error(fmt !== SHARE_FORMAT ? 'This is not a Behind Everything session file.' : `This shared session file is damaged (${parsed.error.issues[0]?.path.join('.') || 'structure'}).`);
  }
  if (parsed.data.version > SHARE_VERSION) throw new Error('This session was shared from a newer version of Behind Everything. Update to open it.');
  const base = parsed.data.session.id.startsWith(SHARED_PREFIX) ? parsed.data.session.id : `${SHARED_PREFIX}${parsed.data.session.id}`;
  const events = parsed.data.events.map((raw, i) => {
    const e = CanonicalEvent.safeParse(raw);
    if (!e.success) throw new Error(`Event ${i + 1} in this file is not valid.`);
    return { ...e.data, id: e.data.id.startsWith(SHARED_PREFIX) ? e.data.id : `${SHARED_PREFIX}${e.data.id}`, session_id: base, evidence: undefined };
  });
  const s = parsed.data.session as Record<string, unknown>;
  const str = (k: string) => (typeof s[k] === 'string' ? (s[k] as string) : undefined);
  return {
    session: {
      id: base, assistant: CanonicalEvent.shape.assistant.parse(s.assistant), native_id: String(s.native_id), cwd: str('cwd'), git_branch: str('git_branch'),
      title: str('title'), model: str('model'), version: str('version'), source_path: 'shared', started_at: String(s.started_at), last_ts: String(s.last_ts),
    },
    events,
  };
}

export const isShared = (sessionId: string) => sessionId.startsWith(SHARED_PREFIX);
