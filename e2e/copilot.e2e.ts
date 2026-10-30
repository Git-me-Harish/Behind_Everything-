import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { COPILOT_LOG } from '../playwright.config.ts';
import { COPILOT_SESSION, copilotLive } from '../test/fixtures/copilot.ts';

/** A Copilot session through the same screens — and an approval Copilot is waiting on, answered while you watch. */

test('a Copilot session reads as Copilot everywhere, and shows an approval it is waiting on live', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('/');
  const list = page.getByRole('navigation', { name: 'Sessions' });
  await expect(list.getByRole('img', { name: 'Copilot CLI' })).toBeVisible();
  await list.getByRole('button', { name: /Add tags to notes/ }).click();
  await expect(page).toHaveURL(new RegExp(`session=copilot-cli%3A${COPILOT_SESSION}`));

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Add tags to notes');
  await expect(page.getByRole('banner')).toContainText('Copilot CLI · log');
  await expect(page.getByRole('region', { name: 'Session' })).toContainText('Copilot CLI 1.0.75');
  // Copilot does not log tokens: say so rather than show zero.
  await expect(page.getByRole('region', { name: 'Session' }).getByTitle('Copilot CLI does not log token usage per call')).toContainText('—');
  const copilot = page.getByRole('region', { name: 'Agents' }).getByRole('button', { name: /^Copilot/ });
  await expect(copilot).toContainText('Waiting for you');

  const map = page.getByRole('group', { name: /Workspace map/ });
  const room = (name: string) => map.getByRole('button', { name: new RegExp(`^${name}:`) });
  await expect(room('Test & Build Lab')).toContainText('TESTS 1✓ 1✗');
  await expect(room('Implementation')).toContainText('3 FILES · +8 −3');
  await expect(room('Planning Desk')).toContainText('PLAN 1/2');
  // Copilot asked to run a command and is still waiting for the answer.
  await expect(room('Approval Gate')).toContainText('1 WAITING');
  await expect(page.getByRole('option', { name: /Remove the old build output/ }).getByLabel('Waiting for your approval')).toBeVisible();
  // Waiting for you is not the command being slow.
  await expect(page.getByRole('region', { name: 'Needs attention' })).toContainText('Waiting for approval: Run Remove-Item -Recurse -Force dist');
  await expect(page.getByRole('region', { name: 'Needs attention' })).not.toContainText('Still running');
  await expect(map.getByRole('button', { name: /^Copilot:/ })).toBeAttached();
  await expect(map.getByRole('button', { name: /^Copilot:/ }).locator('.mascot')).toHaveCount(0);

  // You answer in Copilot; its log records the decision and the rest of the turn.
  fs.appendFileSync(COPILOT_LOG, copilotLive().answer);
  await expect(room('Approval Gate')).toContainText('2 APPROVED · 1 BLOCKED');
  await expect(page.getByRole('option', { name: /Remove the old build output/ }).getByLabel('Approved by you')).toBeVisible();

  await page.getByRole('button', { name: 'Coverage' }).click();
  const coverage = page.getByRole('dialog');
  await expect(coverage).toContainText('Copilot session logs');
  await expect(coverage).toContainText('copilot-log v1');
  await expect(coverage).toContainText('A permission prompt still waiting for you');
  expect(errors).toEqual([]);
});
