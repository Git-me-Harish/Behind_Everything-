#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_PORT, startCollector } from './collector/index.js';
import type { StoredEvent } from './collector/store.js';
import { runHooks } from './hooks/cli.js';

const HELP = `behind-everything: see what your AI coding agent is actually doing

Usage: behind-everything [options]
       behind-everything hooks <install | uninstall | status>   (see: hooks --help)

  -p, --port <n>       Port on 127.0.0.1 (default ${DEFAULT_PORT})
      --since <days>   Load sessions active in the last N days (default 7)
      --retention <d>  Keep stored sessions for N days (default 30)
  -q, --quiet          Don't print the live event feed
      --no-open        Don't open the browser
  -h, --help           Show this help
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    claude: { type: 'boolean' },
    codex: { type: 'boolean' },
    port: { type: 'string', short: 'p' },
    since: { type: 'string' },
    retention: { type: 'string' },
    quiet: { type: 'boolean', short: 'q' },
    'no-open': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (positionals[0] === 'hooks') {
  const action = values.help ? undefined : positionals[1];
  process.exit(await runHooks(action, { claude: values.claude, codex: values.codex, port: values.port ? Number(values.port) : DEFAULT_PORT }, s => process.stdout.write(s)));
}

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const STATUS: Record<string, string> = { started: paint(36, '▶'), pending: paint(33, '?'), succeeded: paint(32, '✓'), failed: paint(31, '✗'), cancelled: paint(90, '■') };
const QUIET_KINDS = new Set(['usage.tokens', 'assistant.reasoning', 'session.start', 'session.meta']);

// The first batch replays recent history; only print what happens after startup.
const liveFrom = new Date().toISOString();

function print(events: StoredEvent[]) {
  for (const e of events) {
    if (QUIET_KINDS.has(e.kind) || e.ts < liveFrom) continue;
    const time = e.ts.slice(11, 19);
    const status = e.status ? STATUS[e.status] ?? ' ' : ' ';
    const agent = e.agent_id === 'main' ? '' : paint(35, `[${e.agent_id.slice(0, 8)}] `);
    const extra = e.exit_code ? paint(31, ` exit ${e.exit_code}`) : e.duration_ms && e.duration_ms > 2000 ? paint(90, ` ${(e.duration_ms / 1000).toFixed(1)}s`) : '';
    process.stdout.write(`${paint(90, time)} ${status} ${agent}${paint(1, e.kind.padEnd(18))} ${e.summary}${extra}\n`);
  }
}

// The UI is built next to the compiled CLI (dist/web); when running from source, use the same build.
const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = [path.join(here, 'web'), path.join(here, '..', 'dist', 'web')].find(d => fs.existsSync(path.join(d, 'index.html')));

function openBrowser(url: string) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: true }).on('error', () => {}).unref();
}

const port = values.port ? Number(values.port) : DEFAULT_PORT;
try {
  const c = await startCollector({
    port,
    sinceDays: values.since ? Number(values.since) : undefined,
    retentionDays: values.retention ? Number(values.retention) : undefined,
    webRoot,
    devOrigins: process.env.BE_DEV_ORIGIN ? [process.env.BE_DEV_ORIGIN] : undefined,
    onEvents: values.quiet ? undefined : print,
  });
  const sessions = c.store.sessions();
  process.stdout.write(`${paint(1, 'Behind Everything')} collector on ${paint(36, c.url)}\n`);
  process.stdout.write(`Watching Claude Code, Codex and Copilot logs · ${sessions.length} session(s) loaded${c.pruned ? ` · pruned ${c.pruned} old events` : ''}\n`);
  if (webRoot) {
    process.stdout.write(`Open ${paint(36, c.url)} to see it live\n`);
    if (!values['no-open'] && !process.env.BE_DEV_ORIGIN) openBrowser(c.url);
  } else {
    process.stdout.write(paint(33, "UI not built yet. Run 'pnpm build:web'. The API works meanwhile.\n"));
  }
  process.stdout.write(paint(90, 'Waiting for live activity… (Ctrl+C to stop)\n'));
  const stop = async () => { await c.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    process.stderr.write(`Port ${port} is already in use. Is Behind Everything already running? Try --port.\n`);
    process.exit(1);
  }
  throw err;
}
