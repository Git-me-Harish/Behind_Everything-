import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_PROJECTS, listTranscripts } from './adapters/claude-code/discover.js';
import { CODEX_SESSIONS, listRollouts } from './adapters/codex/discover.js';
import { COPILOT_SESSIONS, listSessionLogs } from './adapters/copilot-cli/discover.js';
import { codexNotes, dataDir, status, type HookAssistant } from './hooks/install.js';

/**
 * `behind-everything doctor`: checks everything that has to be right for Behind Everything to work, and says what to
 * do about anything that is not. Each check is a plain function returning findings, so they can be tested.
 */

export type Level = 'ok' | 'warn' | 'fail' | 'info';
export interface Finding { level: Level; title: string; detail?: string; fix?: string }

const WEEK = 7 * 86_400_000;

export function checkNode(version = process.versions.node): Finding {
  const major = Number(version.split('.')[0]);
  return major >= 22
    ? { level: 'ok', title: `Node.js ${version}` }
    : { level: 'warn', title: `Node.js ${version} is older than supported`, detail: 'Behind Everything is built for Node.js 22 or newer. Node 20 has no prebuilt SQLite binary, so installs need a C++ toolchain.', fix: 'Install Node.js 22 or 24 LTS from https://nodejs.org' };
}

export async function checkStorage(dir = dataDir()): Promise<Finding[]> {
  const out: Finding[] = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.doctor-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
    out.push({ level: 'ok', title: `Data folder is writable`, detail: dir });
  } catch (err) {
    out.push({ level: 'fail', title: 'Cannot write the data folder', detail: `${dir}: ${(err as Error).message}`, fix: 'Point BE_HOME at a folder you can write to, or fix the folder\'s permissions.' });
  }
  try {
    const { default: Database } = await import('better-sqlite3');
    new Database(':memory:').close();
    out.push({ level: 'ok', title: 'SQLite works' });
  } catch (err) {
    out.push({ level: 'fail', title: 'SQLite (better-sqlite3) did not load', detail: (err as Error).message, fix: 'Use Node.js 22 or newer, then reinstall: npx clear-npx-cache && npx behind-everything' });
  }
  return out;
}

