import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ZONES } from '../../src/core/state.js';
import { CAPACITY } from '../../web/src/world/model.js';
import * as content from '../../site/src/content.js';
import { BEATS, storyAt } from '../../site/src/story.js';

describe('product site: hero story', () => {
  it('gives every beat a complete world the renderer can draw', () => {
    for (let b = 0; b < BEATS; b++) {
      const m = storyAt(b);
      expect(Object.keys(m.rooms).sort()).toEqual([...ZONES].sort());
      for (const z of ZONES) expect(m.rooms[z].cells, `${z} on beat ${b}`).toHaveLength(CAPACITY[z]);
      // Agents sharing a room stand at different stations.
      const seats = m.agents.map(a => `${a.zone}:${a.slot}`);
      expect(new Set(seats).size, `beat ${b}`).toBe(seats.length);
    }
  });

  it('casts all three assistants as their mascots, and loops', () => {
    expect(storyAt(0).agents.map(a => a.avatar)).toEqual(['clawd', 'blob', 'copilot']);
    expect(storyAt(BEATS)).toEqual(storyAt(0));
    expect(storyAt(-1)).toEqual(storyAt(BEATS - 1));
  });

  it('closes the Approval Gate exactly while someone waits for you', () => {
    for (let b = 0; b < BEATS; b++) {
      const m = storyAt(b);
      expect(!!m.rooms.approval.gateClosed, `beat ${b}`).toBe(m.agents.some(a => a.waiting));
    }
  });
});

describe('product site: copy', () => {
  const files = ['site/index.html', ...fs.readdirSync('site/src').map(f => path.join('site/src', f))];

  it('never uses an em dash', () => {
    for (const f of files) expect(fs.readFileSync(f, 'utf8').includes('—'), f).toBe(false);
  });

  it('tells people to run the command the package actually installs', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    expect(Object.keys(pkg.bin)).toEqual(['behind-everything']);
    expect(content.INSTALL).toBe(`npx ${pkg.name}`);
    expect(content.HOOKS).toBe(`npx ${pkg.name} hooks install`);
    // The Node version the page promises is the one the package requires.
    expect(pkg.engines.node).toBe('>=22');
    expect(content.HERO.note).toContain('Node.js 22 or newer');
  });

  it('only shows screenshots that exist, in both themes', () => {
    for (const f of content.FEATURES) for (const t of ['light', 'dark']) expect(fs.existsSync(`site/public/shots/${f.shot}-${t}.jpg`), `${f.shot}-${t}`).toBe(true);
    for (const t of ['light', 'dark']) expect(fs.existsSync(`site/public/shots/hero-${t}.jpg`)).toBe(true);
    expect(fs.existsSync('site/public/og.png')).toBe(true);
  });

  it('links every nav item to a section on the page', () => {
    const app = fs.readFileSync('site/src/App.tsx', 'utf8');
    for (const n of content.NAV) expect(app, n.href).toContain(`id="${n.href.slice(1)}"`);
  });
});
