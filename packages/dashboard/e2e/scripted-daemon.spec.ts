/**
 * States `main.js --fake` can't produce, against the same daemon started in-process with
 * scriptable fake apps and a fake login-window clock.
 */
import type { LogEntry } from '@project-deck/core';
import { expect, test } from '@playwright/test';
import type { ScriptedDaemon } from './daemons.js';
import { fakeApp, startScriptedDaemon } from './daemons.js';
import {
  expectAccessible,
  expectNoSidewaysScroll,
  openDashboard,
  screenshot,
  watchPage,
} from './helpers.js';

const LOGIN_WINDOW_MS = 2 * 60 * 1000;
const admin = fakeApp({ id: 'app-2', name: 'com.example.admin', startedBy: 'terminal' });

let deck: ScriptedDaemon;
test.afterEach(async () => {
  await deck.cleanup();
});

function session(id = 'app-1') {
  const s = deck.connector.sessions.get(id);
  if (s === undefined) throw new Error(`no session for ${id}`);
  return s;
}

function push(entry: Partial<LogEntry> & { message: string }) {
  session()
    .logs()
    .push({ ts: Date.now(), level: 'info', source: 'app', ...entry });
}

test('"Login needed" once the 2-minute window has closed; an old cookie still works', async ({
  page,
  browser,
}) => {
  deck = await startScriptedDaemon();
  await openDashboard(page, deck.url);
  deck.advance(LOGIN_WINDOW_MS + 1000);
  const late = await browser.newContext();
  const latePage = await late.newPage();
  await latePage.goto(deck.url);
  await expect(
    latePage.getByText(/Login needed\. Run flutterdeck open in your project/),
  ).toBeVisible();
  expect(await late.cookies()).toEqual([]);
  await late.close();
  await page.reload();
  await expect(page.getByRole('contentinfo')).toContainText('Connected');
});

