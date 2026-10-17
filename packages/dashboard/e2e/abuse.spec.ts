/**
 * Tester's abuse cases in a real browser: untrusted log text, floods, catastrophic search
 * patterns, keyboard paths and two open tabs. Against the in-process scripted daemon.
 */
import type { LogEntry } from '@project-deck/core';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import type { ScriptedDaemon } from './daemons.js';
import { startScriptedDaemon } from './daemons.js';
import { expectNoSidewaysScroll, openLogs, screenshot, watchPage } from './helpers.js';

let deck: ScriptedDaemon;
test.afterEach(async () => {
  await deck.cleanup();
});

function push(entry: Partial<LogEntry> & { message: string }) {
  const s = deck.connector.sessions.get('app-1');
  if (s === undefined) throw new Error('no session for app-1');
  s.logs().push({ ts: Date.now(), level: 'info', source: 'app', ...entry });
}

/** Resolves false when the page's main thread doesn't answer within `ms`. */
async function responsive(page: Page, ms: number): Promise<boolean> {
  return Promise.race([
    page.evaluate(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

const PAYLOADS = [
  '<img src=x onerror="window.__pwned=1">',
  '<script>window.__pwned=1</script>',
  '<a href="javascript:window.__pwned=1">click me</a>',
  'javascript:window.__pwned=1',
  '<iframe srcdoc="<script>parent.__pwned=1</script>"></iframe>',
  '<svg onload="window.__pwned=1"></svg>',
  'user ‮gnp.exe‬ done',
  'pass​word‍﻿',
  '\u001b[31mred error\u001b[0m',
];

test('untrusted log text never runs or becomes markup, and 320 px holds', async ({ page }) => {
  deck = await startScriptedDaemon();
  const watch = await watchPage(page);
  let dialogs = 0;
  page.on('dialog', (d) => {
    dialogs++;
    void d.dismiss();
  });
  await page.setViewportSize({ width: 320, height: 800 });
  await openLogs(page, deck.url);
  for (const message of PAYLOADS) push({ message, tag: '<b>tag</b>' });
  push({ message: `huge ${'y'.repeat(1024 * 1024)}` });
  const list = page.getByRole('list', { name: 'Log lines' });
  await expect(list.getByText('red error')).toBeVisible();
  expect(await list.locator('img, script, a, iframe, svg, b').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBe(
    undefined,
  );
  expect(dialogs).toBe(0);
  expect(watch.cspViolations).toEqual([]);
  await expectNoSidewaysScroll(page);

  // The bidi override stays inside the message: the time column is still left of it.
  const row = list.getByRole('listitem').filter({ hasText: 'done' });
  const time = await row.locator('span').first().boundingBox();
  const message = await row.getByText(/gnp\.exe/).boundingBox();
  expect(time).not.toBeNull();
  expect(message).not.toBeNull();
  expect(time?.y ?? 0).toBeLessThanOrEqual(message?.y ?? 0);
  await screenshot(page, 'abuse-untrusted-320');
});

test('a 10,000-line burst keeps the page responsive and the list virtual', async ({ page }) => {
  deck = await startScriptedDaemon();
  await openLogs(page, deck.url);
  for (let i = 0; i < 10_000; i++) push({ message: `burst ${i}` });
  await expect(page.getByText('burst 9999')).toBeVisible({ timeout: 10_000 });
  expect(await responsive(page, 1_000)).toBe(true);
  const rows = await page.getByRole('list', { name: 'Log lines' }).getByRole('listitem').count();
  expect(rows).toBeLessThan(200);
  await page.getByRole('searchbox', { name: 'Search logs' }).fill('burst 5\\d{3}$');
  await expect(page.getByText('Showing 1,000 of 10,000')).toBeVisible();
  expect(await responsive(page, 1_000)).toBe(true);
});

test('BUG-M2-T1: typing a catastrophic pattern does not freeze the tab', async ({ page }) => {
  test.setTimeout(30_000);
  deck = await startScriptedDaemon();
  await openLogs(page, deck.url);
  push({ message: `${'a'.repeat(30)}!` });
  await expect(page.getByText('!', { exact: false })).toBeVisible();
  // fill() sets the whole value at once, like a paste; it returns once the page has
  // handled the input, so a freeze shows up as its duration.
  const started = Date.now();
  await page.getByRole('searchbox', { name: 'Search logs' }).fill('(a+)+$');
  expect(await responsive(page, 2_000)).toBe(true);
  expect(Date.now() - started).toBeLessThan(2_000);
});

test('BUG-M2-T1: a slow pattern the check misses is stopped in the worker after 200 ms', async ({
  page,
}) => {
  deck = await startScriptedDaemon();
  const watch = await watchPage(page);
  const workerFiles: number[] = [];
  page.on('response', (r) => {
    if (/\/assets\/search-worker-[\w-]+\.js$/.test(r.url())) workerFiles.push(r.status());
  });
  await openLogs(page, deck.url);
  push({ message: `${'a'.repeat(30)}!` });
  push({ message: 'Tap 1' });
  const list = page.getByRole('list', { name: 'Log lines' });
  await expect(list.getByText('Tap 1')).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'Search logs' });
  // Alternation, not a nested quantifier, so only the time budget can stop it.
  await search.fill('(a|a)*b');
  await expect(page.getByText('That search took too long and was stopped.')).toBeVisible();
  await expect(search).toHaveAttribute('aria-invalid', 'true');
  expect(await responsive(page, 1_000)).toBe(true);
  // No result for this pattern, so no lines: never the unfiltered list (review C3).
  await expect(list).toBeHidden();
  // A fresh worker answers the next search.
  await search.fill('tap');
  await expect(page.getByText('That search took too long and was stopped.')).toBeHidden();
  await expect(page.getByText(/Showing 1 of 2/)).toBeVisible();
  expect(workerFiles.length).toBeGreaterThan(0);
  expect(workerFiles.every((status) => status === 200)).toBe(true);
  expect(watch.cspViolations).toEqual([]);
  expect(watch.consoleErrors).toEqual([]);
});

test('r in the search box types, r on the page reloads, Escape returns focus', async ({ page }) => {
  deck = await startScriptedDaemon();
  await openLogs(page, deck.url);
  push({ message: 'Tap 1' });
  const search = page.getByRole('searchbox', { name: 'Search logs' });
  await search.click();
  await page.keyboard.type('rR');
  await expect(search).toHaveValue('rR');
  await expect(page.getByText('No reload yet')).toBeVisible();
  await page.getByRole('combobox', { name: 'Level' }).focus();
  await page.keyboard.press('r');
  await expect(page.getByText('No reload yet')).toBeVisible();

  await search.fill('');
  await page.getByRole('button', { name: 'More log options' }).click();
  await page.getByRole('button', { name: 'Clear logs' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('r');
  await expect(page.getByText('No reload yet')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'More log options' })).toBeFocused();

  await page.getByRole('tab', { name: 'Logs' }).focus();
  await page.keyboard.press('r');
  await expect(page.getByRole('banner').getByText(/^Reloaded in \d+ ms$/)).toBeVisible();
});

test('two tabs: a reload in one shows in the other', async ({ page, context }) => {
  deck = await startScriptedDaemon();
  await openLogs(page, deck.url);
  const other = await context.newPage();
  await openLogs(other, deck.url);
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByRole('banner').getByText(/^Reloaded in \d+ ms$/)).toBeVisible();
  await expect(other.getByRole('banner').getByText(/^Reloaded/)).toBeVisible();
  push({ message: 'seen in both' });
  await expect(page.getByText('seen in both')).toBeVisible();
  await expect(other.getByText('seen in both')).toBeVisible();
});

// BUG-M2-T2 (fixed): clearing logs in one tab must clear every other open tab too. The
// Clear button is the delete path in the design note's privacy section.
test('BUG-M2-T2: two tabs: clearing logs in one clears the other', async ({ page, context }) => {
  deck = await startScriptedDaemon();
  await openLogs(page, deck.url);
  const other = await context.newPage();
  await openLogs(other, deck.url);
  push({ message: 'personal data line' });
  await expect(other.getByText('personal data line')).toBeVisible();
  await page.getByRole('button', { name: 'More log options' }).click();
  await page.getByRole('button', { name: 'Clear logs' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Clear logs' }).click();
  await expect(page.getByText('personal data line')).toBeHidden();
  await expect(other.getByText('personal data line')).toBeHidden({ timeout: 3_000 });
});
