import { describe, expect, it } from 'vitest';
import type { BTree, HiddenColumns, Op } from './bytecode.js';
import { findHiddenRead } from './bytecode.js';

const trees = new Map<number, BTree>([
  [
    2,
    {
      kind: 'table',
      table: 'secrets',
      storage: ['sid', 'token', 'note'],
      rowidAlias: 'sid',
      withoutRowid: false,
    },
  ],
  [3, { kind: 'index', table: 'secrets', columns: ['note'], partial: false }],
]);
const hide = (table: string, column: string): HiddenColumns =>
  new Map([[table, new Set([column])]]);
const op = (opcode: string, p1 = 0, p2 = 0, p3 = 0): Op => ({ opcode, p1, p2, p3 });

describe('findHiddenRead', () => {
  it('finds a hidden column read through a duplicated cursor', () => {
    const hidden = hide('secrets', 'token');
    const ops = [op('OpenRead', 0, 2), op('OpenDup', 1, 0), op('Column', 1, 1)];
    expect(findHiddenRead(ops, trees, hidden)).toBe('secrets.token');
  });

  it('ignores the temp schema and the row an edit rewrites', () => {
    const hidden = hide('secrets', 'token');
    expect(findHiddenRead([op('OpenRead', 0, 2, 1), op('Column', 0, 1)], trees, hidden)).toBe(
      undefined,
    );
    expect(findHiddenRead([op('OpenWrite', 0, 2), op('Column', 0, 1)], trees, hidden)).toBe(
      undefined,
    );
  });

  it('treats the rowid of a table whose INTEGER PRIMARY KEY is hidden as hidden', () => {
    const hidden = hide('secrets', 'sid');
    expect(findHiddenRead([op('OpenRead', 0, 2), op('Rowid', 0, 1)], trees, hidden)).toBe(
      'secrets.sid',
    );
    expect(findHiddenRead([op('OpenRead', 4, 3), op('IdxRowid', 4, 1)], trees, hidden)).toBe(
      'secrets.sid',
    );
    expect(findHiddenRead([op('OpenRead', 0, 2), op('Column', 0, 2)], trees, hidden)).toBe(
      undefined,
    );
  });

  it('allows only counting on an index that holds a hidden column', () => {
    const hidden = hide('secrets', 'note');
    expect(findHiddenRead([op('OpenRead', 1, 3), op('Count', 1, 5)], trees, hidden)).toBe(
      undefined,
    );
    expect(findHiddenRead([op('OpenRead', 1, 3), op('Rewind', 1, 9)], trees, hidden)).toBe(
      'secrets.note',
    );
  });

  it('reads register operands as registers, not cursors', () => {
    const hidden = hide('secrets', 'token');
    expect(findHiddenRead([op('OpenRead', 0, 2), op('Integer', 0, 1)], trees, hidden)).toBe(
      undefined,
    );
  });
});
