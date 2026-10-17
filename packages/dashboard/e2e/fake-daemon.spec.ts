/** Against the real entry point: `node packages/daemon/dist/main.js --fake`. */
import { expect, test } from '@playwright/test';
import type { SpawnedDaemon } from './daemons.js';
import { spawnFakeDaemon } from './daemons.js';
import {
  expectAccessible,
  expectNoSidewaysScroll,
  openLogs,
  screenshot,
  watchPage,
} from './helpers.js';

let daemon: SpawnedDaemon;

test.beforeEach(async () => {
  daemon = await spawnFakeDaemon();
});
test.afterEach(async () => {
  await daemon.cleanup();
});

test('logs in within the window and shows the attached fake app', async ({ page }) => {
  const watch = await watchPage(page);
  await openLogs(page, daemon.url);
  await expect(page.getByRole('combobox', { name: 'App' })).toHaveText(
    /com\.example\.shop · Pixel 9 API 36 · IDE/,
  );
  const cookies = await page.context().cookies();
  expect(cookies.map((c) => [c.name, c.httpOnly, c.sameSite])).toEqual([
    [`deck_session_${daemon.port}`, true, 'Strict'],
  ]);
  // The fake app logs a heartbeat every 2 s.
  await expect(page.getByText('Heartbeat from the fake app').first()).toBeVisible({
    timeout: 5000,
  });
  expect(watch.cspViolations).toEqual([]);
  expect(watch.consoleErrors).toEqual([]);
});

test('reloads with the button and with r, restarts with R', async ({ page }) => {
  await openLogs(page, daemon.url);
  const calls: string[] = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    // The Database tab stays mounted and reads its rows with POSTs too.
    if (r.method() === 'POST' && !path.startsWith('/api/db')) calls.push(path);
  });
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Reloaded in 120 ms' })).toBeVisible();
  await page.locator('body').click({ position: { x: 5, y: 790 } });
  await Promise.all([page.waitForResponse('**/api/reload'), page.keyboard.press('r')]);
  // While a reload runs the buttons are busy, so wait for it to finish first.
  await expect(page.getByRole('button', { name: 'Reload' })).not.toHaveAttribute('aria-disabled');
  await page.keyboard.press('Shift+R');
  await expect(page.getByRole('banner').getByText('Restarted in 900 ms')).toBeVisible();
  expect(calls).toEqual(['/api/reload', '/api/reload', '/api/restart']);
});

test('the shortcuts switch turns r off, and the choice survives a reload', async ({ page }) => {
  await openLogs(page, daemon.url);
  await page.getByRole('button', { name: 'More log options' }).click();
  await page.getByRole('switch', { name: /Keyboard shortcuts r \/ R: on/ }).click();
  await expect(page.getByRole('switch', { name: /: off/ })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  let reloads = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/api/reload')) reloads++;
  });
  await page.locator('body').click({ position: { x: 5, y: 790 } });
  await page.keyboard.press('r');
  await page.reload();
  await expect(page.getByRole('contentinfo')).toContainText('Connected');
  await page.keyboard.press('r');
  await page.waitForTimeout(300);
  expect(reloads).toBe(0);
  await expect(page.getByRole('button', { name: 'Reload' })).not.toHaveAttribute(
    'aria-keyshortcuts',
  );
});

test('Activity shows "Claude is waiting" posted by a hook', async ({ page, request }) => {
  await openLogs(page, daemon.url);
  await page.getByRole('tab', { name: 'Activity' }).click();
  const res = await request.post(`${daemon.url}/api/events`, {
    headers: { 'x-deck-token': daemon.token },
    data: { type: 'claude.waiting', message: 'Claude needs your permission to use Bash' },
  });
  expect(res.ok()).toBe(true);
  await expect(
    page.getByText('Claude is waiting: Claude needs your permission to use Bash'),
  ).toBeVisible();
});

test('a daemon restart shows the retry banner, then recovers with one page reload, twice', async ({
  page,
}) => {
  await openLogs(page, daemon.url);
  let loads = 0;
  page.on('load', () => loads++);
  for (const round of [1, 2]) {
    await daemon.stop();
    await expect(
      page.getByRole('status').filter({ hasText: /Lost connection to FlutterDeck — retrying/ }),
    ).toBeVisible();
    await expect(page.getByRole('contentinfo')).toContainText('Not connected');
    await daemon.restart();
    await expect(page.getByRole('contentinfo')).toContainText('Connected', { timeout: 15_000 });
    await expect(page.getByRole('combobox', { name: 'App' })).toBeVisible();
    expect(loads, `round ${round}`).toBe(round);
  }
});

for (const width of [420, 320]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`${width} px, ${scheme}: no sideways scroll, no serious axe issues`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme: scheme });
      await openLogs(page, daemon.url);
      await expect(page.getByText('Heartbeat from the fake app').first()).toBeVisible({
        timeout: 5000,
      });
      await expectNoSidewaysScroll(page);
      await expectAccessible(page);
      await screenshot(page, `fake-${width}-${scheme}`);
      await page.getByRole('button', { name: 'More log options' }).click();
      await expectNoSidewaysScroll(page);
      await expectAccessible(page);
      await page.getByRole('tab', { name: 'Activity' }).click();
      await expectNoSidewaysScroll(page);
      await expectAccessible(page);
      await screenshot(page, `fake-${width}-${scheme}-activity`);
    });
  }
}

test('light and dark themes use different backgrounds', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openLogs(page, daemon.url);
  const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.emulateMedia({ colorScheme: 'dark' });
  const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(light).toBe('rgb(255, 255, 255)');
  expect(dark).toBe('rgb(18, 20, 24)');
});

test('the built page has no inline script or style for the CSP to block', async ({ request }) => {
  const res = await request.get(daemon.url, {
    headers: { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' },
  });
  const html = await res.text();
  expect(html).toContain('<div id="root"></div>');
  expect(res.headers()['content-security-policy']).toContain("default-src 'self'");
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  expect(html).not.toMatch(/<style|\sstyle=|\son[a-z]+=/i);
});
