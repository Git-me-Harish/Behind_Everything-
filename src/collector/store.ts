import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { CanonicalEvent, SessionInfo } from '../core/schema.js';

export interface StoredEvent extends CanonicalEvent { seq: number }
export interface SessionRow extends SessionInfo { event_count: number }

/** Append-only local event store. Events are already redacted when they arrive here. */
export class Store {
  private db: Database.Database;
  private seqs = new Map<string, number>();

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, assistant TEXT NOT NULL, native_id TEXT NOT NULL, cwd TEXT, git_branch TEXT,
        title TEXT, model TEXT, version TEXT, source_path TEXT NOT NULL, started_at TEXT NOT NULL, last_ts TEXT NOT NULL,
        event_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS events_by_session ON events (session_id, seq);
    `);
  }

  /**
   * Inserts events. An event already stored keeps its sequence number but takes the new content, so
   * re-reading a transcript with an improved adapter upgrades history. Returns only the new events.
   */
  insert(events: CanonicalEvent[]): StoredEvent[] {
    const insert = this.db.prepare('INSERT OR IGNORE INTO events (id, session_id, seq, ts, kind, json) VALUES (?, ?, ?, ?, ?, ?)');
    const update = this.db.prepare('UPDATE events SET ts = ?, kind = ?, json = ? WHERE id = ? AND json <> ?');
    const bump = this.db.prepare('UPDATE sessions SET event_count = event_count + ? WHERE id = ?');
    const added: StoredEvent[] = [];
    this.db.transaction(() => {
      const counts = new Map<string, number>();
      for (const e of events) {
        const seq = this.nextSeq(e.session_id);
        const json = JSON.stringify(e);
        if (insert.run(e.id, e.session_id, seq, e.ts, e.kind, json).changes === 0) {
          update.run(e.ts, e.kind, json, e.id, json);
          continue;
        }
        this.seqs.set(e.session_id, seq);
        added.push({ ...e, seq });
        counts.set(e.session_id, (counts.get(e.session_id) ?? 0) + 1);
      }
      for (const [id, n] of counts) bump.run(n, id);
    })();
    return added;
  }

  upsertSession(s: SessionInfo) {
    this.db.prepare(`
      INSERT INTO sessions (id, assistant, native_id, cwd, git_branch, title, model, version, source_path, started_at, last_ts)
      VALUES (@id, @assistant, @native_id, @cwd, @git_branch, @title, @model, @version, @source_path, @started_at, @last_ts)
      ON CONFLICT (id) DO UPDATE SET
        cwd = coalesce(excluded.cwd, cwd), git_branch = coalesce(excluded.git_branch, git_branch),
        title = coalesce(excluded.title, title), model = coalesce(excluded.model, model), version = coalesce(excluded.version, version),
        started_at = min(started_at, excluded.started_at), last_ts = max(last_ts, excluded.last_ts)
    `).run({ cwd: null, git_branch: null, title: null, model: null, version: null, ...s });
  }

  sessions(limit = 200): SessionRow[] {
    return this.db.prepare('SELECT * FROM sessions WHERE event_count > 0 ORDER BY last_ts DESC LIMIT ?').all(limit) as SessionRow[];
  }

  session(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }

  events(session_id: string, afterSeq = 0, limit = 100_000): StoredEvent[] {
    const rows = this.db.prepare('SELECT seq, json FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(session_id, afterSeq, limit) as Array<{ seq: number; json: string }>;
    return rows.map(r => ({ ...JSON.parse(r.json), seq: r.seq }));
  }

  event(id: string): StoredEvent | undefined {
    const r = this.db.prepare('SELECT seq, json FROM events WHERE id = ?').get(id) as { seq: number; json: string } | undefined;
    return r && { ...JSON.parse(r.json), seq: r.seq };
  }

  /** Drops events older than the retention window, and sessions left empty. */
  prune(retentionDays: number): number {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    const n = this.db.prepare('DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE last_ts < ?)').run(cutoff).changes;
    this.db.prepare('DELETE FROM sessions WHERE last_ts < ?').run(cutoff);
    this.seqs.clear();
    return n;
  }

  close() { this.db.close(); }

  private nextSeq(session_id: string): number {
    let seq = this.seqs.get(session_id);
    if (seq === undefined) {
      seq = (this.db.prepare('SELECT max(seq) AS m FROM events WHERE session_id = ?').get(session_id) as { m: number | null }).m ?? 0;
      this.seqs.set(session_id, seq);
    }
    return seq + 1;
  }
}
