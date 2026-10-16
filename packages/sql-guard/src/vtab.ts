/**
 * Reads the table name and column names out of a CREATE VIRTUAL TABLE statement, so the
 * gate can stand in a plain table when it lacks the module (e.g. fts4). This only shapes
 * the scratch schema: a wrong guess makes queries on that table fail to prepare, which
 * refuses them. It never decides whether a statement is allowed.
 */

import { foldName } from './names.js';

export type Token = { kind: 'id' | 'string' | 'punct' | 'word'; text: string };

export function tokenize(sql: string): Token[] {
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

/** The table name and the top-level arguments of a CREATE VIRTUAL TABLE, as tokens. */
function virtualTableArgs(sql: string): { table: string; args: Token[][] } | undefined {
  const tokens = tokenize(sql);
  const using = tokens.findIndex((t) => t.kind === 'word' && foldName(t.text) === 'using');
  if (using < 1) return undefined;
  const nameToken = tokens[using - 1];
  if (nameToken === undefined || (nameToken.kind !== 'word' && nameToken.kind !== 'id')) {
    return undefined;
  }
  const open = tokens.findIndex((t, i) => i > using && t.text === '(');
  if (open === -1) return { table: nameToken.text, args: [] };
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
  return { table: nameToken.text, args };
}

const isOption = (arg: Token[]) => arg.some((t) => t.kind === 'punct' && t.text === '=');

export function virtualTableColumns(sql: string): { table: string; columns: string[] } | undefined {
  const parsed = virtualTableArgs(sql);
  if (parsed === undefined) return undefined;
  const columns: string[] = [];
  for (const arg of parsed.args) {
    const first = arg[0];
    // `option=value` arguments configure the module; they aren't columns.
    if (first === undefined || isOption(arg)) continue;
    if (first.kind === 'word' || first.kind === 'id') columns.push(first.text);
  }
  return { table: parsed.table, columns };
}

/**
 * The `key=value` options of a CREATE VIRTUAL TABLE (folded key → value text), such as
 * FTS's `content='notes'`. Quoted values lose their quotes. A key given more than once
 * maps to null: which one the module uses is unknown, so callers fail closed (N1).
 */
export function virtualTableOptions(sql: string): Map<string, string | null> {
  const options = new Map<string, string | null>();
  for (const arg of virtualTableArgs(sql)?.args ?? []) {
    const eq = arg.findIndex((t) => t.kind === 'punct' && t.text === '=');
    const key = arg[0];
    if (eq !== 1 || key === undefined) continue;
    const name = foldName(key.text);
    if (options.has(name)) {
      options.set(name, null);
      continue;
    }
    options.set(
      name,
      arg
        .slice(eq + 1)
        .map((t) => t.text)
        .join(''),
    );
  }
  return options;
}
