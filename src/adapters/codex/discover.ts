import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CODEX_SESSIONS = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'sessions');

/** Rollouts live at `<sessions>/YYYY/MM/DD/rollout-<time>-<thread>.jsonl` (CLI and the VS Code extension alike). */
export function listRollouts(root = CODEX_SESSIONS, modifiedAfter = 0): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && isRollout(p, root) && mtime(p) >= modifiedAfter) out.push(p);
    }
  };
  walk(root, 0);
  return out.sort((a, b) => mtime(a) - mtime(b));
}

export function isRollout(p: string, root = CODEX_SESSIONS): boolean {
  const parts = path.relative(root, p).split(path.sep);
  return parts.length === 4 && parts[3]!.startsWith('rollout-') && p.endsWith('.jsonl');
}

function mtime(p: string): number {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}