/** What answers on the port: Behind Everything (and how it is doing), something else, or nothing. */
export async function checkPort(port: number): Promise<{ finding: Finding; health?: any }> {
  const health = await new Promise<any>(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(undefined));
    req.on('timeout', () => { req.destroy(); resolve(undefined); });
  });
  if (health?.ok) {
    const p = health.process;
    return { health, finding: { level: 'ok', title: `Behind Everything is running on http://127.0.0.1:${port}`, detail: p ? `version ${health.version ?? '?'}, up ${Math.round(p.uptime_s / 60)} min, using ${p.rss_mb} MB` : undefined } };
  }
  const free = await new Promise<boolean>(resolve => {
    const srv = net.createServer().once('error', () => resolve(false)).once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
  return free
    ? { finding: { level: 'info', title: `Not running on port ${port}`, fix: 'Start it with: npx behind-everything' } }
    : { finding: { level: 'fail', title: `Port ${port} is taken by another program`, fix: `Start Behind Everything on another port: npx behind-everything --port ${port + 1}` } };
}

const ASSISTANTS: Array<{ name: string; env: string; root: string; list: (root: string, after: number) => string[] }> = [
  { name: 'Claude Code', env: 'CLAUDE_CONFIG_DIR', root: CLAUDE_PROJECTS, list: listTranscripts },
  { name: 'Codex', env: 'CODEX_HOME', root: CODEX_SESSIONS, list: listRollouts },
  { name: 'Copilot CLI', env: 'COPILOT_HOME', root: COPILOT_SESSIONS, list: listSessionLogs },
];

/** Whether each assistant's logs are where we look, and how recent they are. */
export function checkLogs(roots: Record<string, string> = Object.fromEntries(ASSISTANTS.map(a => [a.name, a.root])), now = Date.now()): Finding[] {
  const found: Finding[] = ASSISTANTS.map((a): Finding => {
    const root = roots[a.name] ?? a.root;
    if (!fs.existsSync(root)) return { level: 'info', title: `${a.name}: no logs found`, detail: `Looked in ${root} (set ${a.env} if it lives elsewhere). Fine if you do not use ${a.name}.` };
    const recent = a.list(root, now - WEEK).length;
    const all = a.list(root, 0).length;
    return recent
      ? { level: 'ok', title: `${a.name}: ${recent} session${recent === 1 ? '' : 's'} in the last 7 days`, detail: root }
      : { level: 'info', title: `${a.name}: no sessions in the last 7 days${all ? ` (${all} older)` : ''}`, detail: `${root}. Older sessions load with --since <days>.` };
  });
  if (found.every(f => f.level !== 'ok')) found.push({ level: 'warn', title: 'No recent sessions from any assistant', fix: 'Use Claude Code, Codex or Copilot CLI in a project; its session appears within a moment.' });
  return found;
}

export function checkHooks(port: number, files: Partial<Record<HookAssistant, string>> = {}): Finding[] {
  const out: Finding[] = [];
  for (const [a, name] of [['claude-code', 'Claude Code'], ['codex', 'Codex']] as const) {
    const s = status(a, files[a]);
    if (s.error) out.push({ level: 'warn', title: `${name} hook: cannot read ${s.file}`, detail: s.error });
    else if (!s.installed) out.push({ level: 'info', title: `${name} hook: not installed (optional)`, detail: 'Approval prompts show once answered. To see them while they wait: npx behind-everything hooks install' });
    else if (s.port !== port) out.push({ level: 'warn', title: `${name} hook points at port ${s.port}, not ${port}`, fix: `npx behind-everything hooks install --port ${port}` });
    else out.push({ level: 'ok', title: `${name} hook installed`, detail: a === 'codex' ? codexNotes().at(-1) : undefined });
  }
  return out;
}

export async function runDoctor(port: number, out: (s: string) => void): Promise<number> {
  const color = process.stdout.isTTY && !process.env.NO_COLOR;
  const paint = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const MARK: Record<Level, string> = { ok: paint(32, '✓'), warn: paint(33, '!'), fail: paint(31, '✗'), info: paint(36, '·') };
  const sections: Array<[string, Finding[]]> = [];
  sections.push(['System', [checkNode(), { level: 'info', title: `${os.type()} ${os.release()} (${process.arch})` }, ...(await checkStorage())]]);
  const { finding, health } = await checkPort(port);
  const running: Finding[] = [finding];
  if (health) {
    for (const s of health.sources ?? []) if (s.hooks?.unmatched) running.push({ level: 'warn', title: `${s.assistant}: ${s.hooks.unmatched} hook call(s) did not match a running call`, detail: 'Usually harmless; if it keeps happening, report it.' });
  }
  sections.push(['Behind Everything', running]);
  sections.push(['Assistant logs', checkLogs()]);
  sections.push(['Optional hook bridge', checkHooks(port)]);
  for (const [title, findings] of sections) {
    out(`\n${paint(1, title)}\n`);
    for (const f of findings) {
      out(`  ${MARK[f.level]} ${f.title}\n`);
      if (f.detail) out(`    ${paint(90, f.detail)}\n`);
      if (f.fix) out(`    ${paint(36, '→')} ${f.fix}\n`);
    }
  }
  const all = sections.flatMap(([, f]) => f);
  const fails = all.filter(f => f.level === 'fail').length, warns = all.filter(f => f.level === 'warn').length;
  out(`\n${fails ? paint(31, `${fails} problem${fails === 1 ? '' : 's'} to fix`) : warns ? paint(33, `All essential checks passed, ${warns} warning${warns === 1 ? '' : 's'}`) : paint(32, 'Everything looks good')}. Troubleshooting: https://github.com/Git-me-Harish/Behind_Everything-/blob/main/docs/TROUBLESHOOTING.md\n`);
  return fails ? 1 : 0;
}
