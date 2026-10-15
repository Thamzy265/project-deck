/**
 * Local paths name the user and their projects; Claude never needs them. Error texts
 * get the project folder replaced by `<project>` and the home folder by `~`, before
 * masking.
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

function withRealPath(path: string): string[] {
  const out = [resolve(path)];
  try {
    out.push(realpathSync(path));
  } catch {
    // Gone or unreadable: the path as given is all there is.
  }
  return out;
}

export function pathScrubber(projectDir: string): (text: string) => string {
  const home = homedir();
  const replacements: [string, string][] = [
    ...withRealPath(projectDir).map((p): [string, string] => [p, '<project>']),
    ...(home === '' ? [] : withRealPath(home).map((p): [string, string] => [p, '~'])),
  ]
    // Longest first: the project folder may sit inside the home folder.
    .sort((a, b) => b[0].length - a[0].length);
  return (text) => {
    let out = text;
    for (const [path, name] of replacements) out = out.split(path).join(name);
    return out;
  };
}
