import type { TableInfo } from '@project-deck/core';

export const BOX_WIDTH = 200;
export const BOX_HEADER = 28;
export const BOX_ROW = 20;
const GAP = 64;
const MARGIN = 16;

export interface Box {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Link {
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Tables in a square-ish grid, foreign keys as lines from column to referenced column. */
export function layoutDiagram(tables: readonly TableInfo[]): {
  boxes: Box[];
  links: Link[];
  width: number;
  height: number;
} {
  const perRow = Math.max(1, Math.ceil(Math.sqrt(tables.length)));
  const heights = tables.map((t) => BOX_HEADER + Math.max(1, t.columns.length) * BOX_ROW + 8);
  const rowHeights: number[] = [];
  heights.forEach((h, i) => {
    const r = Math.floor(i / perRow);
    rowHeights[r] = Math.max(rowHeights[r] ?? 0, h);
  });
  const rowTops: number[] = [];
  let top = MARGIN;
  for (const h of rowHeights) {
    rowTops.push(top);
    top += h + GAP;
  }
  const boxes: Box[] = tables.map((t, i) => ({
    name: t.name,
    x: MARGIN + (i % perRow) * (BOX_WIDTH + GAP),
    y: rowTops[Math.floor(i / perRow)] ?? MARGIN,
    width: BOX_WIDTH,
    height: heights[i] ?? BOX_HEADER,
  }));
  const byName = new Map(boxes.map((b, i) => [b.name, { box: b, table: tables[i] }]));
  const columnY = (box: Box, table: TableInfo | undefined, column: string | null): number => {
    const at = table?.columns.findIndex((c) => (column === null ? c.pk : c.name === column)) ?? -1;
    return box.y + BOX_HEADER + Math.max(0, at) * BOX_ROW + BOX_ROW / 2;
  };
  const links: Link[] = [];
  for (const t of tables) {
    const from = byName.get(t.name);
    if (from === undefined) continue;
    for (const fk of t.foreignKeys) {
      const to = byName.get(fk.table);
      if (to === undefined) continue;
      const rightward = to.box.x >= from.box.x;
      links.push({
        from: t.name,
        to: fk.table,
        x1: rightward ? from.box.x + from.box.width : from.box.x,
        y1: columnY(from.box, from.table, fk.from),
        x2: rightward ? to.box.x : to.box.x + to.box.width,
        y2: columnY(to.box, to.table, fk.to),
      });
    }
  }
  const width = MARGIN * 2 + Math.min(perRow, Math.max(1, tables.length)) * (BOX_WIDTH + GAP) - GAP;
  return { boxes, links, width, height: Math.max(top - GAP + MARGIN, MARGIN * 2) };
}

/** "orders table, 4 columns, links to customers" (UI spec, accessibility). */
export function boxLabel(t: TableInfo): string {
  const kind = t.kind === 'view' ? 'view' : 'table';
  const cols = `${t.columns.length} ${t.columns.length === 1 ? 'column' : 'columns'}`;
  const targets = [...new Set(t.foreignKeys.map((f) => f.table))];
  return `${t.name} ${kind}, ${cols}${targets.length > 0 ? `, links to ${targets.join(', ')}` : ''}`;
}
