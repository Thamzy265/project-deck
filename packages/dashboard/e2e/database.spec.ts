/**
 * The M3 Database tab in a real browser (docs/ui/m3-database-tab.md): against the real
 * entry point in fake mode (`main.js --fake`, a real SQLite database in memory that
 * gains an order every 5 s), and the in-process daemon for states fake mode can't make.
 */
import { readFile } from 'node:fs/promises';
import type { DbInspector, DbInspectorFactory } from '@project-deck/core';
import { DbError } from '@project-deck/core';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { FakeLiveDatabase } from '../../db-sqlite/dist/testing/index.js';
import type { ScriptedDaemon, SpawnedDaemon } from './daemons.js';
import { spawnFakeDaemon, startScriptedDaemon } from './daemons.js';
import {
  expectAccessible,
  expectNoSidewaysScroll,
  openDashboard,
  screenshotM3,
  watchPage,
} from './helpers.js';

const WRITES_ON = { db: { allowWrites: true } };

async function openOrders(page: Page, url: string): Promise<void> {
  await openDashboard(page, url);
  await expect(page.getByRole('combobox', { name: 'Database' })).toHaveValue('app');
  const table = page.getByRole('combobox', { name: 'Table' });
  if (await table.isVisible()) await table.selectOption('orders');
  else
    await page
      .getByRole('navigation', { name: 'Tables' })
      .getByRole('button', { name: /orders/ })
      .click();
  await expect(page.getByRole('grid', { name: 'orders rows' })).toBeVisible();
}

const grid = (page: Page) => page.getByRole('grid', { name: 'orders rows' });

