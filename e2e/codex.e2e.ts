import { expect, test } from '@playwright/test';
import { CODEX_SESSION } from '../test/fixtures/codex.ts';

/** A Codex session through the same screens: list, header, agents, the 3D map, coverage. */

test('a Codex session reads as Codex everywhere, with the same rooms filled from its own log', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('/');
  const list = page.getByRole('navigation', { name: 'Sessions' });
  await expect(list.getByRole('img', { name: 'Codex' })).toBeVisible();
  await expect(list.getByRole('img', { name: 'Claude Code' })).toBeVisible();
  await list.getByRole('button', { name: /Fix the cart total rounding bug/ }).click();
  await expect(page).toHaveURL(new RegExp(`session=codex%3A${CODEX_SESSION}`));

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Fix the cart total rounding bug');
  await expect(page.getByRole('banner')).toContainText('Codex · log');
  await expect(page.getByRole('region', { name: 'Session' })).toContainText('Codex 0.162.0');
  await expect(page.getByRole('region', { name: 'Agents' }).getByRole('button', { name: /Codex/ })).toBeVisible();

  const map = page.getByRole('group', { name: /Workspace map/ });
  const room = (name: string) => map.getByRole('button', { name: new RegExp(`^${name}:`) });
  await expect(room('Test & Build Lab')).toContainText('TESTS 1✓ 1✗');
  await expect(room('Implementation')).toContainText('2 FILES · +4 −1');
  await expect(room('Approval Gate')).toContainText('1 APPROVED');
  // Codex is a person, not Claude's mascot.
  const tag = map.getByRole('button', { name: /^Codex:/ });
  await expect(tag).toBeAttached();
  await expect(tag.locator('.mascot')).toHaveCount(0);
  await expect(map.getByRole('button', { name: 'Follow Codex' })).toBeVisible();

  await page.getByRole('button', { name: 'Coverage' }).click();
  const coverage = page.getByRole('dialog');
  await expect(coverage).toContainText('Codex rollout logs');
  await expect(coverage).toContainText('codex-log v1');
  await expect(coverage).toContainText('0 unrecognised');
  expect(errors).toEqual([]);
});
