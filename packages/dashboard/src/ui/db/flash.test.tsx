/** Reviews R3 and R4: which rows flash after a live change, and for how long. */
import type { TableInfo } from '@project-deck/core';
import { screen, within } from '@testing-library/react';
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
});