test.describe('fake mode', () => {
  let daemon: SpawnedDaemon;
  test.beforeEach(async () => {
    daemon = await spawnFakeDaemon({ config: WRITES_ON });
  });
  test.afterEach(async () => {
    await daemon.cleanup();
  });

  test('opens on the Database tab and browses, sorts and filters orders', async ({ page }) => {
    const watch = await watchPage(page);
    await openDashboard(page, daemon.url);
    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveText(['Database', 'Logs', 'Activity']);
    await expect(page.getByRole('tab', { name: 'Database' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByText('Writes on')).toBeVisible();
    await openOrders(page, daemon.url);
    await expect(grid(page).getByText('Coffee')).toBeVisible();
    await expect(page.getByText(/^1–\d+ of \d+$/)).toBeVisible();
    const item = grid(page).getByRole('columnheader', { name: /^item/ });
    await item.click();
    await expect(item).toHaveAttribute('aria-sort', 'ascending');
    await page.getByRole('searchbox', { name: 'Filter rows' }).fill('Tea');
    await expect(grid(page).getByText('Coffee')).toBeHidden();
    await expect(grid(page).getByText('Tea')).toBeVisible();
    await page.getByRole('searchbox', { name: 'Filter rows' }).fill('');
    await screenshotM3(page, 'browse-420');
    expect(watch.cspViolations).toEqual([]);
    expect(watch.consoleErrors).toEqual([]);
  });

  test('arrow keys move between cells; Enter opens row details; Escape returns', async ({
    page,
  }) => {
    await openOrders(page, daemon.url);
    await page.getByRole('searchbox', { name: 'Filter rows' }).fill('Coffee');
    await expect(grid(page).getByRole('row')).toHaveCount(2);
    const first = grid(page).getByRole('gridcell').first();
    await first.focus();
    await page.keyboard.press('ArrowRight');
    await expect(grid(page).getByRole('gridcell', { name: 'Coffee' })).toBeFocused();
    await page.keyboard.press('Enter');
    const details = page.getByRole('dialog', { name: 'orders: id 1' });
    await expect(details.getByText('pending')).toBeVisible();
    await screenshotM3(page, 'row-details-420');
    await page.keyboard.press('Escape');
    await expect(details).toBeHidden();
    await expect(grid(page).getByRole('gridcell', { name: 'Coffee' })).toBeFocused();
  });

  test('a foreign-key value opens the customer it points at', async ({ page }) => {
    await openOrders(page, daemon.url);
    await page.getByRole('searchbox', { name: 'Filter rows' }).fill('Coffee');
    await expect(grid(page).getByRole('row')).toHaveCount(2);
    await grid(page).getByRole('gridcell').nth(4).click();
    const customers = page.getByRole('grid', { name: 'customers rows' });
    await expect(customers.getByText('Ada Lovelace')).toBeVisible();
    await expect(customers.getByText('Grace Hopper')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Clear filter' })).toBeVisible();
  });

  test('a new order appears and flashes within a second of the change', async ({ page }) => {
    await openOrders(page, daemon.url);
    // The fake app adds "Order 3" about 5 s after it starts.
    const row = grid(page).getByRole('row').filter({ hasText: 'Order 3' });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row).toHaveClass(/deck-flash/);
    await expect(page.getByText('1 row added to orders')).toBeAttached();
  });

  test('with reduced motion the flash is an outline', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openOrders(page, daemon.url);
    const row = grid(page).getByRole('row').filter({ hasText: 'Order 3' });
    await expect(row).toBeVisible({ timeout: 10_000 });
    const outline = await row.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).toBe('solid');
  });

  test('Snapshot, then Diff shows what the app added, in symbols and words', async ({ page }) => {
    await openOrders(page, daemon.url);
    await page.getByRole('button', { name: 'Diff' }).click();
    await expect(page.getByText('Take a snapshot first, then use the app')).toBeVisible();
    await page.getByRole('button', { name: 'Table' }).click();
    await expect(grid(page).getByText('Coffee')).toBeVisible();
    // The fake app adds an order every 5 s: count the rows when the snapshot is taken.
    const rows = grid(page).getByRole('row');
    const before = await rows.count();
    await page.getByRole('button', { name: 'Snapshot' }).click();
    await expect(page.getByText(/^Snapshot \d\d:\d\d taken$/)).toBeVisible();
    const atSnapshot = await rows.count();
    expect(atSnapshot).toBeGreaterThanOrEqual(before);
    // Wait for the fake app's next order, then compare.
    await expect(rows).toHaveCount(atSnapshot + 1, { timeout: 10_000 });
    await page.getByRole('button', { name: 'Diff' }).click();
    const changes = page.getByRole('list', { name: 'Changes in orders' });
    await expect(changes.getByRole('listitem').first()).toContainText('+ added');
    await expect(page.getByText(/\d+ added, 0 changed, 0 removed/)).toBeVisible();
    await screenshotM3(page, 'diff-420');
  });

  test('edits ask first: Cancel runs nothing, Run change saves and the row flashes', async ({
    page,
  }) => {
    await openOrders(page, daemon.url);
    await page.getByRole('searchbox', { name: 'Filter rows' }).fill('Coffee');
    await grid(page).getByText('Coffee').click();
    const details = page.getByRole('dialog', { name: 'orders: id 1' });
    await details.getByRole('button', { name: 'Edit' }).click();
    await details.getByRole('textbox', { name: /^status/ }).fill('shipped');
    await details.getByRole('button', { name: 'Save' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Run this change?' });
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(
      dialog.getByText('UPDATE "orders" SET "status" = ? WHERE "id" IS ?'),
    ).toBeVisible();
    await screenshotM3(page, 'edit-confirm-420');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(details.getByText('shipped')).toBeHidden();
    await details.getByRole('button', { name: 'Save' }).click();
    await dialog.getByRole('button', { name: 'Run change' }).click();
    await expect(page.getByText('1 row changed', { exact: true })).toBeVisible();
    await expect(grid(page).getByRole('row').filter({ hasText: 'shipped' })).toBeVisible();
    await page.getByRole('tab', { name: 'Activity' }).click();
    await expect(page.getByText('Write denied: orders')).toBeVisible();
    await expect(page.getByText('Write allowed: orders, 1 row changed')).toBeVisible();
  });

  test('Add row in the toolbar fills an empty table, after the confirm', async ({ page }) => {
    await openDashboard(page, daemon.url);
    await page.getByRole('combobox', { name: 'Table' }).selectOption('audit_log');
    await expect(page.getByText('No rows yet')).toBeVisible();
    await page.getByRole('button', { name: 'Add row' }).click();
    const panel = page.getByRole('dialog', { name: 'audit_log: new row' });
    await panel.getByRole('textbox', { name: /^at/ }).fill('1');
    await panel.getByRole('textbox', { name: /^note/ }).fill('added by hand');
    await panel.getByRole('button', { name: 'Save' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Run this change?' });
    await expect(dialog).toContainText('Database: app');
    await expect(dialog).toContainText('Table: audit_log');
    await dialog.getByRole('button', { name: 'Run change' }).click();
    await expect(
      page.getByRole('grid', { name: 'audit_log rows' }).getByText('added by hand'),
    ).toBeVisible();
  });

  test('a table with a trigger says why it cannot be changed (QA G2)', async ({ page }) => {
    await openDashboard(page, daemon.url);
    await page.getByRole('combobox', { name: 'Table' }).selectOption('customers');
    const customers = page.getByRole('grid', { name: 'customers rows' });
    await customers.getByText('Ada Lovelace').click();
    const details = page.getByRole('dialog', { name: 'customers: id 1' });
    await details.getByRole('button', { name: 'Edit' }).click();
    await details.getByRole('textbox', { name: /^name/ }).fill('Ada King');
    await details.getByRole('button', { name: 'Save' }).click();
    await expect(details.getByRole('alert')).toContainText('A trigger counts as a second table');
    await expect(page.getByRole('alertdialog')).toBeHidden();
  });

  test('exports CSV with spreadsheet formulas defused, and JSON', async ({ page }) => {
    await openOrders(page, daemon.url);
    await page.getByRole('searchbox', { name: 'Filter rows' }).fill('Coffee');
    await grid(page).getByText('Coffee').click();
    const details = page.getByRole('dialog', { name: 'orders: id 1' });
    await details.getByRole('button', { name: 'Edit' }).click();
    await details.getByRole('textbox', { name: /^item/ }).fill('=HYPERLINK("http://x")');
    await details.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Run change' }).click();
    await details.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('searchbox', { name: 'Filter rows' }).fill('HYPERLINK');
    await expect(grid(page).getByRole('row')).toHaveCount(2);
    await page.getByRole('button', { name: 'Export' }).click();
    const [csv] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'CSV' }).click(),
    ]);
    expect(csv.suggestedFilename()).toBe('orders.csv');
    const text = await readFile(await csv.path(), 'utf8');
    expect(text.split('\r\n')[0]).toBe('"id","item","status","created","customer_id"');
    expect(text).toContain(`"'=HYPERLINK(""http://x"")"`);
    await page.getByRole('button', { name: 'Export' }).click();
    const [json] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'JSON' }).click(),
    ]);
    const parsed = JSON.parse(await readFile(await json.path(), 'utf8')) as { rows: unknown[][] };
    expect(parsed.rows[0]?.[1]).toBe('=HYPERLINK("http://x")');
  });

  test('SQL editor: Cmd/Ctrl+Enter runs, autocomplete knows the tables, Tab leaves', async ({
    page,
  }) => {
    const watch = await watchPage(page);
    await openDashboard(page, daemon.url);
    await page.getByRole('button', { name: 'SQL' }).click();
    const editor = page.getByRole('textbox', { name: 'SQL' });
    await editor.click();
    await page.keyboard.type('SELECT item FROM ord');
    await expect(page.getByRole('listbox').getByRole('option', { name: /orders/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await page.keyboard.type(' WHERE id = 1');
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.getByText(/^1 row in \d+ ms$/)).toBeVisible();
    await expect(
      page.getByRole('grid', { name: 'Query result' }).getByText('Coffee'),
    ).toBeVisible();
    await screenshotM3(page, 'sql-420');
    await editor.click();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeFocused();
    await editor.click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeFocused();
    expect(watch.cspViolations).toEqual([]);
    expect(watch.consoleErrors).toEqual([]);
  });

  test('SQL editor: writes are refused with the reason; errors mark their line', async ({
    page,
  }) => {
    await openDashboard(page, daemon.url);
    await page.getByRole('button', { name: 'SQL' }).click();
    const editor = page.getByRole('textbox', { name: 'SQL' });
    await editor.click();
    await page.keyboard.type('DELETE FROM orders');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(
      'Only reading queries run here. This one would change data (it deletes rows).',
    );
    await screenshotM3(page, 'sql-refused-420');
    await editor.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('SELECT *\nFROM orders\nWHER id = 1');
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.getByRole('alert')).toContainText('(line 3)');
    await expect(page.locator('.cm-deck-error')).toHaveCount(1);
    await page.getByRole('button', { name: 'Table' }).click();
    await expect(page.getByRole('combobox', { name: 'Table' })).toBeVisible();
  });

  test('saved queries: Cmd/Ctrl+S saves to the project and Run runs it again', async ({ page }) => {
    await openDashboard(page, daemon.url);
    await page.getByRole('button', { name: 'SQL' }).click();
    await page.getByRole('textbox', { name: 'SQL' }).click();
    await page.keyboard.type("SELECT * FROM orders WHERE status = 'shipped'");
    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('contentinfo')).toContainText('Connected');
    await page.getByRole('button', { name: 'More database options' }).click();
    // Named by its first 40 characters.
    const run = page.getByRole('button', {
      name: /^Run saved query: SELECT \* FROM orders WHERE status = 'shi…$/,
    });
    await expect(run).toBeVisible();
    await screenshotM3(page, 'saved-queries-420');
    await run.click();
    await expect(page.getByRole('grid', { name: 'Query result' }).getByText('Tea')).toBeVisible();
  });

  for (const width of [320, 420, 900]) {
    for (const scheme of ['light', 'dark'] as const) {
      test(`${width} px, ${scheme}: Database tab has no sideways scroll or serious axe issues`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.emulateMedia({ colorScheme: scheme });
        await openOrders(page, daemon.url);
        if (width >= 900) {
          await expect(page.getByRole('navigation', { name: 'Tables' })).toBeVisible();
        } else {
          await expect(page.getByRole('navigation', { name: 'Tables' })).toBeHidden();
        }
        if (width === 320) {
          await expect(grid(page).getByRole('columnheader')).toHaveCount(3);
          await expect(page.getByRole('combobox', { name: 'View' })).toBeVisible();
        }
        await expectNoSidewaysScroll(page);
        await expectAccessible(page);
        await screenshotM3(page, `table-${width}-${scheme}`);
        const views = ['Diagram', 'SQL', 'Diff'];
        for (const view of views) {
          if (width === 320) await page.getByRole('combobox', { name: 'View' }).selectOption(view);
          else await page.getByRole('button', { name: view }).click();
          await expectNoSidewaysScroll(page);
          await expectAccessible(page);
          await screenshotM3(page, `${view.toLowerCase()}-${width}-${scheme}`);
        }
      });
    }
  }
});

