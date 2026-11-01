import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClaudeParser } from '../adapters/claude-code/parse.js';
import { CLAUDE_PROJECTS, isTranscript, listTranscripts } from '../adapters/claude-code/discover.js';
import { createCodexParser } from '../adapters/codex/parse.js';
import { CODEX_SESSIONS, isRollout, listRollouts } from '../adapters/codex/discover.js';
import { createCopilotParser } from '../adapters/copilot-cli/parse.js';
import { COPILOT_SESSIONS, isSessionLog, listSessionLogs } from '../adapters/copilot-cli/discover.js';
import type { Assistant, CanonicalEvent, SessionInfo } from '../core/schema.js';
import { exportSession, importBundle } from '../core/share.js';
import { WaitingTracker } from '../core/waiting.js';
import { HOOK_ASSISTANTS, status, type HookAssistant } from '../hooks/install.js';
import { createBridge } from './bridge.js';
import { createServer } from './server.js';
import { Store, type StoredEvent } from './store.js';
import { JsonlTailer, type LineParser } from './tailer.js';

export const DEFAULT_PORT = 47821;
/** The running version, from package.json (two levels up from src/collector and dist/collector alike). */
export const VERSION: string = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version; } catch { return 'dev'; }
})();
export const DATA_DIR = process.env.BE_HOME ?? path.join(os.homedir(), '.behind-everything');

export interface CollectorOptions {
  port?: number;
  /** Read transcripts modified within this many days on startup. */
  sinceDays?: number;
  retentionDays?: number;
  dbPath?: string;
  claudeRoot?: string;
  codexRoot?: string;
  copilotRoot?: string;
  /** Where to look for installed hooks (tests); defaults to each assistant's own config. */
  hookConfig?: Partial<Record<HookAssistant, string>>;
  webRoot?: string;
  devOrigins?: string[];
  onEvents?: (events: StoredEvent[]) => void;
}

export async function startCollector(o: CollectorOptions = {}) {
  const port = o.port ?? DEFAULT_PORT;
  const store = new Store(o.dbPath ?? path.join(DATA_DIR, 'events.sqlite'));
  const pruned = store.prune(o.retentionDays ?? 30);
  const startedAt = new Date().toISOString();
  const since = Date.now() - (o.sinceDays ?? 7) * 86_400_000;

  const waiting = new WaitingTracker();
  const hookStatus = (a: Assistant) => (HOOK_ASSISTANTS as string[]).includes(a) ? status(a as HookAssistant, o.hookConfig?.[a as HookAssistant]) : undefined;
  const api = createServer({
    port, webRoot: o.webRoot, devOrigins: o.devOrigins,
    events: store,
    sessions: () => store.sessions().map(s => ({ ...s, waiting: waiting.list(s.id) })),
    share: {
      export: (id, options) => {
        const s = store.session(id);
        return s && exportSession(s, store.events(id), options, { home: os.homedir(), appVersion: VERSION });
      },
      import: body => {
        const { session, events } = importBundle(body);
        onEvents(events, session);
        sessionsDirty = true;
        return session.id;
      },
      remove: id => {
        const removed = store.deleteSession(id);
        if (removed) sessionsDirty = true;
        return removed;
      },
    },
    hook: (assistant, body) => {
      if (!(HOOK_ASSISTANTS as string[]).includes(assistant)) return false;
      bridge.ingest(assistant as HookAssistant, body);
      return true;
    },
    health: () => ({
      ok: true, started_at: startedAt, version: VERSION, node: process.version,
      // Its own footprint, for `doctor` and the performance budget checks.
      process: { rss_mb: Math.round(process.memoryUsage().rss / 1e5) / 10, heap_mb: Math.round(process.memoryUsage().heapUsed / 1e5) / 10, heap_total_mb: Math.round(process.memoryUsage().heapTotal / 1e5) / 10, external_mb: Math.round(process.memoryUsage().external / 1e5) / 10, cpu_ms: Math.round((process.cpuUsage().user + process.cpuUsage().system) / 1000), uptime_s: Math.round(process.uptime()) },
      data_dir: path.dirname(o.dbPath ?? path.join(DATA_DIR, 'events.sqlite')),
      sources: sources.map(src => {
        const h = hookStatus(src.assistant);
        return {
          assistant: src.assistant, capture: 'log', root: src.root, exists: fs.existsSync(src.root), files: src.tailer.tracked, watching: true,
          ...(h ? { hooks: { installed: h.installed, port_matches: !h.installed || h.port === port, ...bridge.stats()[src.assistant as HookAssistant] } } : {}),
        };
      }),
    }),
  });

  let sessionsDirty = false;
  const onEvents = (events: CanonicalEvent[], session: SessionInfo | undefined) => {
    if (session) store.upsertSession(session);
    // Every parsed event, duplicates included: after a restart the bridge and the waiting list rebuild from them.
    bridge.observe(events);
    if (waiting.apply(events).size) sessionsDirty = true;
    const added = store.insert(events);
    if (!added.length) return;
    sessionsDirty = true;
    api.broadcast(added);
    o.onEvents?.(added);
  };
  const bridge = createBridge(events => onEvents(events, undefined));
  // One tailer per assistant: each knows where its logs live and how to read them.
  const source = (assistant: Assistant, root: string, list: (r: string, after: number) => string[], accept: (f: string, r: string) => boolean, createParser: (f: string) => LineParser) =>
    ({ assistant, root, tailer: new JsonlTailer({ root, since, list, accept: f => accept(f, root), createParser, onEvents }) });
  const sources = [
    source('claude-code', o.claudeRoot ?? CLAUDE_PROJECTS, listTranscripts, isTranscript, createClaudeParser),
    source('codex', o.codexRoot ?? CODEX_SESSIONS, listRollouts, isRollout, createCodexParser),
    source('copilot-cli', o.copilotRoot ?? COPILOT_SESSIONS, listSessionLogs, isSessionLog, createCopilotParser),
  ];

  await api.listen();
  for (const src of sources) src.tailer.start();
  // Session list updates are coalesced: titles and counts change with almost every event.
  const sessionTimer = setInterval(() => {
    bridge.sweep();
    if (sessionsDirty) { sessionsDirty = false; api.broadcastSessions(); }
  }, 500);

  return {
    port, store, pruned,
    url: `http://127.0.0.1:${port}`,
    async close() {
      clearInterval(sessionTimer);
      for (const src of sources) src.tailer.stop();
      await api.close();
      store.close();
    },
  };
}
