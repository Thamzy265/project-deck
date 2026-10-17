/** Reviews R3 and R4: which rows flash after a live change, and for how long. */
import type { TableInfo } from '@project-deck/core';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeDbClient, fakeDbData } from '../../testing/db-fake.js';
import { fakeDaemon, renderDashboard } from '../../testing/harness.js';

const notes: TableInfo = {
  name: 'notes',
  kind: 'table',
  columns: [
    { name: 'body', type: 'TEXT', nullable: true, pk: false, default: null },
    { name: 'at', type: 'INTEGER', nullable: true, pk: false, default: null },
  ],
  foreignKeys: [],
  indexes: [],
};

afterEach(() => {
  vi.useRealTimers();
});

async function grid(tableName: string, data = fakeDbData()) {
  const db = fakeDbClient(data);
  const t = renderDashboard(fakeDaemon(), undefined, undefined, { tab: 'database', db });
  await t.connect();
  const user = userEvent.setup();
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Table' }), tableName);
  const g = await screen.findByRole('grid', { name: `${tableName} rows` });
  return { ...t, g };
}

const flashing = (g: HTMLElement) =>
  within(g)
    .getAllByRole('row')
    .filter((r) => r.classList.contains('deck-flash'))
    .map((r) => r.textContent);

describe('row flash (UI spec, grid Success)', () => {
  it('a table without a primary key flashes only the new row (review R3)', async () => {
    const data = fakeDbData({
      tables: [notes],
      rows: {
        notes: [
          ['a', 1],
          ['b', 2],
        ],
      },
    });
    const t = await grid('notes', data);
    data.rows.notes = [...(data.rows.notes ?? []), ['c', 3]];
    await t.send({ type: 'db.changed', payload: { source: 'drift', db: 'app', table: 'notes' } });
    await within(t.g).findByText('c');
    expect(flashing(t.g)).toEqual(['c3']);
  });

  it('the flash outlasts the schema re-read half a second later (review R4)', async () => {
    const data = fakeDbData();
    const t = await grid('orders', data);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    data.rows.orders = [...(data.rows.orders ?? []), [3, 'Cake', 'pending', 1]];
    await t.send({ type: 'db.changed', payload: { source: 'drift', db: 'app', table: 'orders' } });
    await within(t.g).findByText('Cake');
    const queries = t.db.query.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1400);
    });
    // The schema was read again (row counts) without reading the rows again.
    expect(t.db.schema.mock.calls.length).toBeGreaterThan(1);
    expect(t.db.query.mock.calls.length).toBe(queries);
    expect(flashing(t.g)).toEqual(['3Cakepending1']);
  });
});
