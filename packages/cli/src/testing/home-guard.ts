/**
 * Guards the user's real ~/.flutterdeck while tests run: the global setup snapshots it
 * before and checks it after, so a test that escapes the scratch HOME fails the run.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** File name → size and modification time; empty when the folder doesn't exist. */
export function snapshotDir(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    try {
      const s = statSync(join(dir, name));
      out.set(name, `${s.size}:${s.mtimeMs}`);
    } catch {
      out.set(name, 'gone');
    }
  }
  return out;
}

/** The names that were added, removed or changed between two snapshots. */
export function changedEntries(before: Map<string, string>, after: Map<string, string>): string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => before.get(name) !== after.get(name)).sort();
}
