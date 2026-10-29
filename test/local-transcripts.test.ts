/**
 * Drift check against the developer's real Claude Code transcripts. Never runs in CI and
 * never writes their content anywhere: run with `pnpm test:local`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClaudeParser } from '../src/adapters/claude-code/parse.js';
import { CanonicalEvent } from '../src/core/schema.js';
import { listTranscripts } from '../src/adapters/claude-code/discover.js';

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
