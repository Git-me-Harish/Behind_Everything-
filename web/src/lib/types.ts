import type { CanonicalEvent, SessionInfo } from '../../../src/core/schema.ts';
import type { WaitingItem } from '../../../src/core/waiting.ts';

export type { WaitingItem };

/** Mirrors the collector API (src/collector/store.ts). */
export interface StoredEvent extends CanonicalEvent { seq: number }
/** `waiting`: what the session is waiting on you for right now (approvals, questions). */
export interface SessionRow extends SessionInfo { event_count: number; waiting?: WaitingItem[] }

/** The opt-in hook bridge for an assistant: installed, and what the collector has received since it started. */
export interface HookHealth { installed: boolean; port_matches: boolean; events: number; matched: number; unmatched: number; last?: string }

export interface Health {
  ok: boolean;
  started_at: string;
  sources: Array<{ assistant: string; capture: string; root: string; exists?: boolean; files: number; watching: boolean; hooks?: HookHealth }>;
}

export interface Evidence { file: string; line: number; record: unknown }
