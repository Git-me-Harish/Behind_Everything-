/**
 * Writes the demo sessions the first-run screen offers (web/public/demo-*.json): the synthetic test sessions for
 * each assistant, exported exactly as a user would share one. No real data.  pnpm demo:sessions
 */
import fs from 'node:fs';
import path from 'node:path';
import { createClaudeParser } from '../src/adapters/claude-code/parse.js';
import { createCodexParser } from '../src/adapters/codex/parse.js';
import { createCopilotParser } from '../src/adapters/copilot-cli/parse.js';
import type { CanonicalEvent, SessionInfo } from '../src/core/schema.js';
import { exportSession, SHARE_ALL } from '../src/core/share.js';
import { demoSession } from '../test/fixtures/claude.js';
import { codexSession } from '../test/fixtures/codex.js';
import { copilotSession } from '../test/fixtures/copilot.js';

const OUT = 'web/public';
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;

function parse(parser: { parse(l: string, n: number): CanonicalEvent[]; idle?(): CanonicalEvent[]; readonly session: SessionInfo | undefined }, jsonl: string) {
  const events = jsonl.split('\n').flatMap((l, i) => (l ? parser.parse(l, i + 1) : []));
  return { session: parser.session!, events: [...events, ...(parser.idle?.() ?? [])] };
}

const demos = {
  'claude-code': parse(createClaudeParser('demo/claude.jsonl'), demoSession().main.jsonl()),
  codex: parse(createCodexParser('demo/rollout.jsonl'), codexSession().jsonl()),
  'copilot-cli': parse(createCopilotParser('demo/copilot/events.jsonl'), copilotSession().jsonl()),
};

fs.mkdirSync(OUT, { recursive: true });
for (const [name, { session, events }] of Object.entries(demos)) {
  const bundle = exportSession({ ...session, id: `demo:${session.id}`, title: session.title ?? 'Demo session' }, events, SHARE_ALL, { home: '', appVersion: version });
  fs.writeFileSync(path.join(OUT, `demo-${name}.json`), JSON.stringify(bundle) + '\n');
  console.log(`${name}: ${bundle.events.length} events, "${bundle.session.title}"`);
}
