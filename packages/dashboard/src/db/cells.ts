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

// Characters that change how text reads or show as nothing: C0, DEL, C1; soft hyphen;
// combining grapheme joiner; Arabic letter mark; Hangul fillers; Khmer inherent vowels;
// Mongolian variation selectors and vowel separator; zero-width and bidi marks; line
// and paragraph separators; embeddings, overrides, isolates; word joiner and invisible
// operators; text variation selectors (not FE0E/FE0F, which pick emoji or text style);
// BOM; interlinear annotation; musical formatting; tag characters (TAB-5).
/* eslint-disable no-control-regex, no-misleading-character-class -- named on purpose */
const HIDDEN =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0d\ufeff\uffa0\ufff9-\ufffb\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}]/u;
/* eslint-enable no-control-regex, no-misleading-character-class */
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

/** An integer past 2^53, tagged so it binds as an integer, never as text (TAB-2). */
export interface IntParam {
  type: 'int';
  value: string;
}

export type Param = string | number | null | IntParam;

/** A parameter as the user reads it: `null`, the digits of a tagged int, or the value. */
export function paramLabel(p: Param): string {
  if (p === null) return 'null';
  if (typeof p === 'object') return p.value;
  return String(p);
}

/** A key cell as an SQL parameter. Blobs and odd doubles can't travel as JSON parameters. */
export function keyParam(cell: Cell): { ok: true; value: Param } | { ok: false } {
  if (cell === null || typeof cell === 'number' || typeof cell === 'string') {
    return { ok: true, value: cell };
  }
  // Tagged: as text, a column without integer affinity would compare it as text.
  if (cell.type === 'int') return { ok: true, value: { type: 'int', value: cell.value } };
  return { ok: false };
}
