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
import { createCopilotParser } from '../src/adapters/copilot-cli/parse.js';
import { demoSession, SESSION, TranscriptBuilder } from './fixtures/claude.js';
import { CopilotLogBuilder } from './fixtures/copilot.js';

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

  it('asks the parser what is still waiting once it has caught up (Copilot approvals)', () => {
    const file = path.join(dir, 'events.jsonl');
    const got: CanonicalEvent[] = [];
    const t = new JsonlTailer({ root: dir, since: 0, list: () => [file], accept: () => true, createParser: createCopilotParser, onEvents: ev => got.push(...ev) });
    const b = new CopilotLogBuilder().prompt('Clean up').modelCall()
      .start('c-rm', 'powershell', { command: 'Remove-Item build', mode: 'sync' })
      .ask('r-rm', { kind: 'shell', fullCommandText: 'Remove-Item build', toolCallId: 'c-rm' });
    fs.writeFileSync(file, b.jsonl());
    t.read(file);
    expect(got.filter(e => e.kind === 'permission.decision').map(e => e.status)).toEqual(['pending']);
    fs.appendFileSync(file, JSON.stringify({ type: 'permission.completed', id: 'done', timestamp: '2026-10-29T10:00:00Z', data: { requestId: 'r-rm', result: { kind: 'approved' }, decisionSource: 'human_response' } }) + '\n');
    t.read(file);
    expect(got.filter(e => e.kind === 'permission.decision').map(e => e.status)).toEqual(['pending', 'succeeded']);
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
    let c = await startCollector({ port, claudeRoot: root, codexRoot: path.join(root, 'no-codex'), copilotRoot: path.join(root, 'no-copilot'), dbPath });
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
      c = await startCollector({ port, claudeRoot: root, codexRoot: path.join(root, 'no-codex'), copilotRoot: path.join(root, 'no-copilot'), dbPath });
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
    const c = await startCollector({ port, claudeRoot: root, codexRoot: path.join(root, 'no-codex'), copilotRoot: path.join(root, 'no-copilot'), dbPath: path.join(dir, 'db.sqlite') });
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

function post(port: number, p: string, body: string, headers: Record<string, string> = { 'content-type': 'application/json' }): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers, agent: false }, res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', reject);
    req.end(body);
  });
}

describe('collector hook bridge', () => {
  it('shows a hooked approval prompt as waiting, on the call and in the session list, until the call runs', async () => {
    const root = path.join(dir, 'projects');
    const file = path.join(root, 'C--work-demo', `${SESSION}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const log = new TranscriptBuilder().userPrompt('Clean up').toolUse('t-rm', 'Bash', { command: 'rm -rf build', description: 'Remove the build folder' });
    fs.writeFileSync(file, log.jsonl());
    const hookConfig = { 'claude-code': path.join(dir, 'claude-settings.json'), codex: path.join(dir, 'codex-hooks.json') };
    const port = 48100 + Math.floor(Math.random() * 90);
    const c = await startCollector({ port, claudeRoot: root, codexRoot: path.join(root, 'no-codex'), copilotRoot: path.join(root, 'no-copilot'), dbPath: path.join(dir, 'db.sqlite'), hookConfig });
    try {
      await until(() => c.store.sessions().length === 1);
      const body = JSON.stringify({ session_id: SESSION, cwd: 'C:\work\demo', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: 'Remove the build folder' } });
      expect(await post(port, '/api/hooks/claude-code', body)).toBe(204);
      const session = async () => (await get(port, '/api/sessions')).body[0];
      expect((await session()).waiting).toEqual([expect.objectContaining({ kind: 'approval', call_id: 't-rm', summary: 'Waiting for approval: Remove the build folder' })]);
      const events = (await get(port, `/api/sessions/${encodeURIComponent(`claude-code:${SESSION}`)}/events`)).body;
      expect(events.at(-1)).toMatchObject({ kind: 'permission.decision', status: 'pending', adapter: { capture: 'hook' } });

      const health = (await get(port, '/api/health')).body;
      expect(health.sources.find((s: any) => s.assistant === 'claude-code').hooks).toMatchObject({ installed: false, events: 1, matched: 1 });
      expect(health.sources.find((s: any) => s.assistant === 'copilot-cli').hooks).toBeUndefined();

      fs.appendFileSync(file, log.toolResult('t-rm', 'removed').jsonl().split('\n').filter(Boolean).at(-1) + '\n');
      await until(() => c.store.sessions()[0]!.event_count > events.length);
      expect((await session()).waiting).toEqual([]);

      // Only JSON objects from this machine, for assistants that have a bridge.
      expect(await post(port, '/api/hooks/claude-code', body, { 'content-type': 'application/json', origin: 'https://evil.example' })).toBe(403);
      expect(await post(port, '/api/hooks/claude-code', body, { 'content-type': 'text/plain' })).toBe(415);
      expect(await post(port, '/api/hooks/claude-code', '[1]')).toBe(400);
      expect(await post(port, '/api/hooks/copilot-cli', body)).toBe(404);
      expect(await post(port, '/api/hooks/claude-code', JSON.stringify({ pad: 'x'.repeat(300_000) }))).toBe(413);
    } finally {
      await c.close();
    }
  }, 20_000);
});
