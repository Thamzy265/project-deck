/**
 * Tester probes in a real browser against `main.js --fake` (writes on): keyboard-only
 * use of the row details and the write confirm, axe with those dialogs open, and where
 * row values end up (UI spec, Accessibility; design note, Privacy).
 */
import { expect, test } from '@playwright/test';
import type { SpawnedDaemon } from './daemons.js';
import { spawnFakeDaemon } from './daemons.js';
import { expectAccessible, openDashboard } from './helpers.js';

let daemon: SpawnedDaemon;
test.beforeEach(async () => {
  daemon = await spawnFakeDaemon({ config: { db: { allowWrites: true } } });
});
test.afterEach(async () => {
  await daemon.cleanup();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`${scheme}, 320 px: row details and the confirm dialog work by keyboard and pass axe`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 320, height: 800 });
    await openDashboard(page, daemon.url);
    await page.getByRole('combobox', { name: 'Table' }).selectOption('orders');
    const grid = page.getByRole('grid', { name: 'orders rows' });
    await expect(grid.getByText('Coffee')).toBeVisible();
    const cell = grid.getByRole('gridcell').first();
    await cell.focus();
    await page.keyboard.press('Enter');
    const details = page.getByRole('dialog', { name: /^orders: id / });
    await expect(details).toBeVisible();
    await expectAccessible(page);

    await details.getByRole('button', { name: 'Delete row' }).focus();
    await page.keyboard.press('Enter');
    const confirm = page.getByRole('alertdialog', { name: 'Run this change?' });
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expectAccessible(page);
    // Focus stays inside the dialog both ways round.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      expect(await confirm.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await confirm.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(confirm).toBeHidden();
    // Back on the trigger, and nothing ran.
    await expect(details.getByRole('button', { name: 'Delete row' })).toBeFocused();
    await expect(grid.getByText('Coffee')).toBeVisible();
  });
}

test('row values stay out of storage, the URL, the title and Activity', async ({ page }) => {
  await openDashboard(page, daemon.url);
  await page.getByRole('combobox', { name: 'Table' }).selectOption('orders');
  const grid = page.getByRole('grid', { name: 'orders rows' });
  await page.getByRole('searchbox', { name: 'Filter rows' }).fill('Coffee');
  await grid.getByText('Coffee').click();
  const details = page.getByRole('dialog', { name: /^orders: id / });
  await details.getByRole('button', { name: 'Edit' }).click();
  await details.getByRole('textbox', { name: /^status/ }).fill('secret-status-4711');
  await details.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Run change' }).click();
  await expect(page.getByText('1 row changed', { exact: true })).toBeVisible();
  await details.getByRole('button', { name: 'Close' }).click();

  const stored = await page.evaluate(() => {
    const dump = (s: Storage) =>
      Array.from({ length: s.length }, (_, i) => {
        const k = s.key(i) ?? '';
        return `${k}=${s.getItem(k) ?? ''}`;
      }).join('\n');
    return `${dump(localStorage)}\n${dump(sessionStorage)}`;
  });
  for (const value of ['Coffee', 'secret-status-4711', 'Ada']) {
    expect(stored, value).not.toContain(value);
    expect(page.url(), value).not.toContain(value);
    expect(await page.title(), value).not.toContain(value);
  }
  await page.getByRole('tab', { name: 'Activity' }).click();
  await expect(page.getByText('Write allowed: orders, 1 row changed')).toBeVisible();
  const activity = await page.getByRole('tabpanel', { name: 'Activity' }).innerText();
  expect(activity).not.toContain('secret-status-4711');
  expect(activity).not.toContain('UPDATE');
});
