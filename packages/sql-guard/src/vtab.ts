/**
 * Reads the table name and column names out of a CREATE VIRTUAL TABLE statement, so the
 * gate can stand in a plain table when it lacks the module (e.g. fts4). This only shapes
 * the scratch schema: a wrong guess makes queries on that table fail to prepare, which
 * refuses them. It never decides whether a statement is allowed.
 */

import { foldName } from './names.js';

type Token = { kind: 'id' | 'string' | 'punct' | 'word'; text: string };

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const closeOf: Record<string, string> = { '"': '"', '`': '`', '[': ']', "'": "'" };
  while (i < sql.length) {
    const c = sql.charAt(i);
    if (/\s/.test(c)) {
      i++;
    } else if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
    } else if (sql.startsWith('/*', i)) {
      const close = sql.indexOf('*/', i + 2);
      i = close === -1 ? sql.length : close + 2;
    } else if (c in closeOf) {
      const close = closeOf[c] ?? c;
      let text = '';
      i++;
      while (i < sql.length) {
        if (sql.charAt(i) === close) {
          // A doubled quote is an escaped quote (not for [brackets]).
          if (close !== ']' && sql.charAt(i + 1) === close) {
            text += close;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        text += sql.charAt(i);
        i++;
      }
      tokens.push({ kind: c === "'" ? 'string' : 'id', text });
    } else if (/[A-Za-z0-9_$]/.test(c)) {
      let text = '';
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql.charAt(i))) text += sql.charAt(i++);
      tokens.push({ kind: 'word', text });
    } else {
      tokens.push({ kind: 'punct', text: c });
      i++;
    }
  }
  return tokens;
}

export function virtualTableColumns(sql: string): { table: string; columns: string[] } | undefined {
  const tokens = tokenize(sql);
  const using = tokens.findIndex((t) => t.kind === 'word' && foldName(t.text) === 'using');
  if (using < 1) return undefined;
  const nameToken = tokens[using - 1];
  if (nameToken === undefined || (nameToken.kind !== 'word' && nameToken.kind !== 'id')) {
    return undefined;
  }
  const open = tokens.findIndex((t, i) => i > using && t.text === '(');
  if (open === -1) return undefined;
  const args: Token[][] = [[]];
  let depth = 0;
  for (const t of tokens.slice(open + 1)) {
    if (t.kind === 'punct' && t.text === '(') depth++;
    if (t.kind === 'punct' && t.text === ')') {
      if (depth === 0) break;
      depth--;
    }
    if (depth === 0 && t.kind === 'punct' && t.text === ',') {
      args.push([]);
      continue;
    }
    args.at(-1)?.push(t);
  }
  const columns: string[] = [];
  for (const arg of args) {
    const first = arg[0];
    // `option=value` arguments configure the module; they aren't columns.
    if (first === undefined || arg.some((t) => t.kind === 'punct' && t.text === '=')) continue;
    if (first.kind === 'word' || first.kind === 'id') columns.push(first.text);
  }
  return { table: nameToken.text, columns };
}
