/** "Loading row…" seen stuck once in QA: the row-details read path. */
import type { Cell, TableInfo } from '@project-deck/core';
import { render, screen } from '@testing-library/react';
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
