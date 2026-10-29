import fs from 'node:fs';
import path from 'node:path';
import type { CanonicalEvent, SessionInfo } from '../core/schema.js';

export interface LineParser {
  parse(line: string, lineNo: number): CanonicalEvent[];
  readonly session: SessionInfo | undefined;
}

export interface TailerOptions {
  root: string;
  list: (root: string, modifiedAfter: number) => string[];
  accept: (file: string) => boolean;
  createParser: (file: string) => LineParser;
  onEvents: (events: CanonicalEvent[], session: SessionInfo | undefined) => void;
  /** Only files modified after this time are read on startup and rescans. */
  since: number;
  pollMs?: number;
}

interface Tracked { offset: number; lineNo: number; rest: Buffer; parser: LineParser; size: number }

const CHUNK = 1 << 20;
const NL = 0x0a;

/**
 * Follows append-only JSONL files. Reads only complete lines (a half-written line waits for its newline),
 * survives truncation, and combines fs.watch (fast) with polling (reliable) so no write is missed.
 */
export class JsonlTailer {
  private files = new Map<string, Tracked>();
  private watcher?: fs.FSWatcher;
  private timer?: NodeJS.Timeout;
  private pending = new Set<string>();
  private flushing = false;

  constructor(private opts: TailerOptions) {}

  start() {
    for (const f of this.opts.list(this.opts.root, this.opts.since)) this.read(f);
    try {
      this.watcher = fs.watch(this.opts.root, { recursive: true }, (_type, name) => {
        if (name) this.schedule(path.join(this.opts.root, name.toString()));
      });
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = undefined; });
    } catch { /* recursive watch unsupported: polling still covers us */ }
    let ticks = 0;
    this.timer = setInterval(() => {
      for (const [f, t] of this.files) if (sizeOf(f) !== t.size) this.schedule(f);
      // Rescan for new files less often; fs.watch normally reports them first.
      if (++ticks % 5 === 0) for (const f of this.opts.list(this.opts.root, Date.now() - 60 * 60_000)) if (!this.files.has(f)) this.schedule(f);
    }, this.opts.pollMs ?? 1000);
  }

  stop() {
    this.watcher?.close();
    clearInterval(this.timer);
  }

  get tracked() { return this.files.size; }

  private schedule(file: string) {
    if (!this.opts.accept(file)) return;
    this.pending.add(file);
    if (this.flushing) return;
    this.flushing = true;
    setImmediate(() => {
      this.flushing = false;
      const batch = [...this.pending];
      this.pending.clear();
      for (const f of batch) this.read(f);
    });
  }

  /** Reads everything appended since the last call. Synchronous so a file is never read twice concurrently. */
  read(file: string) {
    const size = sizeOf(file);
    if (size < 0) return;
    let t = this.files.get(file);
    if (!t || size < t.offset) {
      // New file, or truncated/replaced: start over. Event ids are stable, so re-reads are deduplicated downstream.
      t = { offset: 0, lineNo: 0, rest: Buffer.alloc(0), parser: this.opts.createParser(file), size: 0 };
      this.files.set(file, t);
    }
    t.size = size;
    if (size === t.offset) return;

    let fd: number;
    try { fd = fs.openSync(file, 'r'); } catch { return; }
    const events: CanonicalEvent[] = [];
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      while (t.offset < size) {
        const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - t.offset), t.offset);
        if (n <= 0) break;
        t.offset += n;
        const data = t.rest.length ? Buffer.concat([t.rest, buf.subarray(0, n)]) : buf.subarray(0, n);
        let start = 0;
        for (let i = data.indexOf(NL); i !== -1; i = data.indexOf(NL, start)) {
          t.lineNo++;
          const line = data.toString('utf8', start, i).trim();
          if (line) {
            try { events.push(...t.parser.parse(line, t.lineNo)); } catch { /* one bad record must not stop the stream */ }
          }
          start = i + 1;
        }
        // Keep the incomplete tail (copied: `buf` is reused on the next read).
        t.rest = Buffer.from(data.subarray(start));
      }
    } finally {
      fs.closeSync(fd);
    }
    if (events.length) this.opts.onEvents(events, t.parser.session);
  }
}

function sizeOf(file: string): number {
  try { return fs.statSync(file).size; } catch { return -1; }
}
