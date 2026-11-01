import { useEffect, useRef, useState } from 'react';
import { assistantMeta } from './meta.ts';
import { store, useApp } from './store.ts';
import type { SessionRow } from './types.ts';

/**
 * Tells you when an agent is waiting for you (an approval or a question) in any session, not just the one on
 * screen: a count in the tab title always, and a desktop notification if you turned them on.
 */

const PREF = 'be.notify';
const supported = () => typeof window !== 'undefined' && 'Notification' in window;

function readPref(): boolean {
  try { return localStorage.getItem(PREF) === 'on'; } catch { return false; }
}

export type NotifyState = 'unsupported' | 'blocked' | 'on' | 'off';

/** The notification preference, and a toggle that asks the browser for permission the first time. */
export function useNotifyPreference(): [NotifyState, () => void] {
  const [on, setOn] = useState(readPref);
  const [permission, setPermission] = useState<NotificationPermission>(() => (supported() ? Notification.permission : 'denied'));
  const state: NotifyState = !supported() ? 'unsupported' : permission === 'denied' ? 'blocked' : on && permission === 'granted' ? 'on' : 'off';
  const toggle = async () => {
    if (!supported() || permission === 'denied') return;
    let p: NotificationPermission = permission;
    if (!on && p === 'default') setPermission((p = await Notification.requestPermission()));
    const next = !on && p === 'granted';
    setOn(next);
    try { localStorage.setItem(PREF, next ? 'on' : 'off'); } catch { /* preference just isn't remembered */ }
  };
  return [state, () => void toggle()];
}

export const waitingCount = (sessions: SessionRow[]) => sessions.reduce((n, s) => n + (s.waiting?.length ?? 0), 0);

export function useWaitingAlerts() {
  const sessions = useApp(s => s.sessions);
  const loaded = useApp(s => s.sessionsLoaded);
  const seen = useRef<Set<string> | null>(null);
  const baseTitle = useRef(document.title);

  useEffect(() => {
    const n = waitingCount(sessions);
    document.title = n ? `(${n}) Waiting · ${baseTitle.current}` : baseTitle.current;
  }, [sessions]);

  useEffect(() => {
    if (!loaded) return;
    const now = new Set(sessions.flatMap(s => (s.waiting ?? []).map(w => `${s.id}|${w.key}`)));
    // What was already waiting when the page opened is shown, not announced.
    if (seen.current === null) { seen.current = now; return; }
    const fresh = sessions.flatMap(s => (s.waiting ?? []).filter(w => !seen.current!.has(`${s.id}|${w.key}`)).map(w => ({ s, w })));
    seen.current = now;
    if (!fresh.length || !readPref() || !supported() || Notification.permission !== 'granted') return;
    for (const { s, w } of fresh) {
      // Already looking at it: the map and the timeline say so.
      if (!document.hidden && store.state.sessionId === s.id) continue;
      const meta = assistantMeta(s.assistant);
      const n = new Notification(`${meta.agent} is waiting for you`, { body: `${w.summary.replace(/^Waiting for approval: /, 'Approve: ')}\n${s.title ?? ''}`.trim(), tag: `${s.id}|${w.key}` });
      n.onclick = () => { window.focus(); void store.selectSession(s.id); n.close(); };
    }
  }, [sessions, loaded]);
}
