import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexNotes, hookCommand, install, status, uninstall } from '../src/hooks/install.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'be-hooks-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const forwarder = () => path.join(dir, 'data', 'behind-everything-hook.mjs');
const json = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

describe('hook installer', () => {
  it('adds one background PermissionRequest hook and keeps everything else in the file', () => {
    const file = path.join(dir, 'settings.json');
    const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-check' }] };
    fs.writeFileSync(file, JSON.stringify({ model: 'opus', hooks: { PreToolUse: [mine], PermissionRequest: [mine] } }));
    const c = install('claude-code', { port: 47821, forwarder: forwarder() }, file);
    expect(c.changed).toBe(true);
    expect(fs.readFileSync(c.backup!, 'utf8')).toContain('my-own-check');
    const after = json(file);
    expect(after.model).toBe('opus');
    expect(after.hooks.PreToolUse).toEqual([mine]);
    expect(after.hooks.PermissionRequest).toEqual([mine, { hooks: [{ type: 'command', command: hookCommand('claude-code', { port: 47821, forwarder: forwarder() }), async: true, timeout: 5 }] }]);
    expect(fs.existsSync(forwarder())).toBe(true);
    expect(status('claude-code', file)).toMatchObject({ installed: true, port: 47821 });
  });

  it('is idempotent, follows a new port, and uninstalls exactly what it added', () => {
    const file = path.join(dir, 'codex', 'hooks.json');
    install('codex', { port: 47821, forwarder: forwarder() }, file);
    expect(install('codex', { port: 47821, forwarder: forwarder() }, file).changed).toBe(false);
    install('codex', { port: 48000, forwarder: forwarder() }, file);
    expect(json(file).hooks.PermissionRequest).toHaveLength(1);
    expect(status('codex', file).port).toBe(48000);
    expect(uninstall('codex', file).changed).toBe(true);
    expect(json(file)).toEqual({});
    expect(status('codex', file).installed).toBe(false);
    expect(uninstall('codex', file).changed).toBe(false);
  });

  it('refuses to touch a config it cannot parse', () => {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '{ "hooks": ');
    expect(() => install('claude-code', { port: 1, forwarder: forwarder() }, file)).toThrow(/not valid JSON.*Nothing was changed/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ "hooks": ');
  });

  it('quotes paths with spaces and uses forward slashes, so every shell runs it', () => {
    expect(hookCommand('codex', { port: 47821, forwarder: 'C:\\Users\\A B\\.behind-everything\\behind-everything-hook.mjs' }))
      .toBe('node "C:/Users/A B/.behind-everything/behind-everything-hook.mjs" codex 47821');
  });

  it('warns when Codex has hooks switched off, and always explains trust', () => {
    fs.writeFileSync(path.join(dir, 'config.toml'), 'model = "x"\n[features]\nhooks = false\n[other]\nhooks = true\n');
    expect(codexNotes(dir)[0]).toMatch(/switched off/);
    fs.writeFileSync(path.join(dir, 'config.toml'), '[features]\nweb_search = true\n');
    expect(codexNotes(dir)).toEqual([expect.stringMatching(/trust/)]);
  });
});

describe('hook forwarder', () => {
  /** Runs the installed forwarder the way an assistant does: JSON on stdin, nothing expected back. */
  const run = (port: number, input: string) => {
    install('claude-code', { port, forwarder: forwarder() }, path.join(dir, 'settings.json'));
    return new Promise<{ code: number | null; out: string }>(resolve => {
      const p = spawn(process.execPath, [forwarder(), 'claude-code', String(port)]);
      let out = '';
      p.stdout.on('data', d => (out += d));
      p.stderr.on('data', d => (out += d));
      p.on('close', code => resolve({ code, out }));
      p.stdin.end(input);
    });
  };

  it('posts the hook JSON to the collector and exits 0 silently', async () => {
    const got: Array<{ url?: string; body: string; type?: string }> = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => { got.push({ url: req.url, body, type: req.headers['content-type'] }); res.writeHead(204).end(); });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
      const r = await run((server.address() as { port: number }).port, '{"hook_event_name":"PermissionRequest"}');
      expect(r).toEqual({ code: 0, out: '' });
      expect(got).toEqual([{ url: '/api/hooks/claude-code', body: '{"hook_event_name":"PermissionRequest"}', type: 'application/json' }]);
    } finally {
      server.close();
    }
  });

  it('exits 0 quickly and silently when nothing is listening', async () => {
    const start = Date.now();
    expect(await run(1, '{}')).toEqual({ code: 0, out: '' });
    expect(Date.now() - start).toBeLessThan(5000);
  });
});
