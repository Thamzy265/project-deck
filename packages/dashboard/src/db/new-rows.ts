/**
 * The grid's "N new rows" chip (lead decision B4-6): it adds up every new or changed
 * row that arrives out of view while the user is scrolled away, and forgets each one
 * the user scrolls to. Rows are named by identity, so a re-read that moves them keeps
 * the count right.
 */

export function withNewRows(
  pending: ReadonlySet<string>,
  changed: readonly string[],
  visible: ReadonlySet<string>,
): Set<string> {
  const next = new Set(pending);
  for (const id of changed) if (!visible.has(id)) next.add(id);
  return next;
}

export function seenNewRows(
  pending: ReadonlySet<string>,
  visible: ReadonlySet<string>,
): ReadonlySet<string> {
  if (![...pending].some((id) => visible.has(id))) return pending;
  return new Set([...pending].filter((id) => !visible.has(id)));
}
