import type { TableInfo } from '@project-deck/core';
import { describe, expect, it } from 'vitest';
import { BOX_HEADER, BOX_ROW, boxLabel, layoutDiagram } from './diagram-layout.js';

const col = (name: string, pk = false) => ({
  name,
  type: 'INTEGER',
  nullable: false,
  pk,
  default: null,
});

const customers: TableInfo = {
  name: 'customers',
  kind: 'table',
  columns: [col('id', true), col('name')],
  foreignKeys: [],
  indexes: [],
};
const orders: TableInfo = {
  name: 'orders',
  kind: 'table',
  columns: [col('id', true), col('item'), col('status'), col('customer_id')],
  foreignKeys: [{ from: 'customer_id', table: 'customers', to: null }],
  indexes: [],
};

describe('layoutDiagram', () => {
  it('places boxes without overlap and links a foreign key to the referenced key', () => {
    const { boxes, links, width, height } = layoutDiagram([customers, orders]);
    const [a, b] = boxes;
    expect(a && b && (a.x + a.width <= b.x || a.y + a.height <= b.y)).toBe(true);
    expect(links).toHaveLength(1);
    const [link] = links;
    expect(link?.from).toBe('orders');
    expect(link?.to).toBe('customers');
    // From orders.customer_id (4th column) to customers.id (its primary key).
    expect(link?.y1).toBe((b?.y ?? 0) + BOX_HEADER + 3 * BOX_ROW + BOX_ROW / 2);
    expect(link?.y2).toBe((a?.y ?? 0) + BOX_HEADER + BOX_ROW / 2);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });

  it('skips links to tables it does not know, and lays out nothing for no tables', () => {
    expect(
      layoutDiagram([{ ...orders, foreignKeys: [{ from: 'x', table: 'gone', to: null }] }]).links,
    ).toEqual([]);
    expect(layoutDiagram([]).boxes).toEqual([]);
  });
});

describe('boxLabel', () => {
  it('names the table, its column count and its links', () => {
    expect(boxLabel(orders)).toBe('orders table, 4 columns, links to customers');
    expect(boxLabel(customers)).toBe('customers table, 2 columns');
  });
});
