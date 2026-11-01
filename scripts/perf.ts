/**
 * Checks the collector against its performance budget on a heavy, realistic history, using the built package the
 * way `npx` runs it:  pnpm build && pnpm perf
 *
 *   idle CPU < 1 % of one core, memory (RSS) < 120 MB
 *
 * It writes SESSIONS synthetic Claude Code transcripts (no real data) into a temporary home, starts dist/cli.js on
 * them, waits until everything is read, then measures a quiet minute. Exits 1 if a budget is exceeded.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { TranscriptBuilder } from '../test/fixtures/claude.js';

const SESSIONS = Number(process.env.PERF_SESSIONS ?? 30);
const CALLS = Number(process.env.PERF_CALLS ?? 1000);
const IDLE_S = Number(process.env.PERF_IDLE_S ?? 60);
const BUDGET = { idleCpuPct: 1, rssMb: 120 };
const PORT = 47991;

const get = (p: string) => new Promise<any>((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p, agent: false }, res => {
    let d = '';
    res.on('data', c => (d += c));
    res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
  }).on('error', reject);
});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'be-perf-'));
const claude = path.join(root, 'claude');
let lines = 0;
for (let s = 0; s < SESSIONS; s++) {
  const id = `${String(s).padStart(8, '0')}-perf-4000-8000-000000000000`;
  const b = new TranscriptBuilder(undefined, id).userPrompt(`Session ${s}: refactor the billing module`);
  for (let c = 0; c < CALLS; c++) {
    const t = `t-${c}`;
    if (c % 3 === 0) b.toolUse(t, 'Read', { file_path: `C:\\work\\demo\\src\\file${c % 40}.ts` }).toolResult(t, 'export const x = 1;\n'.repeat(40));
    else if (c % 3 === 1) b.toolUse(t, 'Edit', { file_path: `C:\\work\\demo\\src\\file${c % 40}.ts`, old_string: 'a', new_string: 'b' }).toolResult(t, 'ok', { result: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] } });
    else b.toolUse(t, 'Bash', { command: 'pnpm test', description: 'Run the tests' }).toolResult(t, 'Tests  40 passed (40)\n'.repeat(5), { result: { stdout: 'Tests  40 passed (40)', stderr: '' } });
  }
  b.text('Done.', 'end_turn');
  const file = path.join(claude, 'projects', 'C--work-demo', `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, b.jsonl());
  // History, not a session running now: written an hour ago.
  const hourAgo = new Date(Date.now() - 3_600_000);
  fs.utimesSync(file, hourAgo, hourAgo);
  lines += b.lines.length;
}
const bytes = fs.readdirSync(path.join(claude, 'projects', 'C--work-demo')).reduce((n, f) => n + fs.statSync(path.join(claude, 'projects', 'C--work-demo', f)).size, 0);
console.log(`History: ${SESSIONS} sessions, ${lines.toLocaleString()} transcript lines, ${(bytes / 1e6).toFixed(1)} MB`);

const child = spawn(process.execPath, ['dist/cli.js', '--port', String(PORT), '--no-open', '--quiet'], {
  env: { ...process.env, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: path.join(root, 'codex'), COPILOT_HOME: path.join(root, 'copilot'), BE_HOME: path.join(root, 'data') },
  stdio: 'ignore',
});

let exit = 0;
try {
  const t0 = Date.now();
  let peak = 0, last = -1, steady = 0, events = 0;
  for (;;) {
    await sleep(500);
    let h: any;
    try { h = await get('/api/health'); } catch { if (Date.now() - t0 > 60_000) throw new Error('collector did not start'); continue; }
    peak = Math.max(peak, h.process.rss_mb);
    const sessions: any[] = await get('/api/sessions');
    events = sessions.reduce((n, s) => n + s.event_count, 0);
    steady = sessions.length === SESSIONS && events === last ? steady + 1 : 0;
    last = events;
    if (steady >= 4) break;
    if (Date.now() - t0 > 600_000) throw new Error('ingestion did not finish in 10 minutes');
  }
  const ingest = (Date.now() - t0) / 1000;
  console.log(`Read on startup: ${events.toLocaleString()} events in ${ingest.toFixed(1)} s, peak memory ${peak} MB`);

  // A quiet minute: nothing is being written; only the tailers' polling runs.
  // Let the end of loading settle (database checkpoint, garbage collection) before measuring the quiet.
  await sleep(Number(process.env.PERF_SETTLE_S ?? 20) * 1000);
  const a = await get('/api/health');
  await sleep(IDLE_S * 1000);
  const z = await get('/api/health');
  const cpu = ((z.process.cpu_ms - a.process.cpu_ms) / (IDLE_S * 1000)) * 100;
  const rss = z.process.rss_mb;
  console.log(`  (JavaScript heap: ${z.process.heap_mb} MB in use of ${z.process.heap_total_mb} MB reserved; external ${z.process.external_mb} MB)`);
  const row = (name: string, value: string, budget: string, ok: boolean) => console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(14)} ${value.padStart(9)}   budget ${budget}`);
  console.log(`Idle for ${IDLE_S} s:`);
  row('CPU (one core)', `${cpu.toFixed(2)} %`, `< ${BUDGET.idleCpuPct} %`, cpu < BUDGET.idleCpuPct);
  row('Memory (RSS)', `${rss} MB`, `< ${BUDGET.rssMb} MB`, rss < BUDGET.rssMb);
  if (cpu >= BUDGET.idleCpuPct || rss >= BUDGET.rssMb) exit = 1;
} finally {
  child.kill();
  await sleep(500);
  fs.rmSync(root, { recursive: true, force: true });
}
process.exit(exit);
