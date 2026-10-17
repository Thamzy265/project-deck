/** "Loading row…" seen stuck once in QA: the row-details read path. */
import type { Cell, TableInfo } from '@project-deck/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DbProvider } from '../../state/DbProvider.js';
import { fakeDbClient } from '../../testing/db-fake.js';
import { RowDetails } from './RowDetails.js';

const codes: TableInfo = {
  name: 'codes',
  kind: 'table',
  columns: [
    { name: 'code', type: 'TEXT', nullable: true, pk: true, pkPosition: 1, default: null },
    { name: 'v', type: 'TEXT', nullable: true, pk: false, default: null },
  ],
  foreignKeys: [],
  indexes: [],
};

function details(row: Cell[]) {
  return (
    <RowDetails
      db="app"
      table={codes}
      columns={['code', 'v']}
      row={row}
      writes={{ kind: 'off' }}
      connected
      onClose={vi.fn()}
      onFollowKey={vi.fn()}
      onToast={vi.fn()}
    />
  );
}

describe('row details reading its row', () => {
  it('never stays "Loading row…" when its row changes to one it can not read by key', async () => {
    const db = fakeDbClient();
    // The read of row "a" never answers before the row changes.
    db.query.mockReturnValue(new Promise(() => undefined));
    const view = render(<DbProvider client={db}>{details(['a', 'first'])}</DbProvider>);
    expect(screen.getByText('Loading row…')).toBeInTheDocument();
    // A live change moves another row (with a null key) to this place in the page.
    view.rerender(<DbProvider client={db}>{details([null, 'second'])}</DbProvider>);
    expect(await screen.findByText('second')).toBeInTheDocument();
    expect(screen.queryByText('Loading row…')).toBeNull();
  });
});

describe('row details: a table too wide to check the row (review note)', () => {
  // A thousand columns make a big page for jsdom: text queries, not role queries.
  it('refuses Delete row with a clear message and asks nothing', { timeout: 30_000 }, async () => {
    const names = ['id', ...Array.from({ length: 999 }, (_, i) => `c${i}`)];
    const wide: TableInfo = {
      name: 'wide',
      kind: 'table',
      columns: names.map((name, i) => ({
        name,
        type: i === 0 ? 'INTEGER' : 'TEXT',
        nullable: i !== 0,
        pk: i === 0,
        ...(i === 0 ? { pkPosition: 1 } : {}),
        default: null,
      })),
      foreignKeys: [],
      indexes: [],
    };
    const row: Cell[] = names.map((_, i) => (i === 0 ? 1 : 'x'));
    const db = fakeDbClient();
    db.query.mockResolvedValue({ columns: names, rows: [row], truncated: false, durationMs: 1 });
    render(
      <DbProvider client={db}>
        <RowDetails
          db="app"
          table={wide}
          columns={names}
          row={row}
          writes={{ kind: 'on' }}
          connected
          onClose={vi.fn()}
          onFollowKey={vi.fn()}
          onToast={vi.fn()}
        />
      </DbProvider>,
    );
    expect(await screen.findByText('c998')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Delete row'));
    expect(
      await screen.findByText(
        'This table has too many columns to check the row safely; edit it with SQL in your own tools.',
      ),
    ).toHaveAttribute('role', 'alert');
    expect(db.requestEdit).not.toHaveBeenCalled();
  });
});
