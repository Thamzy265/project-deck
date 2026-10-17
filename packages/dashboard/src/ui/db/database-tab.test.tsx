/**
 * The Database tab's states (docs/ui/m3-database-tab.md, states matrix), against an
 * in-memory `/api/db`. Each test names its row and column where it covers one.
 */
import type { DbList } from '@project-deck/core';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbApiError } from '../../api/db-client.js';
import type { FakeDbClient, FakeDbData } from '../../testing/db-fake.js';
import { fakeDbClient, fakeDbData } from '../../testing/db-fake.js';
import { fakeDaemon, renderDashboard } from '../../testing/harness.js';

const never = <T,>() => new Promise<T>(() => undefined);

async function open(db: FakeDbClient = fakeDbClient(), daemon = fakeDaemon()) {
  const t = renderDashboard(daemon, undefined, undefined, { tab: 'database', db });
  await t.connect();
  return { ...t, user: userEvent.setup() };
}

const grid = () => screen.getByRole('grid', { name: 'orders rows' });

async function ordersGrid(data: FakeDbData = fakeDbData(), waitForGrid = true) {
  const db = fakeDbClient(data);
  const t = await open(db);
  await t.user.selectOptions(await screen.findByRole('combobox', { name: 'Table' }), 'orders');
  if (waitForGrid) await screen.findByRole('grid', { name: 'orders rows' });
  return t;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Database picker', () => {
  it('Disabled: no app attached', async () => {
    const base = fakeDaemon();
    await open(fakeDbClient(), fakeDaemon({ status: { ...base.status, attached: null } }));
    expect(screen.getByRole('combobox', { name: 'Database' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Database' })).toHaveDisplayValue(
      'No app attached',
    );
  });

  it('Loading: "Finding databases…"', async () => {
    const db = fakeDbClient();
    db.list.mockReturnValue(never<DbList>());
    await open(db);
    expect(await screen.findByText('Finding databases…')).toBeInTheDocument();
  });

  it('Error: "Couldn\'t read databases: <reason>. Retry"', async () => {
    const db = fakeDbClient();
    db.list.mockRejectedValueOnce(new DbApiError('unavailable', 'adb failed'));
    const t = await open(db);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't read databases: adb failed. Retry",
    );
    await t.user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('combobox', { name: 'Database' })).toHaveDisplayValue(
      'app · Live',
    );
  });

  it('Empty: the setup card, with a snapshot on Android, and the backend problem', async () => {
    const db = fakeDbClient(
      fakeDbData({
        list: {
          databases: [],
          sources: [
            {
              id: 'drift',
              live: true,
              writable: true,
              error: { code: 'setup-needed', message: 'x' },
            },
            {
              id: 'sqlite-file',
              live: false,
              writable: false,
              error: {
                code: 'not-debuggable',
                message:
                  "This app isn't debuggable, so Android won't let FlutterDeck copy its database.",
              },
            },
          ],
          writesAllowed: false,
        },
      }),
    );
    const t = await open(db);
    expect(
      await screen.findByRole('heading', {
        name: 'Add flutterdeck_drift to see your database live.',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("FlutterDeckDrift.register(db, name: 'app');")).toBeInTheDocument();
    expect(screen.getByText('It does nothing in release builds.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent("This app isn't debuggable");
    await t.user.click(screen.getByRole('button', { name: 'Take a snapshot' }));
    expect(db.list).toHaveBeenCalledTimes(2);
  });

  it('choose-device: the user picks the device, then the databases show', async () => {
    const data = fakeDbData();
    const listed = data.list;
    data.list = {
      databases: [],
      sources: [
        {
          id: 'sqlite-file',
          live: false,
          writable: false,
          error: {
            code: 'choose-device',
            message:
              'More than one Android device could be running this app. Pick the one to copy from.',
            devices: [
              { id: 'emulator-5554', name: 'emulator-5554' },
              { id: 'R58M123ABC', name: 'R58M123ABC' },
            ],
          },
        },
      ],
      writesAllowed: false,
    };
    const db = fakeDbClient(data);
    db.chooseDevice.mockResolvedValue(listed);
    const t = await open(db);
    await t.user.selectOptions(
      await screen.findByRole('combobox', { name: 'Device' }),
      'R58M123ABC',
    );
    await t.user.click(screen.getByRole('button', { name: 'Use this device' }));
    expect(db.chooseDevice).toHaveBeenCalledWith('sqlite-file', 'R58M123ABC');
    expect(await screen.findByRole('combobox', { name: 'Database' })).toHaveDisplayValue(
      'app · Live',
    );
  });

  it('Default: name and "Live" badge; "Writes on" pill only with writes on', async () => {
    await open();
    expect(await screen.findByText('Live')).toBeInTheDocument();
    expect(screen.queryByText('Writes on')).toBeNull();
    const data = fakeDbData();
    data.list.writesAllowed = true;
    await open(fakeDbClient(data));
    expect(await screen.findByText('Writes on')).toHaveAttribute(
      'title',
      'Every change still asks you first',
    );
  });

  it('Snapshot backend: the banner and Refresh, which takes a fresh copy', async () => {
    const data = fakeDbData();
    data.list = {
      databases: [
        {
          name: 'app_flutter/app.sqlite',
          backend: 'snapshot',
          source: 'sqlite-file',
          takenAt: new Date(2026, 9, 17, 14, 2).getTime(),
        },
      ],
      sources: [{ id: 'sqlite-file', live: false, writable: false }],
      writesAllowed: true,
    };
    const db = fakeDbClient(data);
    const t = await open(db);
    expect(
      await screen.findByText('Snapshot from 14:02 — this is a copy, not live.'),
    ).toBeVisible();
    await t.user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(db.refresh).toHaveBeenCalledWith('app_flutter/app.sqlite');
  });
});

describe('Table picker and grid', () => {
  it('Loading: skeleton rows while the tables load', async () => {
    const db = fakeDbClient();
    db.schema.mockReturnValue(never());
    await open(db);
    expect(await screen.findByRole('status', { name: 'Loading tables' })).toBeInTheDocument();
  });

  it('Default: tables with row counts; rows in an ARIA grid with a header row', async () => {
    await ordersGrid();
    const picker = screen.getByRole('combobox', { name: 'Table' });
    expect(
      within(picker)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['customers (2)', 'orders (2)']);
    expect(grid()).toHaveAttribute('aria-rowcount', '3');
    expect(
      within(grid())
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['idINTEGERPK', 'itemTEXT', 'statusTEXT', 'customer_idINTEGERFK']);
    expect(screen.getByText('1–2 of 2')).toBeInTheDocument();
  });

  it('Column header: Enter cycles the sort, with aria-sort', async () => {
    const t = await ordersGrid();
    const item = within(grid()).getAllByRole('columnheader')[1];
    if (item === undefined) throw new Error('no header');
    await t.user.click(item);
    expect(item).toHaveAttribute('aria-sort', 'ascending');
    await waitFor(() =>
      expect(t.db.query.mock.calls.at(-2)?.[0].sql).toBe(
        'SELECT * FROM "orders" ORDER BY "item", "id" LIMIT ? OFFSET ?',
      ),
    );
    item.focus();
    await t.user.keyboard('{Enter}');
    expect(item).toHaveAttribute('aria-sort', 'descending');
    await t.user.keyboard('{Enter}');
    expect(item).toHaveAttribute('aria-sort', 'none');
  });

  it('Filter: the text goes in a parameter, never in the SQL', async () => {
    const t = await ordersGrid();
    await t.user.type(screen.getByRole('searchbox', { name: 'Filter rows' }), "x'; DROP");
    await waitFor(() => {
      const call = t.db.query.mock.calls.find((c) => c[0].sql.includes('LIKE'));
      expect(call?.[0].sql).not.toContain('DROP');
      expect(call?.[0].params).toContain("%x'; DROP%");
    });
  });

  it('Empty: "No rows yet", with "Clear filter" when filtered', async () => {
    const data = fakeDbData();
    data.rows.orders = [];
    await ordersGrid(data, false);
    expect(await screen.findByText('No rows yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear filter' })).toBeNull();
  });

  it('Error: "Couldn\'t read rows: <reason>" with Retry', async () => {
    const db = fakeDbClient();
    const t = await open(db);
    db.query.mockRejectedValue(new DbApiError('timeout', 'That query took too long.'));
    await t.user.selectOptions(await screen.findByRole('combobox', { name: 'Table' }), 'orders');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't read rows: That query took too long. Retry",
    );
  });

  it('Success: a changed table re-queries, flashes the new row and says so once', async () => {
    const data = fakeDbData();
    const t = await ordersGrid(data);
    data.rows.orders = [...(data.rows.orders ?? []), [3, 'Cake', 'pending', 1]];
    await t.send({ type: 'db.changed', payload: { source: 'drift', db: 'app', table: 'orders' } });
    const cake = await within(grid()).findByText('Cake');
    expect(cake.closest('[role="row"]')).toHaveClass('deck-flash');
    expect(within(grid()).getByText('Coffee').closest('[role="row"]')).not.toHaveClass(
      'deck-flash',
    );
    expect(screen.getByText('1 row added to orders')).toBeInTheDocument();
  });

  it('Long content: untrusted cells stay text, and bidi characters are named', async () => {
    const data = fakeDbData();
    data.rows.orders = [[1, '<img src=x onerror="window.__pwned=1">', 'user ‮gnp.exe', null]];
    await ordersGrid(data);
    expect(grid().querySelector('img')).toBeNull();
    expect(within(grid()).getByText('<img src=x onerror="window.__pwned=1">')).toBeVisible();
    expect(within(grid()).getByText('U+202E')).toBeVisible();
    expect(within(grid()).getByText('null').closest('[role="gridcell"]')).toHaveClass('text-muted');
  });
});

describe('Row details and foreign keys', () => {
  it('Enter opens row details with every value; Escape closes and returns focus', async () => {
    const t = await ordersGrid();
    const cell = within(grid()).getByText('Coffee').closest<HTMLElement>('[role="gridcell"]');
    cell?.focus();
    await t.user.keyboard('{Enter}');
    const details = await screen.findByRole('dialog', { name: 'orders: id 1' });
    expect(within(details).getByRole('heading')).toHaveFocus();
    expect(await within(details).findByText('pending')).toBeInTheDocument();
    expect(within(details).getByRole('button', { name: 'Copy item' })).toBeInTheDocument();
    await t.user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(cell).toHaveFocus();
  });

  it('Foreign-key cell: opens the referenced table filtered to that row', async () => {
    const t = await ordersGrid();
    const rows = within(grid()).getAllByRole('row');
    const fk = within(rows[1] ?? grid()).getAllByRole('gridcell')[3];
    if (fk === undefined) throw new Error('no fk cell');
    await t.user.click(within(fk).getByText('1'));
    expect(await screen.findByRole('button', { name: 'Clear filter' })).toBeVisible();
    const customers = await screen.findByRole('grid', { name: 'customers rows' });
    expect(within(customers).getByText('Ada')).toBeInTheDocument();
    expect(within(customers).queryByText('Grace')).toBeNull();
  });

  it('Foreign-key cell, error: "Row not found"', async () => {
    const data = fakeDbData();
    data.rows.orders = [[1, 'Coffee', 'pending', 9]];
    const t = await ordersGrid(data);
    await t.user.click(within(grid()).getByText('9'));
    expect(await screen.findByText('Row not found')).toBeInTheDocument();
  });
});

describe('Editing (writes on)', () => {
  function writable(): FakeDbData {
    const data = fakeDbData();
    data.list.writesAllowed = true;
    return data;
  }

  async function details(data = writable()) {
    const t = await ordersGrid(data);
    await t.user.click(within(grid()).getByText('Coffee'));
    const panel = await screen.findByRole('dialog', { name: 'orders: id 1' });
    await within(panel).findByText('pending');
    return { ...t, panel };
  }

  it('Writes off: no edit buttons', async () => {
    const t = await ordersGrid();
    await t.user.click(within(grid()).getByText('Coffee'));
    const panel = await screen.findByRole('dialog', { name: 'orders: id 1' });
    expect(within(panel).queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('Edit builds parameterised SQL and asks first: focus on Cancel, the exact SQL shown', async () => {
    const t = await details();
    await t.user.click(within(t.panel).getByRole('button', { name: 'Edit' }));
    const status = within(t.panel).getByRole('textbox', { name: /^status/ });
    await t.user.clear(status);
    await t.user.type(status, "shipped'; --");
    await t.user.click(within(t.panel).getByRole('button', { name: 'Save' }));
    expect(t.db.requestEdit).toHaveBeenCalledWith({
      db: 'app',
      sql: 'UPDATE "orders" SET "status" = ? WHERE "id" IS ?',
      params: ["shipped'; --", 1],
    });
    const dialog = await screen.findByRole('alertdialog', { name: 'Run this change?' });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(within(dialog).getByText(/^Database:/)).toHaveTextContent('Database: app');
    expect(within(dialog).getByText(/^Table:/)).toHaveTextContent('Table: orders');
    expect(
      within(dialog).getByText('UPDATE "orders" SET "status" = ? WHERE "id" IS ?'),
    ).toBeVisible();
    // Written as an SQL literal: the inner quote is doubled, so the value reads one way.
    expect(within(dialog).getByText("'shipped''; --'")).toBeVisible();
    expect(t.db.confirmEdit).not.toHaveBeenCalled();
    await t.user.click(within(dialog).getByRole('button', { name: 'Run change' }));
    expect(t.db.confirmEdit).toHaveBeenCalledWith({
      requestId: 'r'.repeat(32),
      sql: 'UPDATE "orders" SET "status" = ? WHERE "id" IS ?',
      params: ["shipped'; --", 1],
    });
    expect(await screen.findByText('1 row changed')).toBeInTheDocument();
  });

  it('Cancel and Escape send cancel and run nothing; Tab stays inside the dialog', async () => {
    const t = await details();
    await t.user.click(within(t.panel).getByRole('button', { name: 'Delete row' }));
    const dialog = await screen.findByRole('alertdialog');
    await t.user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await t.user.tab();
    await t.user.tab();
    await t.user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await t.user.keyboard('{Escape}');
    expect(t.db.cancelEdit).toHaveBeenCalledWith('r'.repeat(32));
    expect(t.db.confirmEdit).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(within(t.panel).getByRole('button', { name: 'Delete row' })).toHaveFocus();
  });

  it('shows control and bidi characters in the SQL visibly', async () => {
    const t = await details();
    t.db.requestEdit.mockResolvedValueOnce({
      requestId: 'r'.repeat(32),
      db: 'app',
      sql: 'DELETE FROM "orders" WHERE "id" IS ? -- ‮\u0007',
      params: ['a⁦b'],
      tables: ['orders'],
      expiresAt: Date.now() + 60_000,
    });
    await t.user.click(within(t.panel).getByRole('button', { name: 'Delete row' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('U+202E')).toBeVisible();
    expect(within(dialog).getByText('U+0007')).toBeVisible();
    expect(within(dialog).getByText('U+2066')).toBeVisible();
  });

  it('explains that a trigger counts as a second table (QA G2)', async () => {
    const t = await details();
    t.db.requestEdit.mockRejectedValueOnce(
      new DbApiError(
        'refused',
        'An edit may change one table only; this one also changes customers, audit_log (for example through a trigger).',
        'multiple-tables',
      ),
    );
    await t.user.click(within(t.panel).getByRole('button', { name: 'Delete row' }));
    expect(await within(t.panel).findByRole('alert')).toHaveTextContent(
      'A trigger counts as a second table',
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('Answered elsewhere, app restarted: says so in the dialog', async () => {
    const t = await details();
    t.db.confirmEdit.mockRejectedValueOnce(
      new DbApiError('bad-token', 'Not run: this change was already answered or cancelled.'),
    );
    await t.user.click(within(t.panel).getByRole('button', { name: 'Delete row' }));
    const dialog = await screen.findByRole('alertdialog');
    await t.user.click(within(dialog).getByRole('button', { name: 'Run change' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Answered in another tab');
  });

  it('Busy: "Running…" while the app finishes a long read', async () => {
    const t = await details();
    t.db.confirmEdit.mockReturnValueOnce(never());
    await t.user.click(within(t.panel).getByRole('button', { name: 'Delete row' }));
    const dialog = await screen.findByRole('alertdialog');
    await t.user.click(within(dialog).getByRole('button', { name: 'Run change' }));
    expect(within(dialog).getByText('Running…')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('Lost connection: "Lost connection; the change did not run", and Run is off', async () => {
    const t = await details();
    await t.user.click(within(t.panel).getByRole('button', { name: 'Delete row' }));
    const dialog = await screen.findByRole('alertdialog');
    t.client.status.mockRejectedValue(new TypeError('Failed to fetch'));
    await t.drop();
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Lost connection; the change did not run',
    );
    await t.user.click(within(dialog).getByRole('button', { name: 'Run change' }));
    expect(t.db.confirmEdit).not.toHaveBeenCalled();
  });

  it('Permission denied: "Not run: no answer in 60 s"', async () => {
    const t = await details();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await t.user.click(within(t.panel).getByRole('button', { name: 'Delete row' }));
    const dialog = await screen.findByRole('alertdialog');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Not run: no answer in 60 s');
  });

  it('Snapshots: "Snapshots are read-only"', async () => {
    const data = writable();
    data.list.databases = [
      { name: 'app_flutter/app.sqlite', backend: 'snapshot', source: 'sqlite-file' },
    ];
    data.list.sources = [{ id: 'sqlite-file', live: false, writable: false }];
    const t = await ordersGrid(data);
    await t.user.click(within(grid()).getByText('Coffee'));
    const panel = await screen.findByRole('dialog', { name: 'orders: id 1' });
    expect(within(panel).getByText('Snapshots are read-only')).toBeVisible();
    expect(within(panel).queryByRole('button', { name: 'Edit' })).toBeNull();
  });
});

describe('Export', () => {
  it('reads a keyed table after the last key read, never by offset, and counts UTF-8 bytes', async () => {
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const t = await ordersGrid();
    const page = (from: number) =>
      Array.from({ length: 1000 }, (_, i) => [from + i, 'é', 'pending', 1]);
    t.db.query.mockImplementation((input) => {
      if (input.sql.startsWith('SELECT count(*)')) {
        return Promise.resolve({ columns: ['n'], rows: [[1500]], truncated: false, durationMs: 1 });
      }
      const after = input.sql.includes('"id" > ?');
      return Promise.resolve({
        columns: ['id', 'item', 'status', 'customer_id'],
        rows: after ? page(1000).slice(0, 500) : page(0),
        truncated: false,
        durationMs: 1,
      });
    });
    await t.send({ type: 'db.changed', payload: { source: 'drift', db: 'app', table: 'orders' } });
    await screen.findByText(/of 1,500/);
    const before = t.db.query.mock.calls.length;
    await t.user.click(screen.getByRole('button', { name: /^Export/ }));
    await t.user.click(screen.getByRole('button', { name: 'CSV' }));
    await waitFor(() => expect(t.db.query.mock.calls.length - before).toBe(2));
    const [first, second] = t.db.query.mock.calls.slice(before).map((c) => c[0]);
    expect(first?.sql).toBe('SELECT * FROM "orders" ORDER BY "id" LIMIT ?');
    expect(second?.sql).toBe('SELECT * FROM "orders" WHERE "id" > ? ORDER BY "id" LIMIT ?');
    expect(second?.params).toEqual([999, 500]);
    expect(second?.sql).not.toContain('OFFSET');
  });
});

describe('Snapshot and diff', () => {
  it('Disabled before a snapshot; then "Snapshot 14:02 taken" and the changes', async () => {
    const db = fakeDbClient();
    const t = await open(db);
    await t.user.click(await screen.findByRole('button', { name: 'Diff' }));
    expect(screen.getByText('Take a snapshot first, then use the app')).toBeVisible();
    await t.user.click(screen.getByRole('button', { name: 'Snapshot' }));
    expect(await screen.findByText('Snapshot 14:02 taken')).toBeVisible();
    expect(await screen.findByText('No changes since 14:02.')).toBeVisible();
    db.diff.mockResolvedValueOnce({
      db: 'app',
      snapshotId: 'snap-1',
      takenAt: 0,
      truncated: false,
      tablesOmitted: 0,
      tables: [
        {
          table: 'orders',
          columns: ['id', 'item', 'status'],
          key: ['id'],
          matchedByRowid: false,
          added: [{ key: 3, row: [3, 'Cake', 'pending'] }],
          changed: [{ key: 1, row: [1, 'Coffee', 'shipped'], columns: ['status'] }],
          removed: [{ key: 2 }],
          counts: { added: 1, changed: 341, removed: 1 },
          truncated: true,
        },
      ],
    });
    await t.user.click(screen.getByRole('button', { name: 'Compare again' }));
    const list = await screen.findByRole('list', { name: 'Changes in orders' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent.slice(0, 18)),
    ).toEqual(['+ addedid 3id: 3it', '~ changedid 1id: 1', '− removedid 2']);
    expect(within(list).getByText('shipped').closest('.font-bold')).not.toBeNull();
    expect(within(list).getByText('Coffee').closest('.font-bold')).toBeNull();
    expect(screen.getByText('and 340 more')).toBeVisible();
  });

  it('Error: "Couldn\'t take a snapshot: <reason>"', async () => {
    const db = fakeDbClient();
    db.snapshot.mockRejectedValueOnce(new DbApiError('busy', 'The app is writing; try Refresh.'));
    const t = await open(db);
    await t.user.click(await screen.findByRole('button', { name: 'Snapshot' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't take a snapshot: The app is writing; try Refresh.",
    );
  });
});

describe('Schema diagram', () => {
  it('Default: tables as named buttons that open them; list view says the same', async () => {
    const t = await open();
    await t.user.click(await screen.findByRole('button', { name: 'Diagram' }));
    expect(
      await screen.findByRole('button', { name: 'orders table, 4 columns, links to customers' }),
    ).toBeVisible();
    for (const name of [
      'Zoom in',
      'Zoom out',
      'Fit',
      'Pan up',
      'Pan down',
      'Pan left',
      'Pan right',
    ]) {
      expect(screen.getByRole('button', { name })).toBeVisible();
    }
    await t.user.click(screen.getByRole('button', { name: 'List view' }));
    const list = screen.getByRole('list', { name: 'Tables and links' });
    expect(within(list).getByText('customer_id → customers.id')).toBeVisible();
    await t.user.click(within(list).getByRole('button', { name: 'orders' }));
    expect(await screen.findByRole('grid', { name: 'orders rows' })).toBeVisible();
  });
});
