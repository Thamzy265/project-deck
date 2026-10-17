/**
 * CSV and JSON exports of a table or a query result (design note U3). Cells are the
 * app's untrusted data: every CSV field is quoted, and text a spreadsheet would run as
 * a formula gets a leading `'`. Blobs are exported as their size, never their bytes.
 */
import type { Cell } from '@project-deck/core';

/**
 * A formula lead, also behind leading spaces: spreadsheets that trim fields on import
 * (Google Sheets, LibreOffice) then run it (TAB-8). `\s` covers no-break and other
 * Unicode spaces; the zero-width space is added because trims may drop it too.
 */
const FORMULA = /^(?:[\t\r]|[\s\u200b]*[=+\-@])/;

function quote(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

function guarded(text: string): string {
  return quote(FORMULA.test(text) ? `'${text}` : text);
}

export function csvField(cell: Cell): string {
  if (cell === null) return '""';
  if (typeof cell === 'number') return quote(String(cell));
  if (typeof cell === 'string') return guarded(cell);
  if (cell.type === 'blob') return quote(`BLOB ${cell.bytes} bytes`);
  // Big integers and odd doubles are numbers, written as such.
  return quote(cell.value);
}

export function toCsv(columns: readonly string[], rows: readonly (readonly Cell[])[]): string {
  const lines = [columns.map(guarded).join(',')];
  for (const row of rows) lines.push(row.map(csvField).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** Columns and rows as they are: repeated column names survive, unlike objects. */
export function toJson(columns: readonly string[], rows: readonly (readonly Cell[])[]): string {
  return `${JSON.stringify({ columns, rows }, null, 2)}\n`;
}

/** A file name from a table or database name: letters, digits, dot, dash, underscore. */
export function exportName(base: string, ext: 'csv' | 'json'): string {
  const safe = base
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, 80);
  return `${safe === '' ? 'export' : safe}.${ext}`;
}
