import type { CanonicalEvent, SessionInfo } from '../../../src/core/schema.ts';

/** Mirrors the collector API (src/collector/store.ts). */
export interface StoredEvent extends CanonicalEvent { seq: number }
export interface SessionRow extends SessionInfo { event_count: number }

export interface Health {
  ok: boolean;
  started_at: string;
  sources: Array<{ assistant: string; capture: string; root: string; files: number; watching: boolean }>;
}

export interface Evidence { file: string; line: number; record: unknown }
