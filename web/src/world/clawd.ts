/**
 * Claude's pixel mascot, one character per source pixel. Shared by the 3D voxel figure and the flat icon, so
 * both are the same drawing. Kept free of three.js: the icon is part of the main bundle.
 *
 *   # body   e eye   a arm   f / b front and back legs, which step alternately
 */
export const CLAWD = [
  '..#############..',
  '..##e#######e##..',
  'aa#############aa',
  '..#############..',
  '....f.b...f.b....',
] as const;

/** The original is drawn with terminal half-blocks: each pixel is 4 wide by 9 tall. */
export const PIXEL = { w: 4, h: 9 } as const;
export const CLAWD_COLS = CLAWD[0].length;
export const CLAWD_ROWS = CLAWD.length;

export type ClawdPart = 'body' | 'eye' | 'armL' | 'armR' | 'legFront' | 'legBack';

/** A horizontal run of pixels belonging to one part; rows count from the top. */
export interface Run { part: ClawdPart; row: number; col: number; len: number }

/** Horizontal runs per part. The body is solid behind the eyes; eyes are separate runs drawn in front. */
export function clawdRuns(grid: readonly string[] = CLAWD): Run[] {
  const mid = grid[0]!.length / 2;
  const partAt = (ch: string, col: number): ClawdPart | undefined =>
    ch === '#' || ch === 'e' ? 'body' : ch === 'a' ? (col < mid ? 'armL' : 'armR') : ch === 'f' ? 'legFront' : ch === 'b' ? 'legBack' : undefined;
  const runs: Run[] = [];
  grid.forEach((line, row) => {
    for (let col = 0; col < line.length;) {
      const part = partAt(line[col]!, col);
      let end = col + 1;
      while (end < line.length && partAt(line[end]!, end) === part) end++;
      if (part) runs.push({ part, row, col, len: end - col });
      col = end;
    }
    for (let col = 0; col < line.length; col++) if (line[col] === 'e') runs.push({ part: 'eye', row, col, len: 1 });
  });
  return runs;
}
