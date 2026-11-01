import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClaudeParser } from '../src/adapters/claude-code/parse.js';
import { startCollector } from '../src/collector/index.js';
import { checkHooks, checkLogs, checkNode, checkPort } from '../src/doctor.js';
import { install } from '../src/hooks/install.js';
import { CanonicalEvent, type SessionInfo } from '../src/core/schema.js';
import { exportSession, importBundle, SHARE_ALL, SHARE_FORMAT } from '../src/core/share.js';
import { demoSession, SESSION } from './fixtures/claude.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'be-share-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const HOME = 'C:\\Users\\alex';
function demo() {
  const p = createClaudeParser(`${HOME}\\.claude\\projects\\C--work-demo\\${SESSION}.jsonl`);
  const events = demoSession().main.jsonl().split('\n').flatMap((l, i) => (l ? p.parse(l, i + 1) : []));
  return { session: p.session!, events };
}

describe('sharing a session', () => {
  it('keeps the story but nothing that points into your machine', () => {
    const { session, events } = demo();
    // An older store may hold a home path or a secret the capture-time rules missed.
    events.push({ ...events.at(-1)!, id: 'late', summary: `Read ${HOME}\\notes\\key.txt`, payload: { output: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789' } });
    const b = exportSession({ ...session, cwd: 'C:\\work\\demo' }, events, SHARE_ALL, { home: HOME, appVersion: '1.0.0', now: new Date('2026-11-01T00:00:00Z') });
    const json = JSON.stringify(b);
    expect(b.format).toBe(SHARE_FORMAT);
    expect(b.session).toMatchObject({ cwd: 'demo', title: 'Fix date parser' });
    expect('source_path' in b.session).toBe(false);
    // Event ids carry the transcript's file name, which is only the session id: harmless.
    expect(json).not.toMatch(/C:\\\\work\\\\demo|alex|"evidence"|"source_path"/i);
    expect(json).toContain('~\\\\notes\\\\key.txt');
    expect(json).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    expect(b.stats).toMatchObject({ events: events.length, redacted: 1 });
    expect(b.stats.paths_shortened).toBeGreaterThan(0);
    expect(b.stats.redacted_at_capture).toBeGreaterThan(0);
    for (const e of b.events) CanonicalEvent.parse(e);
  });

  it('leaves out prompts, command output and diffs when asked', () => {
    const { session, events } = demo();
    const b = exportSession(session, events, { prompts: false, outputs: false, diffs: false }, { home: HOME, appVersion: '1.0.0' });
    expect(b.events.find(e => e.kind === 'user.prompt')).toMatchObject({ summary: 'Prompt (not shared)' });
    expect(b.events.some(e => e.payload && ('text' in e.payload || 'output' in e.payload || 'patch' in e.payload))).toBe(false);
    expect(b.stats.left_out.prompts).toBeGreaterThan(0);
    expect(b.stats.left_out.outputs).toBeGreaterThan(0);
    expect(b.stats.left_out.diffs).toBeGreaterThan(0);
  });

  it('opens a shared file as a read-only session keyed apart from live ones, the same every time', () => {
    const { session, events } = demo();
    const file = JSON.parse(JSON.stringify(exportSession(session, events, SHARE_ALL, { home: HOME, appVersion: '1.0.0' })));
    const a = importBundle(file), b = importBundle(file);
    expect(a.session).toMatchObject({ id: `shared:claude-code:${SESSION}`, assistant: 'claude-code', source_path: 'shared', title: 'Fix date parser' });
    expect(a.events.every(e => e.id.startsWith('shared:') && e.session_id === a.session.id)).toBe(true);
    expect(b.events.map(e => e.id)).toEqual(a.events.map(e => e.id));
    // Sharing a shared session does not stack prefixes.
    expect(importBundle({ ...file, session: { ...file.session, id: a.session.id } }).session.id).toBe(a.session.id);
  });

  it('explains what is wrong with a file it cannot open', () => {
    expect(() => importBundle({ format: 'something-else' })).toThrow('not a Behind Everything session file');
    expect(() => importBundle({ format: SHARE_FORMAT, version: 1, session: {}, events: [] })).toThrow('damaged');
    const { session, events } = demo();
    const file = JSON.parse(JSON.stringify(exportSession(session as SessionInfo, events, SHARE_ALL, { home: HOME, appVersion: '1' })));
    expect(() => importBundle({ ...file, version: 99 })).toThrow('newer version');
    expect(() => importBundle({ ...file, events: [{ nope: true }] })).toThrow('Event 1');
  });

  it('exports, imports and removes shared sessions over the API, and never removes a live one', async () => {
    const root = path.join(dir, 'projects', 'C--work-demo');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, `${SESSION}.jsonl`), demoSession().main.jsonl());
    const port = 48200 + Math.floor(Math.random() * 90);
    const c = await startCollector({ port, claudeRoot: path.join(dir, 'projects'), codexRoot: path.join(dir, 'x'), copilotRoot: path.join(dir, 'y'), dbPath: path.join(dir, 'db.sqlite'), hookConfig: { 'claude-code': path.join(dir, 'a.json'), codex: path.join(dir, 'b.json') } });
    const req = (method: string, p: string, body?: string) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: body ? { 'content-type': 'application/json' } : {} }, res => {
        let d = '';
        res.on('data', x => (d += x));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: d ? JSON.parse(d) : null }));
      });
      r.on('error', reject);
      r.end(body);
    });
    try {
      const live = `claude-code:${SESSION}`;
      for (let i = 0; i < 50 && !c.store.session(live); i++) await new Promise(r => setTimeout(r, 50));
      const exp = await req('GET', `/api/sessions/${encodeURIComponent(live)}/export?outputs=0`);
      expect(exp.status).toBe(200);
      expect(exp.body.options).toEqual({ prompts: true, outputs: false, diffs: true });
      const imp = await req('POST', '/api/import', JSON.stringify(exp.body));
      expect(imp).toEqual({ status: 201, body: { id: `shared:${live}` } });
      expect(c.store.session(`shared:${live}`)?.event_count).toBe(exp.body.events.length);
      expect((await req('POST', '/api/import', '{"format":"x"}')).status).toBe(400);
      expect((await req('DELETE', `/api/sessions/${encodeURIComponent(live)}`)).status).toBe(404);
      expect(c.store.session(live)).toBeDefined();
      expect((await req('DELETE', `/api/sessions/${encodeURIComponent(`shared:${live}`)}`)).status).toBe(200);
      expect(c.store.session(`shared:${live}`)).toBeUndefined();
    } finally {
      await c.close();
    }
  });
});

