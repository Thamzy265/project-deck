/**
 * Folds an SQL identifier the way SQLite compares names: ASCII letters only
 * (sqlite3StrICmp). JavaScript's toLowerCase folds all of Unicode, so "Ü" and "ü" would
 * match where SQLite says they differ (tester finding SG-6).
 */
export function foldName(name: string): string {
  return name.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}
