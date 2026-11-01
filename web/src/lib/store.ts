import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { applyEvent, initialState, type SessionState, type ZoneId } from '../../../src/core/state.ts';
import { buildActivities, emptyFilter, type Activity, type Filter } from './activities.ts';
import { playbackDelay, ReplayIndex } from './replay.ts';
import type { ShareBundle, ShareOptions } from '../../../src/core/share.ts';
import type { Health, SessionRow, StoredEvent } from './types.ts';

export type Connection = 'connecting' | 'live' | 'reconnecting' | 'offline';
export type Selection = { type: 'activity'; key: string } | { type: 'zone'; id: ZoneId } | null;

export interface AppState {
  connection: Connection;
  health?: Health;
  sessions: SessionRow[];
  sessionsLoaded: boolean;
  sessionId?: string;
  events: StoredEvent[];
  activities: Activity[];
  loading: boolean;
  error?: string;
  live: SessionState;
  /** Number of events applied while replaying; null follows the live edge. */
  cursor: number | null;
  playing: boolean;
  speed: number;
  selection: Selection;
  filter: Filter;
  showCoverage: boolean;
  showShortcuts: boolean;
  showShare: boolean;
  /** A short message about something the user just did (import, export, remove). */
  notice?: { tone: 'ok' | 'error'; text: string };
  /** The workspace map fills the window. */
  expanded: boolean;
  /** Sessions list docked beside the page (wide screens; remembered). */
  sidebar: boolean;
  /** Sessions list open as a drawer over the page (narrow screens). */
  drawer: boolean;
}

/** Below this width the sessions list is a drawer instead of a column. Keep in step with styles.css. */
export const NARROW = '(max-width: 860px)';
const SIDEBAR_KEY = 'be.sidebar';

function readSidebar(): boolean {
  try { return localStorage.getItem(SIDEBAR_KEY) !== 'closed'; } catch { return true; }
}

type Listener = () => void;

class Store {
  state: AppState = {
    connection: 'connecting', sessions: [], sessionsLoaded: false, events: [], activities: [], loading: false,
    live: initialState(''), cursor: null, playing: false, speed: 4, selection: null, filter: emptyFilter(),
    showCoverage: false, showShortcuts: false, showShare: false, expanded: false, sidebar: readSidebar(), drawer: false,
  };
  /** performance.now() when the newest live events arrived; the world measures event-to-pixel latency from it. */
  arrivedAt = 0;
  private listeners = new Set<Listener>();
  private replay?: ReplayIndex;
  private ws?: WebSocket;
  private retry = 0;
  private playTimer?: number;
  private loadToken = 0;
  /** Bumped by every session list the server pushes: a fetch that started before one is out of date. */
  private sessionsVersion = 0;
  private pending: StoredEvent[] = [];
  private frame?: number;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  private started = false;

  async start() {
    if (this.started) return;
    this.started = true;
    const params = new URLSearchParams(location.search);
    const wanted = params.get('session') ?? undefined;
    const sel = params.get('sel');
    await this.refreshSessions();
    const id = wanted && this.state.sessions.some(s => s.id === wanted) ? wanted : this.state.sessions[0]?.id;
    if (id) await this.selectSession(id, sel ? { type: 'activity', key: sel } : null);
    this.connect();
    void this.refreshHealth();
    window.setInterval(() => void this.refreshHealth(), 15_000);
  }

  private async refreshSessions() {
    const version = this.sessionsVersion;
    try {
      const sessions = await getJson<SessionRow[]>('/api/sessions');
      // A push arrived while this was in flight: it is newer (it may carry what is waiting for you), keep it.
      if (version !== this.sessionsVersion) return void this.set({ sessionsLoaded: true });
      this.set({ sessions, sessionsLoaded: true });
    } catch {
      this.set({ sessionsLoaded: true, connection: 'offline' });
    }
  }

