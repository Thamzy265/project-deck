/**
 * Finds what each generated column of a CREATE TABLE is computed from, so a generated
 * column built on a hidden column is hidden too (SG-3). A STORED one is read straight
 * from the record, so neither the authorizer nor the bytecode check sees the hidden
 * column behind it. Over-matching (a function named like a column) only hides more.
 */
import { foldName } from './names.js';
import type { Token } from './vtab.js';
import { tokenize } from './vtab.js';

/** Generated column (folded) → identifiers (folded) in its expression. */
export function generatedColumnRefs(createSql: string): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();
  const tokens = tokenize(createSql);
  const open = tokens.findIndex((t) => t.kind === 'punct' && t.text === '(');
  if (open === -1) return refs;
  // Split the column list at top-level commas.
  const defs: Token[][] = [[]];
  let depth = 0;
  for (const t of tokens.slice(open + 1)) {
    if (t.kind === 'punct' && t.text === '(') depth++;
    if (t.kind === 'punct' && t.text === ')') {
      if (depth === 0) break;
      depth--;
    }
    if (depth === 0 && t.kind === 'punct' && t.text === ',') {
      defs.push([]);
      continue;
    }
    defs.at(-1)?.push(t);
  }
  for (const def of defs) {
    const name = def[0];
    if (name === undefined || (name.kind !== 'word' && name.kind !== 'id')) continue;
    // `[GENERATED ALWAYS] AS ( expr )`: the only AS outside parentheses in a column
    // definition (CAST(x AS T) sits inside DEFAULT or CHECK parentheses).
    let nesting = 0;
    const as = def.findIndex((t) => {
      if (t.kind === 'punct' && t.text === '(') nesting++;
      if (t.kind === 'punct' && t.text === ')') nesting--;
      return nesting === 0 && t.kind === 'word' && foldName(t.text) === 'as';
    });
    const paren = def[as + 1];
    if (as < 1 || paren?.text !== '(') continue;
    const idents = new Set<string>();
    let level = 0;
    for (const t of def.slice(as + 1)) {
      if (t.kind === 'punct' && t.text === '(') level++;
      if (t.kind === 'punct' && t.text === ')' && --level === 0) break;
      if (t.kind === 'word' || t.kind === 'id') idents.add(foldName(t.text));
    }
    refs.set(foldName(name.text), idents);
  }
  return refs;
}