/** A snapshot backend that needs the user to pick a device first. */
class ChoosyInspector implements DbInspector {
  readonly id = 'sqlite-file';
  readonly live = false;
  readonly writable = false;
  chosen: string | undefined;
  constructor(private readonly inner: FakeLiveDatabase) {}
  listDatabases() {
    if (this.chosen === undefined) {
      return Promise.reject(
        new DbError(
          'choose-device',
          'More than one Android device could be running this app. Pick the one to copy from.',
          {
            devices: [
              { id: 'emulator-5554', name: 'emulator-5554' },
              { id: 'R58M123ABC', name: 'R58M123ABC' },
            ],
          },
        ),
      );
    }
    return Promise.resolve([{ name: 'app_flutter/app.sqlite', backend: 'snapshot' as const }]);
  }
  chooseDevice(id: string) {
    this.chosen = id;
    return Promise.resolve();
  }
  schema() {
    return this.inner.schema('app');
  }
  schemaSql() {
    return this.inner.schemaSql('app');
  }
  query(_db: string, sql: string, params?: unknown[], opts?: { limit?: number }) {
    return this.inner.query('app', sql, params, opts);
  }
}

const factory = (inspector: DbInspector): DbInspectorFactory => ({
  id: inspector.id,
  create: () => Promise.resolve(inspector),
});

