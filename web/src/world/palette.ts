import { Color } from 'three';
import { ZONES, type ZoneId, type ZoneStatus } from '../../../src/core/state.ts';
import type { Tone } from './model.ts';

/** World colours, read from the same CSS tokens as the rest of the UI so both themes stay in step. */
export interface Palette {
  dark: boolean;
  slab: Color; slabSide: Color; corridor: Color; rim: Color;
  wall: Color; furniture: Color; furniture2: Color; wood: Color; metal: Color; screen: Color;
  skin: Color; legs: Color; leaf: Color; trunk: Color;
  floor: Record<ZoneId, Color>;
  badge: Record<ZoneId, Color>;
  status: Record<ZoneStatus, Color>;
  tone: (tone: Tone, zone: ZoneId) => Color;
  sky: Color; ground: Color; sun: number; ambient: number;
}

export function readPalette(root: HTMLElement = document.documentElement): Palette {
  const cs = getComputedStyle(root);
  const css = (name: string, fallback: string) => new Color(cs.getPropertyValue(name).trim() || fallback);
  const dark = root.dataset.theme === 'dark';
  const pick = (light: string, night: string) => new Color(dark ? night : light);
  const badge = Object.fromEntries(ZONES.map(z => [z, css(`--z-${z}-b`, '#1f7f8c')])) as Record<ZoneId, Color>;
  // Floors: the tile tint pulled a little towards the zone's colour, like the reference map's pastel rooms.
  const floor = Object.fromEntries(ZONES.map(z => [z, css(`--z-${z}`, '#eef3f9').lerp(badge[z], dark ? 0.24 : 0.3)])) as Record<ZoneId, Color>;
  const status: Record<ZoneStatus, Color> = {
    idle: css('--idle', '#a3adbf'), active: css('--active', '#1a8fb5'), ok: css('--ok', '#1f9d74'), warn: css('--warn', '#d99a1e'), error: css('--error', '#d8454f'),
  };
  const paper = pick('#fff3b8', '#d9c76a');
  const dim = pick('#d9dfe8', '#2b3446');
  return {
    dark,
    slab: pick('#f7f9fc', '#1b2331'), slabSide: pick('#dfe6ef', '#121821'), corridor: pick('#eef2f7', '#18202c'), rim: css('--accent', '#1f7f8c'),
    wall: pick('#ffffff', '#273246'), furniture: pick('#f3f6fa', '#2f3a4e'), furniture2: pick('#dde4ed', '#3a465c'),
    wood: pick('#e6cfae', '#6b5843'), metal: pick('#a7b2c2', '#55627a'), screen: pick('#2b3445', '#0b0f16'),
    skin: pick('#f6dfcf', '#e9cdb8'), legs: pick('#3d4657', '#1c2230'), leaf: pick('#7cc49a', '#3f8f63'), trunk: pick('#9b7653', '#5d4632'),
    floor, badge, status,
    tone: (tone, zone) => (tone === 'zone' ? badge[zone] : tone === 'paper' ? paper : tone === 'dim' ? dim : status[tone === 'active' ? 'active' : tone]),
    sky: pick('#ffffff', '#9fb4d6'), ground: pick('#c9d6e6', '#1a2233'), sun: dark ? 1.1 : 1.9, ambient: dark ? 1.6 : 2.3,
  };
}
