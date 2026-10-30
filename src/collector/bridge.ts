import { callSummary } from '../adapters/claude-code/parse.js';
import { shellSummary } from '../adapters/codex/parse.js';
import { relativeTo } from '../adapters/shared.js';
import { redactValue } from '../core/redact.js';
import type { CanonicalEvent } from '../core/schema.js';
import type { HookAssistant } from '../hooks/install.js';

/**
 * Turns hook calls into events. A PermissionRequest hook names the tool and its input but not the call id, so it is
 * matched to the call the log already shows as running, by the one-line summary both sides compute the same way.
 * The log may lag the hook by a moment: unmatched requests wait briefly for their call to appear. The decision itself
 * comes from the log as before (approval, refusal, or simply the call finishing), so a hook only ever adds "waiting".
 */

const WAIT_MS = 30_000;
/** A lone running call is assumed to be the one asking only if it started this recently. */
const LONE_CALL_MS = 10 * 60_000;

type Json = Record<string, any>;

interface OpenCall { call_id: string; summary: string; agent_id: string; turn_id?: string; ts: string }
interface Parked { assistant: HookAssistant; session: string; summary: string; body: Json; at: number }

export interface HookStats { events: number; matched: number; unmatched: number; last?: string }

export function createBridge(emit: (events: CanonicalEvent[]) => void, now = () => Date.now()) {
  const open = new Map<string, Map<string, OpenCall>>();
  /** Calls that already finished, by session: a late hook for one of them is dropped quietly. */
  const finished = new Map<string, string[]>();
  const asked = new Set<string>();
  let parked: Parked[] = [];
  const stats: Record<HookAssistant, HookStats> = { 'claude-code': { events: 0, matched: 0, unmatched: 0 }, codex: { events: 0, matched: 0, unmatched: 0 } };

  /** Follows the calls the logs show as running. Fed every parsed event, duplicates included (idempotent). */
  function observe(events: CanonicalEvent[]) {
    const touched = new Set<string>();
    for (const e of events) {
      const call = e.correlation?.call_id;
      if (!call || e.kind === 'permission.decision') continue;
      let calls = open.get(e.session_id);
      if (e.status === 'started' || e.status === 'pending') {
        if (!calls) open.set(e.session_id, (calls = new Map()));
        calls.set(call, { call_id: call, summary: e.summary, agent_id: e.agent_id, turn_id: e.turn_id, ts: e.ts });
        touched.add(e.session_id);
      } else if (calls?.delete(call)) {
        const done = finished.get(e.session_id) ?? [];
        done.push(e.summary);
        finished.set(e.session_id, done.slice(-50));
      }
    }
    if (parked.length && touched.size) retry(p => touched.has(p.session));
  }

  function ingest(assistant: HookAssistant, body: Json): void {
    if (body?.hook_event_name !== 'PermissionRequest' || typeof body.session_id !== 'string') return;
    const s = stats[assistant];
    s.events++;
    s.last = new Date(now()).toISOString();
    const session = `${assistant}:${body.session_id}`;
    const rel = (p: string) => relativeTo(typeof body.cwd === 'string' ? body.cwd : undefined, p);
    const input: Json = body.tool_input && typeof body.tool_input === 'object' ? body.tool_input : {};
    const tool = String(body.tool_name ?? '');
    const raw = assistant === 'claude-code' ? callSummary(tool, input, rel)
      : typeof input.command === 'string' || Array.isArray(input.command) ? shellSummary([input.command].flat().join(' '), rel)
      : tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' · ') : tool;
    const p: Parked = { assistant, session, summary: redactValue(raw), body, at: now() };
    if (!match(p)) parked.push(p);
  }

  /** Emits the pending decision for the call this request is about, if the log shows it yet. */
  function match(p: Parked): boolean {
    const calls = [...(open.get(p.session)?.values() ?? [])].filter(c => !asked.has(`${p.session}:${c.call_id}`));
    let call = calls.filter(c => c.summary === p.summary).at(-1);
    if (!call && calls.length === 1 && now() - Date.parse(calls[0]!.ts) < LONE_CALL_MS) call = calls[0];
    if (!call) {
      // Already answered and finished before the hook got here: nothing is waiting any more.
      if (finished.get(p.session)?.includes(p.summary)) return true;
      return false;
    }
    asked.add(`${p.session}:${call.call_id}`);
    stats[p.assistant].matched++;
    const b = p.body;
    emit([{
      id: `hook:${p.session}:${call.call_id}:ask`,
      session_id: p.session, turn_id: call.turn_id, agent_id: call.agent_id, ts: new Date(now()).toISOString(),
      assistant: p.assistant, adapter: { name: `${p.assistant}-hook`, version: '1', capture: 'hook' },
      kind: 'permission.decision', status: 'pending', source_class: 'observed', actor: 'assistant', tool: String(b.tool_name ?? ''),
      summary: `Waiting for approval: ${call.summary}`,
      payload: redactValue({ source: 'hook', permission_mode: b.permission_mode, description: b.tool_input?.description ?? undefined }),
      correlation: { call_id: call.call_id },
    }]);
    return true;
  }

  function retry(which: (p: Parked) => boolean) {
    parked = parked.filter(p => !(which(p) && match(p)));
  }

  /** Requests whose call never showed up in the log: counted, then dropped. */
  function sweep() {
    const t = now();
    parked = parked.filter(p => {
      if (t - p.at < WAIT_MS) return true;
      stats[p.assistant].unmatched++;
      return false;
    });
  }

  return { observe, ingest, sweep, stats: () => stats };
}
