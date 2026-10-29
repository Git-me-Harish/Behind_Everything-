import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLAUDE_PROJECTS = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects');

/**
 * Transcripts live at `<projects>/<cwd-slug>/<session>.jsonl`; subagent transcripts
 * live under `<projects>/<cwd-slug>/<session>/subagents/*.jsonl`.
 */
export function listTranscripts(root = CLAUDE_PROJECTS, modifiedAfter = 0): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && isTranscript(p, root) && mtime(p) >= modifiedAfter) out.push(p);
    }
  };
  walk(root, 0);
  return out.sort((a, b) => mtime(a) - mtime(b));
}

/** `<slug>/<session>.jsonl` or `<slug>/<session>/subagents/<agent>.jsonl` under the projects root. */
export function isTranscript(p: string, root = CLAUDE_PROJECTS): boolean {
  const parts = path.relative(root, p).split(path.sep);
  return p.endsWith('.jsonl') && (parts.length === 2 || (parts.length === 4 && parts[2] === 'subagents'));
}

function mtime(p: string): number {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}
