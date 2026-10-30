import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { E2E_ROOT, HOOK_FORWARDER, PORT } from '../playwright.config.ts';
import { CWD, TranscriptBuilder } from '../test/fixtures/claude.ts';

/** The hook bridge end to end: Claude Code asks for permission, the installed hook forwards it, the UI shows it waiting. */

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
const FILE = path.join(E2E_ROOT, 'claude', 'projects', 'C--work-hooks', `${ID}.jsonl`);
const log = () => new TranscriptBuilder(undefined, ID).userPrompt('Tidy the build output')
  .raw({ type: 'ai-title', aiTitle: 'Tidy the build output', sessionId: ID })
  .toolUse('t-rm', 'Bash', { command: 'rm -rf build', description: 'Remove the build folder' });

/** Runs the installed forwarder exactly as Claude Code would: the hook's JSON on stdin. */
function hook(body: object) {
  return new Promise<number | null>(resolve => {
    const p = spawn(process.execPath, [HOOK_FORWARDER, 'claude-code', String(PORT)]);
    p.on('close', resolve);
    p.stdin.end(JSON.stringify(body));
  });
}

test('an approval prompt Claude Code is waiting on shows up live, everywhere, and clears when it runs', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, log().jsonl());
  await expect.poll(async () => (await (await page.request.get('/api/sessions')).json()).some((s: { id: string }) => s.id === `claude-code:${ID}`), { timeout: 15_000 }).toBe(true);

  await page.goto(`/?session=${encodeURIComponent(`claude-code:${ID}`)}`);
  // Fired while the page is still connecting: what happens between the first load and the live stream must not be lost.
  expect(await hook({ session_id: ID, transcript_path: FILE, cwd: CWD, permission_mode: 'default', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: 'Remove the build folder' } })).toBe(0);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Tidy the build output');
  await expect(page.getByRole('banner')).toContainText('Claude Code · log + hook');
  const map = page.getByRole('group', { name: /Workspace map/ });
  const gate = map.getByRole('button', { name: /^Approval Gate:/ });

  await expect(gate).toContainText('1 WAITING');
  await expect(page.getByRole('region', { name: 'Agents' }).getByRole('button', { name: /^Claude/ })).toContainText('Waiting for you');
  await expect(page.getByRole('option', { name: /Remove the build folder/ }).getByLabel('Waiting for your approval')).toBeVisible();
  const row = page.getByRole('navigation', { name: 'Sessions' }).getByRole('button', { name: /Tidy the build output/ });
  await expect(row).toContainText('Waiting for you');
  await expect(page).toHaveTitle(/^\(1\) Waiting · /);

  // You approve in Claude Code; the command runs and its result lands in the transcript.
  fs.appendFileSync(FILE, log().toolResult('t-rm', 'removed').jsonl().split('\n').filter(Boolean).at(-1) + '\n');
  await expect(gate).not.toContainText('WAITING');
  await expect(row).not.toContainText('Waiting for you');
  await expect(page).not.toHaveTitle(/Waiting/);

  await page.getByRole('button', { name: 'Coverage' }).click();
  const coverage = page.getByRole('dialog');
  await expect(coverage).toContainText('Live, through the hook bridge');
  await expect(coverage).toContainText(/Installed · \d+ prompts? received, \d+ shown/);
  expect(errors).toEqual([]);
});
