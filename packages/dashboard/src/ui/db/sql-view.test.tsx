import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DbApiError } from '../../api/db-client.js';
import { fakeDbClient, fakeDbData } from '../../testing/db-fake.js';
import { fakeDaemon, renderDashboard } from '../../testing/harness.js';
import { nameFor, withQuery } from './SavedQueries.js';

async function open(data = fakeDbData()) {
  const db = fakeDbClient(data);
  const t = renderDashboard(fakeDaemon(), undefined, undefined, { tab: 'database', db });
  await t.connect();
  await screen.findByRole('combobox', { name: 'Database' });
  return { ...t, user: userEvent.setup() };
}

describe('saved query helpers', () => {
  it('names a query by its first line, uniquely', () => {
    expect(nameFor('SELECT * FROM orders\nWHERE 1', [])).toBe('SELECT * FROM orders');
    expect(nameFor('SELECT 1', [{ name: 'SELECT 1', sql: 'x' }])).toBe('SELECT 1 (2)');
    expect(nameFor(`SELECT ${'x'.repeat(60)}`, [])).toHaveLength(41);
  });

  it('adds a query once, and refuses past 200', () => {
    const one = [{ name: 'a', sql: 'SELECT 1' }];
    expect(withQuery(one, 'SELECT 1')).toBe(one);
    expect(withQuery(one, 'SELECT 2')).toEqual([...one, { name: 'SELECT 2', sql: 'SELECT 2' }]);
    const full = Array.from({ length: 200 }, (_, i) => ({ name: `q${i}`, sql: `SELECT ${i}` }));
    expect(withQuery(full, 'SELECT x')).toBeUndefined();
  });
});

describe('Saved queries (⋯ menu)', () => {
  it('Empty: says how to save', async () => {
    const t = await open();
    await t.user.click(screen.getByRole('button', { name: 'More database options' }));
    expect(
      screen.getByText('No saved queries. Save the current query with Cmd/Ctrl+S'),
    ).toBeVisible();
  });

  it('Default: Run opens the SQL view and runs it through the gate; Rename and Delete save', async () => {
    const data = fakeDbData({
      saved: [
        { name: 'All orders', sql: 'SELECT * FROM "orders"' },
        { name: 'Customers', sql: 'SELECT * FROM "customers"' },
      ],
    });
    const t = await open(data);
    await t.user.click(screen.getByRole('button', { name: 'More database options' }));
    await t.user.click(screen.getByRole('button', { name: 'Rename saved query: Customers' }));
    const input = screen.getByRole('textbox', { name: 'New name for Customers' });
    await t.user.clear(input);
    await t.user.type(input, 'People{Enter}');
    await waitFor(() =>
      expect(t.db.saveQueries).toHaveBeenLastCalledWith(
        [
          { name: 'All orders', sql: 'SELECT * FROM "orders"' },
          { name: 'People', sql: 'SELECT * FROM "customers"' },
        ],
        'none',
      ),
    );
    await t.user.click(screen.getByRole('button', { name: 'Delete saved query: People' }));
    await waitFor(() =>
      expect(t.db.saveQueries).toHaveBeenLastCalledWith(
        [{ name: 'All orders', sql: 'SELECT * FROM "orders"' }],
        expect.stringMatching(/^[0-9a-f]{64}$/),
      ),
    );
    await t.user.click(screen.getByRole('button', { name: 'Run saved query: All orders' }));
    expect(screen.getByRole('button', { name: 'SQL' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() =>
      expect(t.db.query).toHaveBeenCalledWith(
        { db: 'app', sql: 'SELECT * FROM "orders"', limit: 1000 },
        expect.any(AbortSignal),
      ),
    );
    expect(await screen.findByText('2 rows in 1 ms')).toBeVisible();
    expect(screen.getByRole('grid', { name: 'Query result' })).toBeVisible();
  });

  it('Error: "Couldn\'t save queries"', async () => {
    const t = await open(fakeDbData({ saved: [{ name: 'a', sql: 'SELECT 1' }] }));
    t.db.saveQueries.mockRejectedValueOnce(new DbApiError('internal', "Couldn't save queries."));
    await t.user.click(screen.getByRole('button', { name: 'More database options' }));
    await t.user.click(screen.getByRole('button', { name: 'Delete saved query: a' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save queries");
  });
});

describe('SQL editor', () => {
  it('a refused query says why in the spec words, and nothing ran', async () => {
    const t = await open(fakeDbData({ saved: [{ name: 'Delete', sql: 'DELETE FROM orders' }] }));
    t.db.query.mockRejectedValue(
      new DbApiError('refused', 'Only reading is allowed here.', 'writes-data'),
    );
    await t.user.click(screen.getByRole('button', { name: 'More database options' }));
    await t.user.click(screen.getByRole('button', { name: 'Run saved query: Delete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only reading queries run here. This one would change data (it deletes rows).',
    );
    expect(screen.queryByRole('grid', { name: 'Query result' })).toBeNull();
  });

  it('has a visible label and the run shortcut on the Run button', async () => {
    const t = await open();
    await t.user.click(screen.getByRole('button', { name: 'SQL' }));
    expect(screen.getByText('SQL', { selector: '#sql-label' })).toBeVisible();
    const run = screen.getByRole('button', { name: 'Run' });
    expect(run).toHaveAttribute('aria-keyshortcuts', 'Meta+Enter Control+Enter');
    // The editor sits in a shadow root (CSP), named like its visible label.
    const host = screen.getByText('SQL', { selector: '#sql-label' }).nextElementSibling;
    await waitFor(() =>
      expect(host?.shadowRoot?.querySelector('[role="textbox"]')).toHaveAttribute(
        'aria-label',
        'SQL',
      ),
    );
  });
});
