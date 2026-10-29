import os from 'node:os';
import path from 'node:path';
import { createClaudeParser } from '../adapters/claude-code/parse.js';
import { CLAUDE_PROJECTS, isTranscript, listTranscripts } from '../adapters/claude-code/discover.js';
import { createServer } from './server.js';
import { Store, type StoredEvent } from './store.js';
import { JsonlTailer } from './tailer.js';

export const DEFAULT_PORT = 47821;
export const DATA_DIR = process.env.BE_HOME ?? path.join(os.homedir(), '.behind-everything');

export interface CollectorOptions {
  port?: number;
  /** Read transcripts modified within this many days on startup. */
  sinceDays?: number;
  retentionDays?: number;
  dbPath?: string;
  claudeRoot?: string;
  webRoot?: string;
  devOrigins?: string[];
  onEvents?: (events: StoredEvent[]) => void;
}

export async function startCollector(o: CollectorOptions = {}) {
  const port = o.port ?? DEFAULT_PORT;
  const store = new Store(o.dbPath ?? path.join(DATA_DIR, 'events.sqlite'));
  const pruned = store.prune(o.retentionDays ?? 30);
  const root = o.claudeRoot ?? CLAUDE_PROJECTS;
  const startedAt = new Date().toISOString();

  const api = createServer({
    port, store, webRoot: o.webRoot, devOrigins: o.devOrigins,
    health: () => ({
      ok: true, started_at: startedAt,
      sources: [{ assistant: 'claude-code', capture: 'log', root, files: tailer.tracked, watching: true }],
    }),
  });

  let sessionsDirty = false;
  const tailer = new JsonlTailer({
    root,
    since: Date.now() - (o.sinceDays ?? 7) * 86_400_000,
    list: (r, after) => listTranscripts(r, after),
    accept: f => isTranscript(f, root),
    createParser: createClaudeParser,
    onEvents: (events, session) => {
      if (session) store.upsertSession(session);
      const added = store.insert(events);
      if (!added.length) return;
      sessionsDirty = true;
      api.broadcast(added);
      o.onEvents?.(added);
    },
  });

  await api.listen();
  tailer.start();
  // Session list updates are coalesced: titles and counts change with almost every event.
  const sessionTimer = setInterval(() => {
    if (sessionsDirty) { sessionsDirty = false; api.broadcastSessions(); }
  }, 500);

  return {
    port, store, pruned,
    url: `http://127.0.0.1:${port}`,
    async close() {
      clearInterval(sessionTimer);
      tailer.stop();
      await api.close();
      store.close();
    },
  };
}
