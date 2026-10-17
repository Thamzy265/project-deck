/**
 * Cells from the app's database are untrusted text: they are shown as text nodes only,
 * and characters that change how text reads (bidi controls, zero-width marks, control
 * characters) are named instead of acting (design note, abuse cases).
 */
import type { Cell } from '@project-deck/core';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One cell as one line of text; `muted` for null and blobs (UI spec, grid). */
export function cellText(cell: Cell): { text: string; muted: boolean } {
  if (cell === null) return { text: 'null', muted: true };
  if (typeof cell === 'number') return { text: String(cell), muted: false };
  if (typeof cell === 'string') return { text: cell, muted: false };
  if (cell.type === 'blob') return { text: `BLOB ${formatBytes(cell.bytes)}`, muted: true };
  return { text: cell.value, muted: false };
}

/** A cell as plain text for copying: the value itself, or the blob's label. */
export function cellCopyText(cell: Cell): string {
  return cellText(cell).text;
}

export type Segment = { text: string } | { mark: string };

// Bidi embeddings, overrides, isolates and marks; zero-width characters; C0, DEL, C1.
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
const KEEP_MULTILINE = new Set(['\n', '\t']);

const mark = (ch: string): string =>
  `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;

/**
 * Splits text into plain runs and named marks for every character that would act
 * unseen. Multi-line text keeps its line breaks and tabs.
 */
export function visibleSegments(text: string, opts: { multiline?: boolean } = {}): Segment[] {
  const out: Segment[] = [];
  let run = '';
  for (const ch of text) {
    if (HIDDEN.test(ch) && !(opts.multiline === true && KEEP_MULTILINE.has(ch))) {
      if (run !== '') out.push({ text: run });
      run = '';
      out.push({ mark: mark(ch) });
    } else {
      run += ch;
    }
  }
  if (run !== '' || out.length === 0) out.push({ text: run });
  return out;
}

/** Plain text with every hidden character named, for `title` and accessible names. */
export function visibleText(text: string): string {
  return visibleSegments(text)
    .map((s) => ('mark' in s ? `<${s.mark}>` : s.text))
    .join('');
}

export type Param = string | number | null;

/** A key cell as an SQL parameter. Blobs and odd doubles can't travel as JSON parameters. */
export function keyParam(cell: Cell): { ok: true; value: Param } | { ok: false } {
  if (cell === null || typeof cell === 'number' || typeof cell === 'string') {
    return { ok: true, value: cell };
  }
  // Text: the column's integer affinity turns it back into the integer when compared.
  if (cell.type === 'int') return { ok: true, value: cell.value };
  return { ok: false };
}
