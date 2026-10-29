export function clock(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function dateTime(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' });
}

export function duration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function ago(ts: string | undefined, now: number): string {
  if (!ts) return '';
  const s = Math.max(0, (now - Date.parse(ts)) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const LIVE_WINDOW_MS = 90_000;
export const isLive = (ts: string | undefined, now: number) => !!ts && now - Date.parse(ts) < LIVE_WINDOW_MS;

export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function project(cwd: string | undefined): string {
  if (!cwd) return 'Unknown project';
  return cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd;
}

export function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}