describe('doctor', () => {
  it('flags Node versions older than 22', () => {
    expect(checkNode('24.1.0').level).toBe('ok');
    expect(checkNode('20.20.2')).toMatchObject({ level: 'warn', fix: expect.stringContaining('Node.js 22') });
  });

  it('reports where each assistant\'s logs are and how recent they are', () => {
    const claude = path.join(dir, 'claude');
    fs.mkdirSync(path.join(claude, 'p'), { recursive: true });
    fs.writeFileSync(path.join(claude, 'p', `${SESSION}.jsonl`), '{}\n');
    const found = checkLogs({ 'Claude Code': claude, Codex: path.join(dir, 'none'), 'Copilot CLI': path.join(dir, 'none2') });
    expect(found.map(f => [f.level, f.title])).toEqual([
      ['ok', 'Claude Code: 1 session in the last 7 days'], ['info', 'Codex: no logs found'], ['info', 'Copilot CLI: no logs found'],
    ]);
    expect(checkLogs({ 'Claude Code': path.join(dir, 'a'), Codex: path.join(dir, 'b'), 'Copilot CLI': path.join(dir, 'c') }).at(-1)).toMatchObject({ level: 'warn', title: 'No recent sessions from any assistant' });
  });

  it('checks the hooks point at the right port', () => {
    const a = path.join(dir, 'settings.json'), b = path.join(dir, 'hooks.json');
    install('claude-code', { port: 47821, forwarder: path.join(dir, 'behind-everything-hook.mjs') }, a);
    expect(checkHooks(47821, { 'claude-code': a, codex: b }).map(f => f.level)).toEqual(['ok', 'info']);
    expect(checkHooks(48000, { 'claude-code': a, codex: b })[0]).toMatchObject({ level: 'warn', fix: 'npx behind-everything hooks install --port 48000' });
  });

  it('tells a free port, a port held by something else and a running collector apart', async () => {
    const port = 48300 + Math.floor(Math.random() * 90);
    expect((await checkPort(port)).finding.level).toBe('info');
    const other = net.createServer().listen(port, '127.0.0.1');
    await new Promise(r => other.once('listening', r));
    try {
      expect((await checkPort(port)).finding).toMatchObject({ level: 'fail', fix: `Start Behind Everything on another port: npx behind-everything --port ${port + 1}` });
    } finally {
      other.close();
    }
    const c = await startCollector({ port, claudeRoot: path.join(dir, 'p'), codexRoot: path.join(dir, 'x'), copilotRoot: path.join(dir, 'y'), dbPath: path.join(dir, 'db.sqlite') });
    try {
      const r = await checkPort(port);
      expect(r.finding).toMatchObject({ level: 'ok', title: `Behind Everything is running on http://127.0.0.1:${port}` });
      expect(r.health.process.rss_mb).toBeGreaterThan(0);
    } finally {
      await c.close();
    }
  });
});
