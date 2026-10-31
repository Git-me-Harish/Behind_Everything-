import type { CanonicalEvent } from './schema.js';

export interface WaitingItem {
  key: string;
  kind: 'approval' | 'question';
  summary: string;
  since: string;
  event: string;
  call_id?: string;
}

/** A request older than this is a session that died waiting, not one still waiting for you. */
const STALE_MS = 12 * 60 * 60_000;

/**
 * What each session is waiting on you for (approvals and questions) across all sessions, so the UI can alert you
 * about a session you are not looking at. Same rules as the reducer's Approval Gate; replaying events is idempotent.
 */
export class WaitingTracker {
  private sessions = new Map<string, Map<string, WaitingItem>>();

  /** Returns the ids of sessions whose waiting list changed. */
  apply(events: CanonicalEvent[]): Set<string> {
    const changed = new Set<string>();
    for (const e of events) if (this.one(e)) changed.add(e.session_id);
    return changed;
  }

  list(session: string, now = Date.now()): WaitingItem[] {
    return [...(this.sessions.get(session)?.values() ?? [])].filter(w => now - Date.parse(w.since) < STALE_MS);
  }

  private one(e: CanonicalEvent): boolean {
    const call = e.correlation?.call_id;
    let items = this.sessions.get(e.session_id);
    const drop = (key: string) => items?.delete(key) ?? false;
    if (e.kind === 'turn.start' || e.kind === 'turn.end') {
      if (!items?.size) return false;
      items.clear();
      return true;
    }
    if (e.kind === 'permission.decision') {
      const key = `perm:${String(e.payload?.request_id ?? call ?? e.id)}`;
      if (e.status !== 'pending') return drop(key);
      if (!items) this.sessions.set(e.session_id, (items = new Map()));
      items.set(key, { key, kind: 'approval', summary: e.summary, since: e.ts, event: e.id, call_id: call });
      return true;
    }
    if (e.kind === 'user.question' && call && (e.status === 'pending' || e.status === 'started')) {
      if (!items) this.sessions.set(e.session_id, (items = new Map()));
      items.set(`ask:${call}`, { key: `ask:${call}`, kind: 'question', summary: e.summary, since: e.ts, event: e.id, call_id: call });
      return true;
    }
    if (call && (e.status === 'succeeded' || e.status === 'failed' || e.status === 'cancelled')) {
      const a = drop(`perm:${call}`);
      const b = drop(`ask:${call}`);
      return a || b;
    }
    return false;
  }
}
