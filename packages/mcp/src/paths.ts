/**
 * Local paths name the user and their projects; Claude never needs them. Error texts
 * get the project folder replaced by `<project>` and the home folder by `~`, before
 * they are cut or masked.
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export interface ScrubOptions {
  /** Defaults to the user's home folder. */
  home?: string;
  /** Defaults to this system; tests pass 'win32' to check Windows rules anywhere. */
  platform?: NodeJS.Platform;
  /** Test seam: the other names the system has for a folder. */
  realPaths?: (dir: string) => string[];
}

/**
 * Both realpath flavours: on Windows the JavaScript one keeps a short 8.3 name such as
 * RUNNER~1 while the native one expands it, and a path may reach us in either form.
 */
function systemRealPaths(dir: string): string[] {
  const out: string[] = [];
  for (const real of [realpathSync, realpathSync.native]) {
    try {
      out.push(real(dir));
    } catch {
      // Gone, unreadable or not a path on this system: the path as given is all there is.
    }
  }
  return out;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function pathScrubber(
  projectDir: string,
  opts: ScrubOptions = {},
): (text: string) => string {
  const windows = (opts.platform ?? process.platform) === 'win32';
  const realPaths = opts.realPaths ?? systemRealPaths;
  const path = windows ? win32 : posix;
  const forms = (dir: string): string[] => {
    const out = [path.resolve(dir), ...realPaths(dir)];
    // Windows paths also appear with forward slashes, in URLs and in Dart output.
    if (windows) out.push(...out.map((p) => p.replace(/\\/g, '/')));
    return [...new Set(out)];
  };
  const home = opts.home ?? homedir();
  const replacements: [string, string][] = [
    ...forms(projectDir).map((p): [string, string] => [p, '<project>']),
    ...(home === '' ? [] : forms(home).map((p): [string, string] => [p, '~'])),
  ]
    // Longest first: the project folder may sit inside the home folder.
    .sort((a, b) => b[0].length - a[0].length);
  // Windows file names ignore case, so C:\Users\Jo and c:\users\jo are one folder.
  const patterns = replacements.map(([p, name]): [RegExp, string] => [
    new RegExp(escape(p), windows ? 'gi' : 'g'),
    name,
  ]);
  return (text) => {
    let out = text;
    for (const [re, name] of patterns) out = out.replace(re, () => name);
    return out;
  };
}
