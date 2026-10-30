/** Text helpers shared by the log adapters. */

export const MAX_PATCH_LINES = 400;

export const clipLine = (l: string) => (l.length > 400 ? `${l.slice(0, 400)}…` : l);

export const lineCount = (s: string) => (s ? s.split('\n').length : 0);

/** One line of at most `max` characters. */
export function oneLine(s: string, max = 200): string {
  const first = s.replace(/\s+/g, ' ').trim();
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/** A new file as unified-diff lines for the diff view, capped in size. */
export function patchFromContent(content: string): string[] {
  const lines = content.split('\n');
  const out = [`@@ -0,0 +1,${lines.length} @@`, ...lines.slice(0, MAX_PATCH_LINES - 1).map(l => `+${clipLine(l)}`)];
  if (lines.length >= MAX_PATCH_LINES) out.push(`… ${lines.length - MAX_PATCH_LINES + 1} more lines`);
  return out;
}

/** A path relative to the session's working directory when it is inside it, with forward slashes. */
export function relativeTo(cwd: string | undefined, p: string): string {
  const norm = p.replace(/\\/g, '/');
  if (cwd) {
    const c = cwd.replace(/\\/g, '/').replace(/\/$/, '');
    if (norm.toLowerCase().startsWith(c.toLowerCase() + '/')) return norm.slice(c.length + 1);
  }
  return norm;
}

/** Files in an apply_patch envelope (`*** Update File: x`), with line counts and diff lines. */
export function parsePatch(patch: string): Array<{ path: string; op: string; added: number; removed: number; patch: string[] }> {
  const files: Array<{ path: string; op: string; added: number; removed: number; patch: string[] }> = [];
  let cur: (typeof files)[number] | undefined;
  for (const line of patch.split('\n')) {
    const head = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (head) {
      cur = { path: head[2]!.trim(), op: head[1]!.toLowerCase(), added: 0, removed: 0, patch: [] };
      files.push(cur);
      continue;
    }
    if (!cur || line.startsWith('*** ')) continue;
    if (line.startsWith('+')) cur.added++;
    else if (line.startsWith('-')) cur.removed++;
    if (cur.patch.length < MAX_PATCH_LINES && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line.startsWith('@@'))) cur.patch.push(clipLine(line));
  }
  return files;
}
