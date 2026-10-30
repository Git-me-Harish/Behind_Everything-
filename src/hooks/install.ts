import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The opt-in hook bridge: one PermissionRequest hook per assistant that forwards the request to the collector, so
 * the UI can show an approval prompt while it is still waiting for you. The hook never decides and never blocks:
 * it runs in the background, gives up after a second and always exits 0, printing nothing.
 */

export type HookAssistant = 'claude-code' | 'codex';
export const HOOK_ASSISTANTS: HookAssistant[] = ['claude-code', 'codex'];

/** How our entries are recognised in a config file that also holds the user's own hooks. */
const FORWARDER_NAME = 'behind-everything-hook.mjs';

export const dataDir = () => process.env.BE_HOME ?? path.join(os.homedir(), '.behind-everything');

export function configPath(assistant: HookAssistant): string {
  return assistant === 'claude-code'
    ? path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json')
    : path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json');
}

/** Standalone, dependency-free: copied to the data dir so the hook does not depend on where this app lives. */
export const FORWARDER = `// Behind Everything hook forwarder. Sends the hook's JSON to the local collector; never blocks, never decides.
import http from 'node:http';
const [assistant, port = '47821'] = process.argv.slice(2);
const done = () => process.exit(0);
setTimeout(done, 3000).unref();
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { body += d; if (body.length > 1000000) done(); });
process.stdin.on('end', () => {
  const req = http.request({ host: '127.0.0.1', port: Number(port), method: 'POST', path: '/api/hooks/' + assistant, headers: { 'content-type': 'application/json' }, timeout: 1000 }, res => { res.resume(); res.on('end', done); });
  req.on('error', done);
  req.on('timeout', () => req.destroy());
  req.end(body);
});
`;

export interface HookOptions { port: number; forwarder?: string }

/** The command line both assistants run: \`node\` from PATH works in every shell they use; paths are quoted. */
export function hookCommand(assistant: HookAssistant, o: HookOptions): string {
  const file = (o.forwarder ?? path.join(dataDir(), FORWARDER_NAME)).replace(/\\/g, '/');
  return `node "${file}" ${assistant} ${o.port}`;
}

type Json = Record<string, any>;

const ours = (group: Json) => Array.isArray(group?.hooks) && group.hooks.some((h: Json) => typeof h?.command === 'string' && h.command.includes(FORWARDER_NAME));

function read(file: string): Json {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return {};
  let json: unknown;
  try { json = JSON.parse(text); } catch (err) {
    throw new Error(`${file} is not valid JSON (${(err as Error).message}); fix it first — nothing was changed`);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`${file} does not hold a JSON object; nothing was changed`);
  return json as Json;
}

/** Writes through a temp file, after backing up the original once per change. */
function write(file: string, json: Json): string | undefined {
  let backup: string | undefined;
  if (fs.existsSync(file)) {
    backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, backup);
  } else fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return backup;
}

/** Our PermissionRequest group removed; empty containers it leaves behind removed too. */
function without(json: Json): Json {
  const out = { ...json };
  const groups = out.hooks?.PermissionRequest;
  if (!Array.isArray(groups)) return out;
  const kept = groups.filter(g => !ours(g));
  const hooks = { ...out.hooks };
  if (kept.length) hooks.PermissionRequest = kept;
  else delete hooks.PermissionRequest;
  if (Object.keys(hooks).length) out.hooks = hooks;
  else delete out.hooks;
  return out;
}

export interface Change { assistant: HookAssistant; file: string; changed: boolean; backup?: string }

export function install(assistant: HookAssistant, o: HookOptions, file = configPath(assistant)): Change {
  const before = read(file);
  const base = without(before);
  const entry = { hooks: [{ type: 'command', command: hookCommand(assistant, o), async: true, timeout: 5 }] };
  const after = { ...base, hooks: { ...base.hooks, PermissionRequest: [...(base.hooks?.PermissionRequest ?? []), entry] } };
  if (JSON.stringify(after) === JSON.stringify(before)) return { assistant, file, changed: false };
  const forwarder = o.forwarder ?? path.join(dataDir(), FORWARDER_NAME);
  fs.mkdirSync(path.dirname(forwarder), { recursive: true });
  fs.writeFileSync(forwarder, FORWARDER);
  return { assistant, file, changed: true, backup: write(file, after) };
}

export function uninstall(assistant: HookAssistant, file = configPath(assistant)): Change {
  if (!fs.existsSync(file)) return { assistant, file, changed: false };
  const before = read(file);
  const after = without(before);
  if (JSON.stringify(after) === JSON.stringify(before)) return { assistant, file, changed: false };
  return { assistant, file, changed: true, backup: write(file, after) };
}

export interface HookStatus { installed: boolean; port?: number; file: string; error?: string }

export function status(assistant: HookAssistant, file = configPath(assistant)): HookStatus {
  try {
    const group = (read(file).hooks?.PermissionRequest ?? []).find(ours);
    if (!group) return { installed: false, file };
    const port = Number(/ (\d+)$/.exec(group.hooks.find((h: Json) => String(h.command).includes(FORWARDER_NAME)).command)?.[1]);
    return { installed: true, file, port: Number.isFinite(port) ? port : undefined };
  } catch (err) {
    return { installed: false, file, error: (err as Error).message };
  }
}

/** Codex can switch hooks off (`[features] hooks = false`); a new hook also needs your trust before it runs. */
export function codexNotes(home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')): string[] {
  const notes: string[] = [];
  let toml = '';
  try { toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8'); } catch { /* no config: defaults apply */ }
  const features = /^\[features\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(toml)?.[1] ?? '';
  if (/^\s*(hooks|codex_hooks)\s*=\s*false\b/m.test(features)) notes.push('Hooks are switched off in Codex: remove `hooks = false` from [features] in config.toml.');
  notes.push('Codex runs a new hook only after you trust it: start Codex in a terminal, type /hooks and trust the Behind Everything hook.');
  return notes;
}