test('a new log line shows in under 250 ms', async ({ page }) => {
  deck = await startScriptedDaemon();
  await openDashboard(page, deck.url);
  await page.evaluate(() => {
    const w = window as unknown as { __seenAt?: number };
    new MutationObserver((_, obs) => {
      if (document.body.textContent.includes('latency probe')) {
        w.__seenAt = Date.now();
        obs.disconnect();
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  const samples: number[] = [];
  const sentAt = Date.now();
  push({ message: 'latency probe' });
  await page.waitForFunction(
    () => (window as unknown as { __seenAt?: number }).__seenAt !== undefined,
  );
  const seenAt = await page.evaluate(() => (window as unknown as { __seenAt: number }).__seenAt);
  samples.push(seenAt - sentAt);
  test.info().annotations.push({ type: 'latency-ms', description: String(samples[0]) });
  expect(seenAt - sentAt).toBeLessThan(250);
});

test('filters by level, text, source and tag; invalid patterns are explained', async ({ page }) => {
  deck = await startScriptedDaemon();
  await openDashboard(page, deck.url);
  push({ message: 'Tap 1', tag: 'flutter' });
  push({
    message: 'Choreographer skipped frames',
    level: 'warn',
    source: 'native',
    tag: 'Choreographer',
  });
  push({ message: 'Boom', level: 'error', tag: 'flutter' });
  const list = page.getByRole('list', { name: 'Log lines' });
  await expect(list.getByText('Boom')).toBeVisible();

  await page.getByRole('combobox', { name: 'Level' }).selectOption('error');
  await expect(list.getByText('Tap 1')).toBeHidden();
  await expect(page.getByText(/Showing 1 of \d/)).toBeVisible();
  await page.getByRole('combobox', { name: 'Level' }).selectOption('all');

  const search = page.getByRole('searchbox', { name: 'Search logs' });
  await search.fill('tap \\d');
  await expect(list.getByText('Boom')).toBeHidden();
  await search.fill('(');
  await expect(page.getByText("That pattern isn't valid")).toBeVisible();
  await expect(search).toHaveAttribute('aria-invalid', 'true');
  await expect(list.getByText('Boom')).toBeVisible();
  await search.fill('');

  await page.getByRole('button', { name: 'More log options' }).click();
  await page.getByRole('combobox', { name: 'Source' }).selectOption('native');
  await expect(list.getByText('Choreographer skipped frames')).toBeVisible();
  await expect(list.getByText('Tap 1')).toBeHidden();
  await page.getByRole('combobox', { name: 'Source' }).selectOption('all');
  await page.getByRole('combobox', { name: 'Tag' }).selectOption('flutter');
  await expect(list.getByText('Choreographer skipped frames')).toBeHidden();
  await expect(list.getByText('Tap 1')).toBeVisible();
});

test('several apps: pick one to attach', async ({ page }) => {
  deck = await startScriptedDaemon([fakeApp(), admin]);
  await openDashboard(page, deck.url);
  const picker = page.getByRole('combobox', { name: 'App' });
  await expect(picker).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Reload' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expectAccessible(page);
  await picker.selectOption('app-2');
  await expect(picker).toHaveValue('app-2');
  await expect(page.getByRole('button', { name: 'Reload' })).not.toHaveAttribute('aria-disabled');
  await page.getByRole('tab', { name: 'Activity' }).click();
  await expect(page.getByText('Attached to com.example.admin')).toBeVisible();
});

test('attach errors offer to try again', async ({ page }) => {
  deck = await startScriptedDaemon([fakeApp(), admin]);
  await openDashboard(page, deck.url);
  deck.connector.failAttach = 'VM service closed';
  await page.getByRole('combobox', { name: 'App' }).selectOption('app-2');
  await expect(page.getByRole('alert')).toContainText(
    "Couldn't attach: VM service closed. Try again",
  );
  deck.connector.failAttach = undefined;
  await page.getByRole('button', { name: 'Try attaching to com.example.admin again' }).click();
  await expect(page.getByRole('combobox', { name: 'App' })).toHaveValue('app-2');
});

test('"Finding apps…" until discovery is done, then "No app running"', async ({ page }) => {
  deck = await startScriptedDaemon([], { holdDiscovery: true });
  await openDashboard(page, deck.url);
  await expect(page.getByText('Finding apps…')).toBeVisible();
  await expectAccessible(page);
  deck.connector.finishDiscovery();
  await expect(page.getByText('No app running')).toBeVisible();
  await expect(page.getByText('Finding apps…')).toBeHidden();
});

test('no app running, then the app starts and is attached', async ({ page }) => {
  deck = await startScriptedDaemon([]);
  await openDashboard(page, deck.url);
  await expect(page.getByText('No app running')).toBeVisible();
  await expectAccessible(page);
  await screenshot(page, 'no-app-420');
  deck.connector.addApp(fakeApp());
  await expect(page.getByRole('combobox', { name: 'App' })).toHaveValue('app-1');
});

test('app stopped: the logs stay and it says so', async ({ page }) => {
  deck = await startScriptedDaemon();
  await openDashboard(page, deck.url);
  push({ message: 'last words' });
  await expect(page.getByText('last words')).toBeVisible();
  deck.connector.removeApp('app-1');
  await expect(page.getByText('App stopped — com.example.shop')).toBeVisible();
  await expect(page.getByText('last words')).toBeVisible();
  await page.getByRole('tab', { name: 'Activity' }).click();
  await expect(page.getByText('App stopped', { exact: true })).toBeVisible();
});

test('reload failed: red chip, first error lines, Show in Logs', async ({ page }) => {
  deck = await startScriptedDaemon();
  await openDashboard(page, deck.url);
  // As the real connector does: a short message, and the compiler's errors in the logs.
  session().nextReload({
    ok: false,
    reason: 'compile-error',
    message: 'Hot reload failed, probably a compile error. Check the latest error logs.',
  });
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByRole('button', { name: 'Last reload: failed, 1 error' })).toBeVisible();
  for (const line of [
    "lib/main.dart:12:3: Error: Expected ';' after this.",
    'two',
    'three',
    'four',
  ]) {
    push({ message: line, level: 'error' });
  }
  await expect(page.getByRole('button', { name: 'Last reload: failed, 3 errors' })).toBeVisible();
  const details = page.locator('#reload-errors');
  await expect(
    details.getByText("lib/main.dart:12:3: Error: Expected ';' after this."),
  ).toBeVisible();
  await expect(details.getByText('four')).toBeHidden();
  await expectAccessible(page);
  await screenshot(page, 'reload-failed-420');
  await page.setViewportSize({ width: 320, height: 800 });
  await expectNoSidewaysScroll(page);
  await screenshot(page, 'reload-failed-320');
  await page.getByRole('button', { name: 'Show in Logs' }).click();
  await expect(page.getByRole('combobox', { name: 'Level' })).toHaveValue('error');
  await expect(page.getByRole('list', { name: 'Log lines' })).toBeFocused();
});

test('reloads by Claude or the IDE show in the header and Activity', async ({ page }) => {
  deck = await startScriptedDaemon();
  await openDashboard(page, deck.url);
  session().simulateExternalReload();
  await expect(
    page.getByRole('banner').getByText('Reloaded (from Claude or the IDE)'),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Activity' }).click();
  await expect(
    page.getByRole('list', { name: 'Activity' }).getByText('Reloaded (from Claude or the IDE)'),
  ).toBeVisible();
});

test('connection loss: banner, then reconnect without a page reload and fill the gap', async ({
  page,
}) => {
  deck = await startScriptedDaemon();
  const watch = await watchPage(page);
  const sockets: { close: () => Promise<void> }[] = [];
  await page.routeWebSocket('**/ws', (ws) => {
    ws.connectToServer();
    sockets.push({ close: () => ws.close() });
  });
  await openDashboard(page, deck.url);
  let loads = 0;
  page.on('load', () => loads++);
  // Every socket for the next second is dropped, so the page shows the banner.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  let refuse = true;
  await page.routeWebSocket('**/ws', async (ws) => {
    if (refuse) await ws.close();
    else ws.connectToServer();
  });
  await Promise.all(sockets.map((s) => s.close()));
  await expect(
    page.getByRole('status').filter({ hasText: /Lost connection to FlutterDeck — retrying/ }),
  ).toBeVisible();
  push({ message: 'logged while disconnected' });
  refuse = false;
  await expect(page.getByRole('contentinfo')).toContainText('Connected', { timeout: 10_000 });
  await expect(page.getByText('logged while disconnected')).toBeVisible();
  await page.getByRole('tab', { name: 'Activity' }).click();
  await expect(page.getByText('Reconnected')).toBeVisible();
  expect(loads).toBe(0);
  expect(watch.cspViolations).toEqual([]);
});

test('long unbroken log lines wrap at 320 px', async ({ page }) => {
  deck = await startScriptedDaemon();
  await page.setViewportSize({ width: 320, height: 800 });
  await openDashboard(page, deck.url);
  push({ message: `token=${'x'.repeat(400)}` });
  push({
    message: Array.from({ length: 8 }, (_, i) => `#${i} frame at lib/main.dart:${i}`).join('\n'),
  });
  await expect(page.getByRole('button', { name: /^Show more: / })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectAccessible(page);
  await screenshot(page, 'long-lines-320');
});
