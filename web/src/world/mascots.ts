/**
 * The Codex and Copilot mascots, one character per pixel, like Claude's in clawd.ts. The same drawing makes the
 * voxel figure in the map (rounded into a plush toy: the body is deeper the further it is from the outline) and the
 * flat icon. Kept free of three.js: the icons are part of the main bundle.
 *
 *   # body   K dark, standing on its own (beret, bow tie)   k dark, on the face (glasses, visor)
 *   w white, on the face   e eye or pupil, on the face (blinks)
 */

export type MascotId = 'blob' | 'heart' | 'frog' | 'triangle' | 'copilot';

export interface Mascot {
  grid: readonly string[];
  /** Body colour; undefined wears the agent's colour. */
  color?: string;
  /** Eye colour; dark unless set. */
  eye?: string;
  /** How it moves: plush toys hop, Copilot's head hovers. */
  motion: 'hop' | 'hover';
}

export const INK = { dark: '#16141c', white: '#f6f7fb' } as const;

/** Codex's plush cast: a blue cloud in a beret leads; subagents are the heart, the frog and the triangle. */
export const MASCOTS: Record<MascotId, Mascot> = {
  blob: {
    color: '#2f8ee6', motion: 'hop',
    grid: [
      '......KKK.....',
      '...KKKKKKKKK..',
      '..KKKKKKKKKKKK',
      '..###.##.###..',
      '.############.',
      '##############',
      '.############.',
      '####e####e####',
      '##############',
      '.############.',
      '..###.##.###..',
    ],
  },
  heart: {
    color: '#ec4fc0', motion: 'hop',
    grid: [
      '..###....###..',
      '.#####..#####.',
      '##############',
      '##kkk####kkk##',
      '##kkkkkkkkkk##',
      '##kkk####kkk##',
      '.############.',
      '..##########..',
      '...########...',
      '....######....',
      '.....####.....',
      '......##......',
    ],
  },
  frog: {
    color: '#9ad432', motion: 'hop',
    grid: [
      '.####....####.',
      '#wwww#..#wwww#',
      '#wwew####weww#',
      '#wwww####wwww#',
      '##############',
      '##############',
      '##############',
      '##############',
      '.############.',
      '..##KKK#KKK#..',
      '....KKK.KKK...',
    ],
  },
  triangle: {
    color: '#f4c51c', motion: 'hop',
    grid: [
      '......##......',
      '.....####.....',
      '....######....',
      '..kkkk##kkkk..',
      '..k##kkkk##k..',
      '..keek##keek..',
      '..kkkk##kkkk..',
      '..##########..',
      '.############.',
      '####KK##KK####',
      '....KKKKKK....',
    ],
  },
  copilot: {
    motion: 'hover', eye: '#f6f7fb',
    grid: [
      '.....######.....',
      '...##########...',
      '..############..',
      '.#wwwww##wwwww#.',
      '##wkkkw##wkkkw##',
      '##wkkkw##wkkkw##',
      '##wwwwwkkwwwww##',
      '##kkkkkkkkkkkk##',
      '##kkkekkkkekkk##',
      '.#kkkekkkkekkk#.',
      '..#kkkkkkkkkk#..',
      '...##########...',
    ],
  },
};

export type MascotPart = 'body' | 'standalone' | 'dark' | 'white' | 'eye';

const PART: Record<string, MascotPart> = { '#': 'body', K: 'standalone', k: 'dark', w: 'white', e: 'eye' };

export interface Cell { part: MascotPart; row: number; col: number }

export function cells(grid: readonly string[]): Cell[] {
  const out: Cell[] = [];
  grid.forEach((line, row) => [...line].forEach((ch, col) => { if (PART[ch]) out.push({ part: PART[ch]!, row, col }); }));
  return out;
}

/** The colour a part is drawn in. */
export function partColor(part: MascotPart, body: string, eye: string = INK.dark): string {
  return part === 'body' ? body : part === 'white' ? INK.white : part === 'eye' ? eye : INK.dark;
}

const CODEX_CAST: MascotId[] = ['heart', 'frog', 'triangle'];

/** Which mascot an agent is, by assistant; Codex subagents take turns through the cast by order of appearance. */
export function mascotFor(assistant: string, main: boolean, subIndex: number): MascotId | 'clawd' | undefined {
  if (assistant === 'claude-code') return 'clawd';
  if (assistant === 'codex') return main ? 'blob' : CODEX_CAST[subIndex % CODEX_CAST.length]!;
  if (assistant === 'copilot-cli') return 'copilot';
  return undefined;
}
