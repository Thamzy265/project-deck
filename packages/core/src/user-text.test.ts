/**
 * User-facing text must paste and run for someone who started Pitdeck through npx or the
 * plugin: they have no `pitdeck` on their PATH (M5 batch 3, N1). Every command in a
 * message goes through `deckCommand()`, so this scans the sources for a bare
 * `pitdeck <command>` (or `${CLI_NAME} <command>`) in backticks.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGES = fileURLToPath(new URL('../../', import.meta.url));
const BARE = /\\?`(?:pitdeck|\$\{CLI_NAME\}) (?:init|start|stop|open|doctor|mcp)\b(?!:)/;
// The marker comment `init` writes into .gitignore names the command that wrote it; it is
// matched by the same text on every run, not a line a user is told to run.
const ALLOWED = new Set(['cli/src/gitignore.ts']);

async function sources(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sources(path)));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

describe('user-facing text', () => {
  it('never tells the user to run a bare `pitdeck <command>`', async () => {
    const bare: string[] = [];
    for (const package_ of await readdir(PACKAGES)) {
      const src = join(PACKAGES, package_, 'src');
      const files = await sources(src).catch(() => []);
      for (const file of files) {
        const shown = relative(PACKAGES, file).split('\\').join('/');
        if (ALLOWED.has(shown)) continue;
        for (const [n, line] of (await readFile(file, 'utf8')).split('\n').entries()) {
          // Comments explain the code to developers; they are not shown to users.
          if (/^\s*(\/\/|\/?\*)/.test(line)) continue;
          if (BARE.test(line)) bare.push(`${shown}:${n + 1}`);
        }
      }
    }
    expect(bare).toEqual([]);
  });
});
