/**
 * Drift check against the developer's real Claude Code transcripts and Codex rollouts. Never runs in CI and
 * never writes their content anywhere: run with `pnpm test:local`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClaudeParser } from '../src/adapters/claude-code/parse.js';
import { CanonicalEvent } from '../src/core/schema.js';
import { listTranscripts } from '../src/adapters/claude-code/discover.js';
import { CODEX_SESSIONS, listRollouts } from '../src/adapters/codex/discover.js';
import { createCodexParser } from '../src/adapters/codex/parse.js';
import { reduce } from '../src/core/state.js';

const root = path.join(os.homedir(), '.claude', 'projects');

const enabled = Boolean(process.env.BE_LOCAL_TRANSCRIPTS) && fs.existsSync(root);
(enabled ? describe : describe.skip)('local Claude Code transcripts', () => {
  it('parse into valid canonical events with no unknown record types', () => {
    const kinds: Record<string, number> = {};
    const unknown: Record<string, number> = {};
    let orphanResults = 0;
    for (const file of listTranscripts(root)) {
      const parser = createClaudeParser(file);
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (!line) return;
        for (const e of parser.parse(line, i + 1)) {
          CanonicalEvent.parse(e);
          kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
          if (e.kind === 'system.unknown') unknown[String(e.payload?.type)] = (unknown[String(e.payload?.type)] ?? 0) + 1;
          if (e.actor === 'tool' && !e.tool) orphanResults++;
        }
      });
    }
    console.log({ kinds, unknown, orphanResults });
    expect(unknown).toEqual({});
  }, 120_000);
});

const codex = Boolean(process.env.BE_LOCAL_TRANSCRIPTS) && fs.existsSync(CODEX_SESSIONS);
(codex ? describe : describe.skip)('local Codex rollouts', () => {
  it('parse into valid, unique events; every call that starts also ends', () => {
    const unknown: Record<string, number> = {};
    let events = 0, duplicates = 0, stillRunning = 0, unpaired = 0;
    for (const file of listRollouts(CODEX_SESSIONS)) {
      const parser = createCodexParser(file);
      const ids = new Set<string>();
      const es = fs.readFileSync(file, 'utf8').split('\n').flatMap((line, i) => (line ? parser.parse(line, i + 1) : []));
      const open = new Set<string>();
      for (const e of es) {
        CanonicalEvent.parse(e);
        events++;
        if (ids.has(e.id)) duplicates++;
        ids.add(e.id);
        if (e.kind === 'system.unknown') unknown[String(e.payload?.type)] = (unknown[String(e.payload?.type)] ?? 0) + 1;
        const call = e.correlation?.call_id;
        if (call && e.kind !== 'permission.decision') e.status === 'started' ? open.add(call) : open.delete(call);
      }
      unpaired += open.size;
      stillRunning += Object.keys(reduce(parser.session?.id ?? file, es).commands.running).length;
    }
    console.log({ events, duplicates, unpaired, stillRunning, unknown });
    expect({ duplicates, unpaired, stillRunning, unknown }).toEqual({ duplicates: 0, unpaired: 0, stillRunning: 0, unknown: {} });
  }, 120_000);
});
