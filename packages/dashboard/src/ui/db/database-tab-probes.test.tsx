/**
 * Tester probes of the Database tab: states-matrix cells the developer's tests leave out
 * (docs/ui/m3-database-tab.md) and untrusted names in accessible text (design note,
 * abuse cases). Each test names its row and column where it covers one.
 */
import type { Cell, DbList, QueryResult, TableInfo } from '@project-deck/core';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbApiError } from '../../api/db-client.js';
import type { FakeDbClient, FakeDbData } from '../../testing/db-fake.js';
import { fakeDbClient, fakeDbData, ordersInfo } from '../../testing/db-fake.js';
import { fakeDaemon, renderDashboard } from '../../testing/harness.js';

const never = <T,>() => new Promise<T>(() => undefined);

async function open(db: FakeDbClient = fakeDbClient()) {
  const t = renderDashboard(fakeDaemon(), undefined, undefined, { tab: 'database', db });
  await t.connect();
  return { ...t, user: userEvent.setup() };
}

async function ordersGrid(data: FakeDbData = fakeDbData()) {
  const t = await open(fakeDbClient(data));
  await t.user.selectOptions(await screen.findByRole('combobox', { name: 'Table' }), 'orders');
  await screen.findByRole('grid', { name: 'orders rows' });
  return t;
}

const grid = () => screen.getByRole('grid', { name: 'orders rows' });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Table picker / sidebar (states matrix)', () => {
  it('Error: "Couldn\'t read the schema" + Retry, which reads it again', async () => {
    const db = fakeDbClient();
    db.schema.mockRejectedValueOnce(new DbApiError('timeout', 'slow'));
    const t = await open(db);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't read the schema");
    await t.user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('combobox', { name: 'Table' })).toBeVisible();
    expect(db.schema).toHaveBeenCalledTimes(2);
  });

  it('Empty: "No tables in this database"', async () => {
    await open(fakeDbClient(fakeDbData({ tables: [], rows: {} })));
    expect(await screen.findByText('No tables in this database')).toBeVisible();
  });
});

describe('Schema diagram (states matrix)', () => {
  it('Loading: "Drawing…"', async () => {
    const db = fakeDbClient();
    db.schema.mockReturnValue(never());
    const t = await open(db);
    await t.user.click(await screen.findByRole('button', { name: 'Diagram' }));
    expect(await screen.findByText('Drawing…')).toBeVisible();
  });

  it('Empty: "No tables"', async () => {
    const t = await open(fakeDbClient(fakeDbData({ tables: [], rows: {} })));
    await t.user.click(await screen.findByRole('button', { name: 'Diagram' }));
    expect(await screen.findByText('No tables')).toBeVisible();
  });
});

describe('Row details panel (states matrix)', () => {
  it('Loading: "Loading row…" while the row is read again', async () => {
    const t = await ordersGrid();
    t.db.query.mockReturnValue(never<QueryResult>());
    await t.user.click(within(grid()).getByText('Coffee'));
    const panel = await screen.findByRole('dialog', { name: 'orders: id 1' });
    expect(await within(panel).findByText('Loading row…')).toBeVisible();
  });

  it('Error: "Couldn\'t read this row: <reason>. Retry"', async () => {
    const t = await ordersGrid();
    t.db.query.mockRejectedValue(new DbApiError('timeout', 'That query took too long.'));
    await t.user.click(within(grid()).getByText('Coffee'));
    const panel = await screen.findByRole('dialog', { name: 'orders: id 1' });
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      "Couldn't read this row: That query took too long.",
    );
    expect(within(panel).getByRole('button', { name: 'Retry' })).toBeVisible();
  });
});

describe('Snapshot and diff (states matrix)', () => {
  it('Snapshot button, Loading: "Taking snapshot…"', async () => {
    const db = fakeDbClient();
    db.snapshot.mockReturnValue(never());
    const t = await open(db);
    await t.user.click(await screen.findByRole('button', { name: 'Snapshot' }));
    expect(await screen.findByText('Taking snapshot…')).toBeVisible();
  });

  it('Diff view, Loading: "Comparing…"', async () => {
    const db = fakeDbClient();
    const t = await open(db);
    await t.user.click(await screen.findByRole('button', { name: 'Snapshot' }));
    await screen.findByText('Snapshot 14:02 taken');
    db.diff.mockReturnValue(never());
    await t.user.click(screen.getByRole('button', { name: 'Diff' }));
    expect(await screen.findByText('Comparing…')).toBeVisible();
  });
});

