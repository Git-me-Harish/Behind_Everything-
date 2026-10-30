import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createClaudeParser } from '../src/adapters/claude-code/parse.js';
import { listTranscripts } from '../src/adapters/claude-code/discover.js';
import { startCollector } from '../src/collector/index.js';
import { JsonlTailer } from '../src/collector/tailer.js';
import type { CanonicalEvent } from '../src/core/schema.js';
import { demoSession, SESSION } from './fixtures/claude.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'be-test-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 25));
  }
};

function get(port: number, p: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers, agent: false }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data || 'null') }));
    }).on('error', reject);
  });
}

describe('JsonlTailer', () => {
  function tailer(file: string) {
    const got: CanonicalEvent[] = [];
    const t = new JsonlTailer({
      root: dir, since: 0, list: () => [file], accept: () => true,
      createParser: createClaudeParser, onEvents: ev => got.push(...ev),
    });
    return { t, got };
  }

  it('only emits complete lines, across arbitrary write boundaries', () => {
    const file = path.join(dir, 's.jsonl');
    const text = demoSession().main.jsonl();
    const { t, got } = tailer(file);
    fs.writeFileSync(file, '');
    // Write in awkward chunks, including splits inside multi-byte characters.
    const bytes = Buffer.from(text.replace('Fix the failing', 'Fix the fäiling ✓'));
    for (let i = 0; i < bytes.length; i += 97) {
      fs.appendFileSync(file, bytes.subarray(i, i + 97));
      t.read(file);
    }
    const expected = text.split('\n').filter(Boolean).length;
    expect(got.length).toBeGreaterThan(expected);
    expect(got.find(e => e.kind === 'user.prompt')?.summary).toBe('Fix the fäiling ✓ date parser');
    expect(new Set(got.map(e => e.id)).size).toBe(got.length);
  });

  it('restarts from the top when a file is truncated', () => {
    const file = path.join(dir, 's.jsonl');
    const { t, got } = tailer(file);
    fs.writeFileSync(file, demoSession().main.jsonl());
    t.read(file);
    const first = got.length;
    fs.writeFileSync(file, demoSession().main.jsonl().split('\n').slice(0, 3).join('\n') + '\n');
    t.read(file);
    expect(got.length).toBeGreaterThan(first);
  });
});

describe('collector end-to-end', () => {
  it('streams new events live, dedupes on restart, and guards the API', async () => {
    const root = path.join(dir, 'projects');
    const file = path.join(root, 'C--work-demo', `${SESSION}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lines = demoSession().main.jsonl().split('\n').filter(Boolean);
    fs.writeFileSync(file, lines.slice(0, 4).join('\n') + '\n');
    expect(listTranscripts(root)).toEqual([file]);

    const port = 47900 + Math.floor(Math.random() * 90);
    const dbPath = path.join(dir, 'db.sqlite');
    let c = await startCollector({ port, claudeRoot: root, codexRoot: path.join(root, 'no-codex'), dbPath });
    try {
      const sessions = (await get(port, '/api/sessions')).body;
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ id: `claude-code:${SESSION}`, cwd: 'C:\\work\\demo' });

      const live: any[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.on('message', m => { const msg = JSON.parse(String(m)); if (msg.type === 'events') live.push(...msg.events); });
      await new Promise(r => ws.once('open', r));

      fs.appendFileSync(file, lines.slice(4).join('\n') + '\n');
      await until(() => live.some(e => e.kind === 'turn.end'));
      expect(live.every((e, i) => i === 0 || e.seq > live[i - 1].seq)).toBe(true);
      await new Promise(r => { ws.once('close', r); ws.close(); });

      const all = (await get(port, `/api/sessions/${encodeURIComponent(`claude-code:${SESSION}`)}/events`)).body;
      expect(all.length).toBeGreaterThan(30);

      // Evidence is the raw provider record, redacted.
      const envCall = all.find((e: any) => e.correlation?.call_id === 't-env' && e.status === 'started');
      const ev = await get(port, `/api/events/${encodeURIComponent(envCall.id)}/evidence`);
      expect(ev.status).toBe(200);
      expect(JSON.stringify(ev.body.record)).not.toContain('sk-ant-abc');
      expect(JSON.stringify(ev.body.record)).toContain('[REDACTED:');

      // Foreign hosts and origins are refused.
      expect((await get(port, '/api/sessions', { host: 'evil.example:80' })).status).toBe(403);
      expect((await get(port, '/api/sessions', { origin: 'https://evil.example' })).status).toBe(403);
      const bad = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: 'https://evil.example' } });
      await expect(new Promise((res, rej) => { bad.once('open', res); bad.once('error', rej); })).rejects.toBeTruthy();

      // Restart: same file re-read from the top, nothing duplicated.
      await c.close();
      c = await startCollector({ port, claudeRoot: root, codexRoot: path.join(root, 'no-codex'), dbPath });
      const again = (await get(port, `/api/sessions/${encodeURIComponent(`claude-code:${SESSION}`)}/events`)).body;
      expect(again.length).toBe(all.length);
      expect((await get(port, '/api/sessions')).body[0].event_count).toBe(all.length);
    } finally {
      await c.close();
    }
  }, 20_000);
});

describe('collector detail endpoint', () => {
  it('lists light events and serves full ones by id', async () => {
    const root = path.join(dir, 'projects');
    const file = path.join(root, 'C--work-demo', `${SESSION}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, demoSession().main.jsonl());
    const port = 48000 + Math.floor(Math.random() * 90);
    const c = await startCollector({ port, claudeRoot: root, codexRoot: path.join(root, 'no-codex'), dbPath: path.join(dir, 'db.sqlite') });
    try {
      const list = (await get(port, `/api/sessions/${encodeURIComponent(`claude-code:${SESSION}`)}/events`)).body;
      const edit = list.find((e: any) => e.correlation?.call_id === 't-edit1' && e.status === 'succeeded');
      expect(edit.payload.patch).toBeUndefined();
      const full = await get(port, `/api/events/${encodeURIComponent(edit.id)}`);
      expect(full.body.payload.patch).toEqual(['@@ -1,1 +1,2 @@', '-a', '+b', '+c']);
      expect((await get(port, '/api/events/nope')).status).toBe(404);
    } finally {
      await c.close();
    }
  });
});
