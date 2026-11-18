import { readdirSync, statSync } from 'node:fs';
import type { PlatformPath } from 'node:path';
import path from 'node:path';

/** Every file below `dir`, leaving out dotfiles and dot folders (such as .DS_Store or .replay). */
export function walk(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.'))
    .flatMap((name) => {
      const file = path.join(dir, name);
      return statSync(file).isDirectory() ? walk(file) : [file];
    });
}

/** `file` relative to `base`, with `/` on every OS, so tests can filter and split on `/`. */
export function posixRelative(base: string, file: string, p: PlatformPath = path): string {
  return p.relative(base, file).split(p.sep).join('/');
}