describe('SQL editor (states matrix)', () => {
  it('Long content: "Showing the first 1,000 rows" when the result is capped', async () => {
    const data = fakeDbData({ saved: [{ name: 'All', sql: 'SELECT * FROM "orders"' }] });
    const db = fakeDbClient(data);
    const t = await open(db);
    db.query.mockResolvedValue({
      columns: ['id'],
      rows: Array.from({ length: 1000 }, (_, i) => [i]),
      truncated: true,
      durationMs: 3,
    });
    await t.user.click(screen.getByRole('button', { name: 'More database options' }));
    await t.user.click(screen.getByRole('button', { name: 'Run saved query: All' }));
    expect(await screen.findByText(/Showing the first 1,000 rows/)).toBeVisible();
  });
});

describe('Export menu (states matrix)', () => {
  it('Disabled: no rows', async () => {
    const data = fakeDbData();
    data.rows.orders = [];
    const t = await open(fakeDbClient(data));
    await t.user.selectOptions(await screen.findByRole('combobox', { name: 'Table' }), 'orders');
    await screen.findByText('No rows yet');
    const exp = screen.queryByRole('button', { name: /^Export/ });
    // Either hidden with the grid or present and disabled; never usable.
    if (exp !== null) expect(exp).toHaveAttribute('aria-disabled', 'true');
  });

  it('Error: "Export failed" when a page read fails mid-export', async () => {
    const t = await ordersGrid();
    t.db.query.mockRejectedValue(new DbApiError('timeout', 'slow'));
    await t.user.click(screen.getByRole('button', { name: /^Export/ }));
    await t.user.click(screen.getByRole('button', { name: 'CSV' }));
    expect(await screen.findByText('Export failed')).toBeVisible();
  });

  it('Long content: a table past 100,000 rows exports the first 100,000 and says so', async () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const t = await ordersGrid();
    const page: Cell[][] = Array.from({ length: 1000 }, (_, i) => [i, 'x', 'pending', 1]);
    t.db.query.mockImplementation((input) =>
      Promise.resolve(
        input.sql.startsWith('SELECT count(*)')
          ? { columns: ['count(*)'], rows: [[250_000]], truncated: false, durationMs: 1 }
          : {
              columns: ['id', 'item', 'status', 'customer_id'],
              rows: page,
              truncated: false,
              durationMs: 1,
            },
      ),
    );
    // A change makes the grid read the new count first.
    await t.send({ type: 'db.changed', payload: { source: 'drift', db: 'app', table: 'orders' } });
    await screen.findByText(/of 250,000/);
    const before = t.db.query.mock.calls.length;
    await t.user.click(screen.getByRole('button', { name: /^Export/ }));
    await t.user.click(screen.getByRole('button', { name: 'CSV' }));
    expect(
      await screen.findByText('Exported the first 100,000 rows', {}, { timeout: 10_000 }),
    ).toBeVisible();
    // 1,000 rows per call: exactly 100 page reads, none past the cap.
    expect(t.db.query.mock.calls.length - before).toBe(100);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  }, 20_000);
});

