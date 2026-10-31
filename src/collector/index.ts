import os from 'node:os';
import path from 'node:path';
import { createClaudeParser } from '../adapters/claude-code/parse.js';
import { CLAUDE_PROJECTS, isTranscript, listTranscripts } from '../adapters/claude-code/discover.js';
import { createCodexParser } from '../adapters/codex/parse.js';
import { CODEX_SESSIONS, isRollout, listRollouts } from '../adapters/codex/discover.js';
import { createCopilotParser } from '../adapters/copilot-cli/parse.js';
import { COPILOT_SESSIONS, isSessionLog, listSessionLogs } from '../adapters/copilot-cli/discover.js';
import type { Assistant, CanonicalEvent, SessionInfo } from '../core/schema.js';
import { WaitingTracker } from '../core/waiting.js';
import { HOOK_ASSISTANTS, status, type HookAssistant } from '../hooks/install.js';
import { createBridge } from './bridge.js';
import { createServer } from './server.js';
import { Store, type StoredEvent } from './store.js';
import { JsonlTailer, type LineParser } from './tailer.js';

export const DEFAULT_PORT = 47821;
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
    hook: (assistant, body) => {
      if (!(HOOK_ASSISTANTS as string[]).includes(assistant)) return false;
      bridge.ingest(assistant as HookAssistant, body);
      return true;
    },
    health: () => ({
      ok: true, started_at: startedAt,
      sources: sources.map(src => {
        const h = hookStatus(src.assistant);
        return {
          assistant: src.assistant, capture: 'log', root: src.root, files: src.tailer.tracked, watching: true,
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