  private async refreshHealth() {
    try { this.set({ health: await getJson<Health>('/api/health') }); } catch { /* shown via connection state */ }
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.set({ connection: 'live' });
      // Anything that happened while not connected, including between the first load and this first connection.
      void this.refreshSessions();
      void this.backfill();
    };
    ws.onmessage = m => {
      const msg = JSON.parse(String(m.data));
      if (msg.type === 'sessions') {
        this.sessionsVersion++;
        this.set({ sessions: msg.sessions });
      }
      if (msg.type === 'events') this.receive(msg.events as StoredEvent[]);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.retry++;
      this.set({ connection: this.retry > 5 ? 'offline' : 'reconnecting' });
      window.setTimeout(() => this.connect(), Math.min(10_000, 500 * 2 ** this.retry));
    };
  }

  // ── session data ───────────────────────────────────────────────────────────

  async selectSession(id: string, selection: Selection = null) {
    const token = ++this.loadToken;
    this.stopPlayback();
    this.set({ sessionId: id, loading: true, error: undefined, events: [], activities: [], live: initialState(id), cursor: null, selection, filter: emptyFilter() });
    this.syncUrl();
    try {
      const events = await getJson<StoredEvent[]>(`/api/sessions/${encodeURIComponent(id)}/events`);
      if (token !== this.loadToken) return;
      const live = initialState(id);
      for (const e of events) applyEvent(live, e);
      this.replay = new ReplayIndex(id, events);
      this.set({ events, activities: buildActivities(events), live, loading: false });
    } catch (err) {
      if (token === this.loadToken) this.set({ loading: false, error: `Could not load this session (${String(err)})` });
    }
  }

  /** Live events arrive in batches; coalesce into one render per animation frame. */
  private receive(events: StoredEvent[]) {
    const id = this.state.sessionId;
    if (events.some(e => e.session_id === id)) this.arrivedAt = performance.now();
    this.pending.push(...events.filter(e => e.session_id === id));
    if (!id && events.length) void this.refreshSessions().then(() => {
      const first = this.state.sessions[0];
      if (first && !this.state.sessionId) void this.selectSession(first.id);
    });
    if (this.frame === undefined && this.pending.length) this.frame = requestAnimationFrame(() => this.flush());
  }

  private flush() {
    this.frame = undefined;
    const batch = this.pending;
    this.pending = [];
    if (!batch.length || this.state.loading) {
      if (this.state.loading) this.pending.unshift(...batch);
      return;
    }
    const last = this.state.events.at(-1)?.seq ?? 0;
    const fresh = batch.filter(e => e.seq > last).sort((a, b) => a.seq - b.seq);
    if (!fresh.length) return;
    // A gap means we missed something (e.g. during a reconnect): fetch it rather than show a hole.
    if (fresh[0]!.seq !== last + 1) return void this.backfill();
    this.append(fresh);
  }

  private async backfill() {
    const id = this.state.sessionId;
    if (!id) return;
    const after = this.state.events.at(-1)?.seq ?? 0;
    try {
      const missing = await getJson<StoredEvent[]>(`/api/sessions/${encodeURIComponent(id)}/events?after=${after}`);
      if (id === this.state.sessionId && missing.length) this.append(missing.filter(e => e.seq > (this.state.events.at(-1)?.seq ?? 0)));
    } catch { /* next reconnect retries */ }
  }

  private append(fresh: StoredEvent[]) {
    if (!fresh.length) return;
    const events = this.state.events.concat(fresh);
    const live = this.state.live;
    for (const e of fresh) applyEvent(live, e);
    this.replay = new ReplayIndex(this.state.sessionId!, events);
    this.set({ events, activities: buildActivities(events), live: { ...live } });
  }

  // ── replay ─────────────────────────────────────────────────────────────────

  /** The state the UI should show: live, or the replay position. */
  view(): SessionState {
    const { cursor, live } = this.state;
    return cursor === null || !this.replay ? live : this.replay.at(cursor);
  }

  seek(count: number | null) {
    if (count !== null && count >= this.state.events.length) count = null;
    this.set({ cursor: count === null ? null : Math.max(0, count) });
  }

  step(delta: number) {
    const n = this.state.events.length;
    this.stopPlayback();
    this.seek((this.state.cursor ?? n) + delta);
  }

  togglePlay() {
    if (this.state.playing) return this.stopPlayback();
    if (this.state.cursor === null) this.seek(0);
    this.set({ playing: true });
    this.tick();
  }

  setSpeed(speed: number) { this.set({ speed }); }

  goLive() {
    this.stopPlayback();
    this.seek(null);
  }

  private tick() {
    const { cursor, events, speed, playing } = this.state;
    if (!playing || cursor === null) return;
    if (cursor >= events.length) return this.goLive();
    const delay = playbackDelay(events[cursor - 1], events[cursor], speed);
    this.playTimer = window.setTimeout(() => {
      this.seek((this.state.cursor ?? 0) + 1);
      this.tick();
    }, delay);
  }

  private stopPlayback() {
    window.clearTimeout(this.playTimer);
    if (this.state.playing) this.set({ playing: false });
  }

  // ── UI state ───────────────────────────────────────────────────────────────

  select(selection: Selection) {
    this.set({ selection });
    this.syncUrl();
  }

  /** Closes the details panel; closing a zone also drops the filter that zone applied. */
  clearSelection() {
    if (this.state.selection?.type === 'zone') this.setFilter({ categories: new Set(), failedOnly: false });
    this.select(null);
  }

  setFilter(patch: Partial<Filter>) {
    this.set({ filter: { ...this.state.filter, ...patch } });
  }

  toggleCoverage(show = !this.state.showCoverage) {
    // Hook counters change as prompts open: show them fresh.
    if (show) void this.refreshHealth();
    this.set({ showCoverage: show });
  }
  toggleShortcuts(show = !this.state.showShortcuts) { this.set({ showShortcuts: show }); }
  toggleShare(show = !this.state.showShare) { this.set({ showShare: show }); }

  // ── sharing ────────────────────────────────────────────────────────────────

  private noticeTimer = 0;
  notify(tone: 'ok' | 'error', text: string) {
    window.clearTimeout(this.noticeTimer);
    this.set({ notice: { tone, text } });
    this.noticeTimer = window.setTimeout(() => this.set({ notice: undefined }), tone === 'error' ? 8000 : 4000);
  }

  /** The open session as a shareable file, with what the user chose to leave out. */
  exportSession(options: ShareOptions): Promise<ShareBundle> {
    const q = new URLSearchParams({ prompts: options.prompts ? '1' : '0', outputs: options.outputs ? '1' : '0', diffs: options.diffs ? '1' : '0' });
    return getJson<ShareBundle>(`/api/sessions/${encodeURIComponent(this.state.sessionId!)}/export?${q}`);
  }

  /** Adds a shared session file (picked, dropped, or bundled) and opens it. Returns its id, or undefined on failure. */
  async importSession(text: string, label = 'the file'): Promise<string | undefined> {
    let body: unknown;
    try { body = JSON.parse(text); } catch { this.notify('error', `${label} is not a session file (it is not JSON).`); return; }
    const r = await fetch('/api/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const res = await r.json().catch(() => ({})) as { id?: string; error?: string };
    if (!r.ok || !res.id) { this.notify('error', res.error ?? `Could not open ${label} (${r.status}).`); return; }
    await this.refreshSessions();
    void this.selectSession(res.id);
    return res.id;
  }

  async importFile(file: File) {
    if (await this.importSession(await file.text(), file.name)) this.notify('ok', `Opened ${file.name}`);
  }

  /** The three bundled demo sessions (Claude Code, Codex, Copilot), synthetic, to explore before a real one exists. */
  async openDemo() {
    let first: string | undefined;
    for (const name of ['demo-claude-code', 'demo-codex', 'demo-copilot-cli']) {
      const r = await fetch(`./${name}.json`);
      if (!r.ok) continue;
      const id = await this.importSession(await r.text(), 'the demo');
      first ??= id;
    }
    if (first) {
      void this.selectSession(first);
      this.notify('ok', 'Opened three demo sessions. Remove them from the session header when you are done.');
    }
  }

  async removeShared(id: string) {
    const r = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok) return this.notify('error', 'Could not remove this session.');
    await this.refreshSessions();
    const next = this.state.sessions[0]?.id;
    if (next) void this.selectSession(next);
    else this.set({ sessionId: undefined, events: [], activities: [] });
    this.notify('ok', 'Removed the shared session.');
  }
  toggleExpanded(on = !this.state.expanded) { this.set({ expanded: on }); }

  /** Shows or hides the sessions list: collapses the column on wide screens, opens the drawer on narrow ones. */
  toggleSidebar() {
    if (matchMedia(NARROW).matches) return this.set({ drawer: !this.state.drawer });
    const sidebar = !this.state.sidebar;
    this.set({ sidebar });
    try { localStorage.setItem(SIDEBAR_KEY, sidebar ? 'open' : 'closed'); } catch { /* private mode */ }
  }

  closeDrawer() { if (this.state.drawer) this.set({ drawer: false }); }

  private syncUrl() {
    const p = new URLSearchParams();
    if (this.state.sessionId) p.set('session', this.state.sessionId);
    if (this.state.selection?.type === 'activity') p.set('sel', this.state.selection.key);
    history.replaceState(null, '', `${location.pathname}?${p}`);
  }
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json() as Promise<T>;
}