describe('untrusted names in announcements and accessible names (abuse cases)', () => {
  const bidiName = 'ord‮ers';
  function bidiData(): FakeDbData {
    const table: TableInfo = { ...ordersInfo, name: bidiName, foreignKeys: [] };
    return fakeDbData({
      tables: [table],
      rows: { [bidiName]: [[1, 'Coffee', 'pending', 1]] },
    });
  }

  it.fails(
    'the polite "rows added" announcement names a bidi override instead of acting on it',
    async () => {
      const data = bidiData();
      const t = await open(fakeDbClient(data));
      const picker = await screen.findByRole('combobox', { name: 'Table' });
      await t.user.selectOptions(picker, bidiName);
      await screen.findByText('Coffee');
      data.rows[bidiName] = [...(data.rows[bidiName] ?? []), [2, 'Tea', 'pending', 1]];
      await t.send({
        type: 'db.changed',
        payload: { source: 'drift', db: 'app', table: bidiName },
      });
      await screen.findByText('Tea');
      const live = document.querySelector('[aria-live="polite"]');
      await waitFor(() => expect(live?.textContent).toMatch(/1 row added to/));
      expect(live?.textContent).not.toContain('‮');
      expect(live?.textContent).toContain('U+202E');
    },
  );

  it.fails('accessible names built from a table name show a bidi override as a mark', async () => {
    const data = bidiData();
    const db = fakeDbClient(data);
    const t = await open(db);
    await t.user.selectOptions(await screen.findByRole('combobox', { name: 'Table' }), bidiName);
    const names = [...document.querySelectorAll('[aria-label]')].map(
      (el) => el.getAttribute('aria-label') ?? '',
    );
    for (const name of names) expect(name, name).not.toContain('‮');
  });
});

describe('write confirm dialog: what runs where', () => {
  it.fails(
    'names the database the change runs in, so two databases with one table name differ',
    async () => {
      const list: DbList = {
        databases: [
          { name: 'app', backend: 'live', source: 'drift' },
          { name: 'cache', backend: 'live', source: 'drift' },
        ],
        sources: [{ id: 'drift', live: true, writable: true }],
        writesAllowed: true,
      };
      const data = fakeDbData({ list });
      const t = await open(fakeDbClient(data));
      await t.user.selectOptions(
        await screen.findByRole('combobox', { name: 'Database' }),
        'cache',
      );
      await t.user.selectOptions(await screen.findByRole('combobox', { name: 'Table' }), 'orders');
      await screen.findByRole('grid', { name: 'orders rows' });
      await t.user.click(within(grid()).getByText('Coffee'));
      const panel = await screen.findByRole('dialog', { name: 'orders: id 1' });
      await within(panel).findByText('pending');
      await t.user.click(within(panel).getByRole('button', { name: 'Delete row' }));
      const dialog = await screen.findByRole('alertdialog', { name: 'Run this change?' });
      expect(t.db.requestEdit).toHaveBeenLastCalledWith(expect.objectContaining({ db: 'cache' }));
      expect(dialog).toHaveTextContent('cache');
    },
  );
});

describe('live refresh (states matrix: Success, Offline)', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('a flood of change events ends on the latest rows and announces the batch once', async () => {
    const data = fakeDbData();
    const t = await ordersGrid(data);
    data.rows.orders = [
      ...(data.rows.orders ?? []),
      [3, 'Cake', 'pending', 1],
      [4, 'Pie', 'pending', 1],
      [5, 'Bun', 'pending', 1],
    ];
    for (let i = 0; i < 20; i++) {
      await t.send({
        type: 'db.changed',
        payload: { source: 'drift', db: 'app', table: 'orders' },
      });
    }
    expect(await within(grid()).findByText('Bun')).toBeVisible();
    const live = document.querySelector('[aria-live="polite"]');
    await waitFor(() => expect(live?.textContent).toBe('3 rows added to orders'));
    expect(screen.getByText('1–5 of 5')).toBeVisible();
  });

  it('Offline: keeps the rows; on reconnect the open table reads again without an event', async () => {
    const data = fakeDbData();
    const t = await ordersGrid(data);
    await t.drop();
    expect(await screen.findByText(/Lost connection/)).toBeInTheDocument();
    expect(within(grid()).getByText('Coffee')).toBeVisible();
    // Changes made while the socket was down send no event the dashboard can see.
    data.rows.orders = [...(data.rows.orders ?? []), [3, 'Cake', 'pending', 1]];
    await wait(600);
    await t.connect();
    expect(await within(grid()).findByText('Cake')).toBeVisible();
  });

  it('a table dropped while open says it could not be read, without a crash', async () => {
    const data = fakeDbData();
    const t = await ordersGrid(data);
    data.tables = data.tables.filter((x) => x.name !== 'orders');
    delete data.rows.orders;
    await t.send({ type: 'db.changed', payload: { source: 'drift', db: 'app', table: 'orders' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't read rows: no such table: orders",
    );
    expect(screen.getByRole('tab', { name: 'Database' })).toBeVisible();
  });
});
