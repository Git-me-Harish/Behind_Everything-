import http from 'node:http';
import { codexNotes, HOOK_ASSISTANTS, install, status, uninstall, type Change, type HookAssistant } from './install.js';

export const HOOKS_HELP = `behind-everything hooks — the opt-in bridge that shows approval prompts while they wait for you

Usage: behind-everything hooks <install | uninstall | status> [--claude] [--codex] [--port <n>]

  install     Add a PermissionRequest hook to Claude Code (~/.claude/settings.json) and Codex (~/.codex/hooks.json).
              Your config is backed up first; your own hooks are kept. The hook runs in the background, never
              decides anything, and does nothing when Behind Everything is not running.
  uninstall   Remove exactly what install added.
  status      Show what is installed and whether the running collector has received hook calls.

  --claude / --codex   Only that assistant (default: both)
  --port <n>           The port Behind Everything runs on (default 47821)
`;

const NAME: Record<HookAssistant, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

export async function runHooks(action: string | undefined, o: { claude?: boolean; codex?: boolean; port: number }, out: (s: string) => void): Promise<number> {
  const targets = HOOK_ASSISTANTS.filter(a => (!o.claude && !o.codex) || (a === 'claude-code' ? o.claude : o.codex));
  const report = (c: Change, verb: string) => out(`${NAME[c.assistant]}: ${c.changed ? `${verb} in ${c.file}${c.backup ? ` (backup: ${c.backup})` : ''}` : `nothing to change in ${c.file}`}\n`);
  try {
    switch (action) {
      case 'install':
        for (const a of targets) report(install(a, { port: o.port }), 'hook added');
        if (targets.includes('codex')) for (const n of codexNotes()) out(`Codex: ${n}\n`);
        out('Claude Code picks the hook up in new sessions. Run `behind-everything hooks status` to check it is working.\n');
        return 0;
      case 'uninstall':
        for (const a of targets) report(uninstall(a), 'hook removed');
        return 0;
      case 'status': {
        const health = await fetchHealth(o.port);
        for (const a of targets) {
          const s = status(a);
          const seen = health?.sources?.find((x: any) => x.assistant === a)?.hooks;
          const state = s.error ? `cannot read ${s.file}: ${s.error}`
            : !s.installed ? 'not installed'
            : `installed (port ${s.port ?? '?'}${s.port !== o.port ? ` — not ${o.port}, reinstall with --port ${o.port}` : ''})`;
          const live = !health ? 'Behind Everything is not running on this port'
            : seen?.events ? `${seen.events} hook call(s) received, ${seen.matched} matched to a running call${seen.unmatched ? `, ${seen.unmatched} unmatched` : ''}`
            : 'no hook calls received yet (they arrive when an approval prompt opens)';
          out(`${NAME[a]}: ${state}; ${live}\n`);
        }
        return 0;
      }
      default:
        out(HOOKS_HELP);
        return action ? 1 : 0;
    }
  } catch (err) {
    out(`${(err as Error).message}\n`);
    return 1;
  }
}

function fetchHealth(port: number): Promise<any | undefined> {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1000 }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(undefined); } });
    });
    req.on('error', () => resolve(undefined));
    req.on('timeout', () => { req.destroy(); resolve(undefined); });
  });
}
