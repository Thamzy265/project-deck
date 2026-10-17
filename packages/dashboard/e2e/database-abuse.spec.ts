/**
 * Tester probes of the Database tab in a real browser, against the in-process daemon with
 * a real SQLite database (FakeLiveDatabase): hostile table, column and saved-query names
 * (design note, abuse cases) and edits whose key matches more than the row shown
 * (UI spec, write confirm: "no write happens without a visible confirm").
 */
import { readFile } from 'node:fs/promises';
import type { DbInspector, DbInspectorFactory } from '@project-deck/core';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { FakeLiveDatabase } from '../../db-sqlite/dist/testing/index.js';
import type { ScriptedDaemon } from './daemons.js';
import { startScriptedDaemon } from './daemons.js';
import { openDashboard, watchPage } from './helpers.js';

const WRITES_ON = { db: { allowWrites: true } };

const factory = (inspector: DbInspector): DbInspectorFactory => ({
  id: inspector.id,
  create: () => Promise.resolve(inspector),
});

let deck: ScriptedDaemon | undefined;
const live: FakeLiveDatabase[] = [];
test.afterEach(async () => {
  await deck?.cleanup();
  deck = undefined;
  await Promise.all(live.splice(0).map((db) => db.close()));
});

async function start(setup: string[], config?: Record<string, unknown>) {
  const db = await FakeLiveDatabase.create('app', setup);
  live.push(db);
  deck = await startScriptedDaemon(undefined, {
    dbInspectors: [factory(db)],
    ...(config === undefined ? {} : { config }),
  });
  return { db, url: deck.url };
}

const pwned = (page: Page) =>
  page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned);

const HOSTILE_TABLE = '<img src=x onerror="window.__pwned=1">‮txt';
const HOSTILE_COLUMN = '<svg onload="window.__pwned=1">';
const q = (name: string) => `"${name.replaceAll('"', '""')}"`;

test('hostile table and column names stay text in every view, title and export name', async ({
  page,
}) => {
  const { url } = await start([
    `CREATE TABLE ${q(HOSTILE_TABLE)} (id INTEGER PRIMARY KEY, ${q(HOSTILE_COLUMN)} TEXT, link TEXT)`,
    `INSERT INTO ${q(HOSTILE_TABLE)} VALUES (1, '=cmd|'' /C calc''!A0', 'javascript:window.__pwned=1')`,
    `CREATE TABLE child (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES ${q(HOSTILE_TABLE)}(id))`,
    'INSERT INTO child VALUES (1, 1)',
  ]);
  const watch = await watchPage(page);
  let dialogs = 0;
  page.on('dialog', (d) => {
    dialogs++;
    void d.dismiss();
  });
  await openDashboard(page, url);
  const title = await page.title();
  await page.getByRole('combobox', { name: 'Table' }).selectOption(HOSTILE_TABLE);
  await expect(page.getByRole('combobox', { name: 'Table' })).toContainText('<U+202E>txt');
  const grid = page.getByRole('grid').first();
  await expect(grid.getByText(HOSTILE_COLUMN)).toBeVisible();
  await grid.getByText('javascript:window.__pwned=1').click();
  const details = page.getByRole('dialog');
  await expect(details).toBeVisible();
  expect(await details.locator('a[href]').count()).toBe(0);
  await details.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: /^Export/ }).click();
  const [csv] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'CSV' }).click(),
  ]);
  expect(csv.suggestedFilename()).toMatch(/^[A-Za-z0-9._-]+\.csv$/);
  expect(csv.suggestedFilename()).not.toContain('‮');
  const text = await readFile(await csv.path(), 'utf8');
  expect(text).toContain(`"'=cmd|' /C calc'!A0"`);

  for (const view of ['Diagram', 'SQL', 'Diff']) {
    await page.getByRole('button', { name: view }).click();
    await expect(page.getByRole('tabpanel')).toBeVisible();
  }
  await page.getByRole('button', { name: 'Diagram' }).click();
  await expect(page.getByRole('button', { name: /<U\+202E>txt table/ })).toBeVisible();

  const injected = await page.evaluate(
    () => document.querySelectorAll('main img, main svg[onload], main script, main iframe').length,
  );
  expect(injected).toBe(0);
  expect(await pwned(page)).toBeUndefined();
  expect(dialogs).toBe(0);
  expect(await page.title()).toBe(title);
  expect(watch.cspViolations).toEqual([]);
});