test.describe('scripted daemon', () => {
  let deck: ScriptedDaemon | undefined;
  const live: FakeLiveDatabase[] = [];
  test.afterEach(async () => {
    await deck?.cleanup();
    deck = undefined;
    await Promise.all(live.splice(0).map((db) => db.close()));
  });

  test('no database: the setup card with the one-line snippet', async ({ page }) => {
    deck = await startScriptedDaemon();
    await openDashboard(page, deck.url);
    await expect(
      page.getByRole('heading', { name: 'Add flutterdeck_drift to see your database live.' }),
    ).toBeVisible();
    await expect(page.getByText("FlutterDeckDrift.register(db, name: 'app');")).toBeVisible();
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
    await screenshotM3(page, 'setup-420');
  });

  test('choose-device: the user picks the device and the snapshot opens', async ({ page }) => {
    const db = await FakeLiveDatabase.create('app', [
      'CREATE TABLE orders (id INTEGER PRIMARY KEY, item TEXT)',
      "INSERT INTO orders VALUES (1, 'Coffee')",
    ]);
    live.push(db);
    const choosy = new ChoosyInspector(db);
    deck = await startScriptedDaemon(undefined, { dbInspectors: [factory(choosy)] });
    await openDashboard(page, deck.url);
    await expect(page.getByText(/Pick the one to copy from/)).toBeVisible();
    await expectAccessible(page);
    await screenshotM3(page, 'device-picker-420');
    await page.getByRole('combobox', { name: 'Device' }).selectOption('R58M123ABC');
    await page.getByRole('button', { name: 'Use this device' }).click();
    await expect(page.getByRole('combobox', { name: 'Database' })).toHaveValue(
      'app_flutter/app.sqlite',
    );
    expect(choosy.chosen).toBe('R58M123ABC');
    await expect(page.getByRole('grid', { name: 'orders rows' }).getByText('Coffee')).toBeVisible();
  });

  test('untrusted row values stay text; bidi and control characters are named', async ({
    page,
  }) => {
    const db = await FakeLiveDatabase.create('app', [
      'CREATE TABLE orders (id INTEGER PRIMARY KEY, item TEXT)',
    ]);
    live.push(db);
    const payloads = [
      '<img src=x onerror="window.__pwned=1">',
      '<script>window.__pwned=1</script>',
      'javascript:window.__pwned=1',
      'user \u202Egnp.exe\u202C done',
      'bell\u0007',
      `long ${'y'.repeat(100_000)}`,
    ];
    for (const [i, item] of payloads.entries()) {
      await db.run('INSERT INTO orders VALUES (?, ?)', [i + 1, item]);
    }
    deck = await startScriptedDaemon(undefined, { dbInspectors: [factory(db)] });
    const watch = await watchPage(page);
    let dialogs = 0;
    page.on('dialog', (d) => {
      dialogs++;
      void d.dismiss();
    });
    await page.setViewportSize({ width: 320, height: 800 });
    await openDashboard(page, deck.url);
    const rows = page.getByRole('grid', { name: 'orders rows' });
    await expect(rows.getByText('U+202E')).toBeVisible();
    await expect(rows.getByText('U+0007')).toBeVisible();
    expect(await rows.locator('img, script, a, iframe').count()).toBe(0);
    await rows.getByText(/^<img/).click();
    await expect(page.getByRole('dialog', { name: 'orders: id 1' })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBe(
      undefined,
    );
    expect(dialogs).toBe(0);
    expect(watch.cspViolations).toEqual([]);
    await expectNoSidewaysScroll(page);
    await screenshotM3(page, 'abuse-320');
  });
});
