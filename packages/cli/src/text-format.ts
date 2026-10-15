import type { JSONPath } from 'jsonc-parser';
import { applyEdits, format, modify } from 'jsonc-parser';

/** The line ending a file already uses, so an edit doesn't mix them. */
export function lineEnding(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** The indentation of the first indented line: a tab, or a number of spaces (2 if none). */
export function indentation(text: string): { insertSpaces: boolean; tabSize: number } {
  const m = /^([ \t]+)\S/m.exec(text);
  const indent = m?.[1];
  if (indent === undefined) return { insertSpaces: true, tabSize: 2 };
  if (indent.startsWith('\t')) return { insertSpaces: false, tabSize: 1 };
  return { insertSpaces: true, tabSize: Math.min(indent.length, 8) };
}

/**
 * Sets one value in JSON (with comments) and lays out only what was inserted, in the
 * file's own indentation and line endings. jsonc-parser's own formatting option would
 * also re-lay out the neighbouring entry.
 */
export function setJsonValue(
  text: string,
  path: JSONPath,
  value: unknown,
  opts: { append?: boolean } = {},
): string {
  const edits = modify(text, path, value, { isArrayInsertion: opts.append === true });
  const out = applyEdits(text, edits);
  const [edit] = edits;
  if (edit === undefined || edits.length !== 1) return out;
  const range = { offset: edit.offset, length: edit.content.length };
  const layout = { ...indentation(text), eol: lineEnding(text) };
  return applyEdits(out, format(out, range, layout));
}