export const store = new Store();
export { getJson };

export function useApp<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.state));
}

/** True while a media query matches, e.g. `useMedia(NARROW)`. */
export function useMedia(query: string): boolean {
  const mq = useMemo(() => matchMedia(query), [query]);
  return useSyncExternalStore(cb => {
    mq.addEventListener('change', cb);
    return () => mq.removeEventListener('change', cb);
  }, () => mq.matches);
}

/** Which assistant the open session belongs to (decides, among other things, who the agents look like). */
export function useAssistant(): string {
  return useApp(s => s.sessions.find(x => x.id === s.sessionId)?.assistant ?? 'claude-code');
}

/** The session state at the replay cursor, or live. Recomputed only when the cursor or data changes. */
export function useView(): SessionState {
  const cursor = useApp(s => s.cursor);
  const live = useApp(s => s.live);
  const events = useApp(s => s.events);
  return useMemo(() => store.view(), [cursor, live, events]);
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

// Full events (outputs, diffs, texts) are fetched on demand for the inspector; the list holds the light form.
const fullCache = new Map<string, Promise<StoredEvent>>();
const FULL_CACHE_MAX = 500;

export function useFullEvent(e: StoredEvent | undefined): StoredEvent | undefined {
  const [full, setFull] = useState<StoredEvent>();
  const id = e?.id;
  useEffect(() => {
    setFull(undefined);
    if (!id) return;
    let p = fullCache.get(id);
    if (!p) {
      p = getJson<StoredEvent>(`/api/events/${encodeURIComponent(id)}`);
      fullCache.set(id, p);
      p.catch(() => fullCache.delete(id));
      if (fullCache.size > FULL_CACHE_MAX) fullCache.delete(fullCache.keys().next().value!);
    }
    let current = true;
    p.then(f => { if (current) setFull(f); }, () => {});
    return () => { current = false; };
  }, [id]);
  return full?.id === id ? full : e;
}