test('hostile saved query names and SQLite messages stay text', async ({ page }) => {
  const { url } = await start(['CREATE TABLE orders (id INTEGER PRIMARY KEY, item TEXT)']);
  const watch = await watchPage(page);
  await openDashboard(page, url);
  const put = await page.evaluate(async () => {
    const res = await fetch('/api/db/queries', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        queries: [
          {
            name: '<img src=x onerror="window.__pwned=1">‮gnp.exe',
            sql: 'SELECT * FROM "<img src=x onerror=window.__pwned=1>"',
          },
        ],
      }),
    });
    return res.status;
  });
  expect(put).toBe(200);
  await page.reload();
  await expect(page.getByRole('contentinfo')).toContainText('Connected');
  await page.getByRole('button', { name: 'More database options' }).click();
  await expect(page.getByText('U+202E').first()).toBeVisible();
  await page.getByRole('button', { name: /^Run saved query:/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'no such table' })).toContainText(
    '<img src=x onerror=window.__pwned=1>',
  );
  expect(await page.locator('main img').count()).toBe(0);
  expect(await pwned(page)).toBeUndefined();
  expect(watch.cspViolations).toEqual([]);
});

/** Deletes the first row of `table` through row details and the confirm, if it is offered. */
async function deleteFirstRow(page: Page, url: string, table: string): Promise<void> {
  await openDashboard(page, url);
  await page.getByRole('combobox', { name: 'Table' }).selectOption(table);
  const grid = page.getByRole('grid', { name: `${table} rows` });
  await grid.getByRole('row').nth(1).getByRole('gridcell').last().click();
  const details = page.getByRole('dialog');
  const del = details.getByRole('button', { name: 'Delete row' });
  await expect(del).toBeVisible();
  if ((await del.getAttribute('aria-disabled')) === 'true') return;
  await del.click();
  const confirm = page.getByRole('alertdialog', { name: 'Run this change?' });
  await confirm.getByRole('button', { name: 'Run change' }).click();
  await expect(confirm).toBeHidden();
}

test('Delete row on a NULL key deletes that row only, not every NULL-key row', async ({ page }) => {
  // SQLite lets a non-INTEGER primary key of a rowid table hold NULL more than once.
  const { db, url } = await start(
    [
      'CREATE TABLE codes (code TEXT PRIMARY KEY, v TEXT)',
      "INSERT INTO codes VALUES (NULL, 'first'), (NULL, 'second'), ('x', 'third')",
    ],
    WRITES_ON,
  );
  await deleteFirstRow(page, url, 'codes');
  const left = await db.query('app', 'SELECT count(*) FROM codes');
  expect(left.rows[0]?.[0]).toBeGreaterThanOrEqual(2);
});

test.fail(
  'Delete row on a big integer key deletes that row, not a text row with the same digits',
  async ({ page }) => {
    const { db, url } = await start(
      [
        'CREATE TABLE ids (k PRIMARY KEY, v TEXT) WITHOUT ROWID',
        "INSERT INTO ids VALUES (9007199254740993, 'int'), ('9007199254740993', 'text')",
      ],
      WRITES_ON,
    );
    // Sorted by key, the integer comes first (integers sort before text in SQLite).
    await deleteFirstRow(page, url, 'ids');
    const left = await db.query('app', 'SELECT v FROM ids ORDER BY v');
    expect(left.rows.map((r) => r[0])).toContain('text');
  },
);
