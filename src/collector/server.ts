import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { redactValue } from '../core/redact.js';
import { liteEvent } from './lite.js';
import type { SessionRow, Store, StoredEvent } from './store.js';

export interface ServerOptions {
  port: number;
  /** Event storage, for session timelines and single events. */
  events: Pick<Store, 'session' | 'eventsJson' | 'event'>;
  /** The session list, with what each is waiting on you for. */
  sessions: () => SessionRow[];
  /** A hook call forwarded by an assistant; false if the assistant has no hook bridge. */
  hook: (assistant: string, body: Record<string, unknown>) => boolean;
  /** Built web client to serve at `/`, if present. */
  webRoot?: string;
  /** Extra origins allowed to connect (the Vite dev server in development). */
  devOrigins?: string[];
  health: () => Record<string, unknown>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

/**
 * Localhost-only API + live stream. Binds to 127.0.0.1 and rejects foreign Host/Origin headers,
 * so other web pages (or DNS-rebinding tricks) cannot read the developer's session data.
 */
export function createServer(opts: ServerOptions) {
  const hosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
  const origins = new Set([...[...hosts].map(h => `http://${h}`), ...(opts.devOrigins ?? [])]);
  const trusted = (req: http.IncomingMessage) => hosts.has(req.headers.host ?? '') && (!req.headers.origin || origins.has(req.headers.origin));

  const server = http.createServer((req, res) => {
    if (!trusted(req)) return send(res, 403, { error: 'forbidden' });
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      const hook = /^\/api\/hooks\/([\w-]+)$/.exec(url.pathname);
      if (hook && req.method === 'POST') return receiveHook(req, res, hook[1]!, opts.hook);
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      if (url.pathname === '/api/health') return send(res, 200, opts.health());
      if (url.pathname === '/api/sessions') return send(res, 200, opts.sessions());
      const m = /^\/api\/sessions\/([^/]+)\/events$/.exec(url.pathname);
      if (m) {
        const id = decodeURIComponent(m[1]!);
        if (!opts.events.session(id)) return send(res, 404, { error: 'unknown session' });
        return sendRaw(res, opts.events.eventsJson(id, Number(url.searchParams.get('after') ?? 0)));
      }
      const one = /^\/api\/events\/([^/]+)$/.exec(url.pathname);
      if (one) {
        const e = opts.events.event(decodeURIComponent(one[1]!));
        return e ? send(res, 200, e) : send(res, 404, { error: 'unknown event' });
      }
      const ev = /^\/api\/events\/([^/]+)\/evidence$/.exec(url.pathname);
      if (ev) return evidence(res, opts.events.event(decodeURIComponent(ev[1]!)));
      if (opts.webRoot) return serveStatic(res, opts.webRoot, url.pathname);
      return send(res, 200, { name: 'behind-everything', api: ['/api/health', '/api/sessions', '/api/sessions/:id/events', '/api/events/:id', '/api/events/:id/evidence', '/ws'] });
    } catch (err) {
      return send(res, 500, { error: String(err) });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!trusted(req) || new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  return {
    server,
    listen: () => new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.port, '127.0.0.1', () => resolve());
    }),
    broadcast(events: StoredEvent[]) {
      if (!events.length) return;
      const msg = JSON.stringify({ type: 'events', events: events.map(liteEvent) });
      for (const c of wss.clients as Set<WebSocket>) if (c.readyState === c.OPEN) c.send(msg);
    },
    broadcastSessions() {
      const msg = JSON.stringify({ type: 'sessions', sessions: opts.sessions() });
      for (const c of wss.clients as Set<WebSocket>) if (c.readyState === c.OPEN) c.send(msg);
    },
    close: () => new Promise<void>(resolve => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

/** Hook calls are small JSON objects; anything else is refused without being parsed. */
const MAX_HOOK_BODY = 256 * 1024;

function receiveHook(req: http.IncomingMessage, res: http.ServerResponse, assistant: string, hook: ServerOptions['hook']) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'expected application/json' });
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_HOOK_BODY) { send(res, 413, { error: 'too large' }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (size > MAX_HOOK_BODY) return;
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'invalid JSON' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'expected a JSON object' });
    if (!hook(assistant, body as Record<string, unknown>)) return send(res, 404, { error: 'no hook bridge for this assistant' });
    res.writeHead(204).end();
  });
}

/** The raw provider record behind an event, re-read from its source file and redacted on the way out. */
function evidence(res: http.ServerResponse, e: StoredEvent | undefined) {
  if (!e?.evidence) return send(res, 404, { error: 'no evidence for this event' });
  let line: string | undefined;
  try {
    line = fs.readFileSync(e.evidence.file, 'utf8').split('\n')[e.evidence.line - 1];
  } catch {
    return send(res, 410, { error: 'source file no longer available', file: e.evidence.file });
  }
  if (!line) return send(res, 410, { error: 'source line no longer available' });
  let record: unknown;
  try { record = JSON.parse(line); } catch { record = line; }
  return send(res, 200, { file: e.evidence.file, line: e.evidence.line, record: redactValue(record) });
}

function serveStatic(res: http.ServerResponse, root: string, pathname: string) {
  const safe = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  const base = path.resolve(root);
  let file = path.resolve(base, safe);
  if (file !== base && !file.startsWith(base + path.sep)) return send(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  if (!fs.existsSync(file)) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}

function sendRaw(res: http.ServerResponse, json: string) {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(json);
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}
