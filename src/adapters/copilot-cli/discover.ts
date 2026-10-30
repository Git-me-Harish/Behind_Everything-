import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const COPILOT_SESSIONS = path.join(process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot'), 'session-state');

/**
 * Each session is a folder `<session-state>/<session id>/` holding `events.jsonl`, written by the Copilot CLI and by
 * VS Code when it hosts the same agent runtime. Folders starting with a dot are Copilot's own lock files.
 */
export function listSessionLogs(root = COPILOT_SESSIONS, modifiedAfter = 0): string[] {
  let dirs: fs.Dirent[];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return dirs
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => path.join(root, d.name, 'events.jsonl'))
    .filter(f => mtime(f) >= modifiedAfter && mtime(f) > 0)
    .sort((a, b) => mtime(a) - mtime(b));
}

export function isSessionLog(p: string, root = COPILOT_SESSIONS): boolean {
  const parts = path.relative(root, p).split(path.sep);
  return parts.length === 2 && !parts[0]!.startsWith('.') && parts[1] === 'events.jsonl';
}

function mtime(p: string): number {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}
