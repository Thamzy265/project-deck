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
const NAME = String.raw`(?:pitdeck|\$\{CLI\w*\})`;
const COMMAND = String.raw`(?:init|start|stop|open|doctor|mcp)\b(?!:)`;
// A command after a backtick, inside <code>, or after "Run"; or built by joining
// `'Run ' + CLI_NAME + ' init'`.
const BARE = new RegExp(
  String.raw`(?:\\?\x60|<code[^>]*>|\bRun\s+)${NAME} ${COMMAND}` +
    '|' +
    String.raw`\bRun\s*['"]\s*\+\s*CLI\w*\s*\+\s*['"]\s*${COMMAND}`,
);
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

describe('the bare-command scan', () => {
  // One fixture per way a bare command has been written, so a widened pattern that
  // stops matching one of them fails here and not silently.
  const bad = [
    '<p>Login needed. Run <code>pitdeck open</code> in your project</p>',
    '<code className={code}>pitdeck start</code>',
    "const t = 'Run pitdeck start, then try again.';",
    'const t = "Run pitdeck stop";',
    'const t = `${CLI} init`;',
    'const t = `Run \\`${CLI_NAME} init\\` first`;',
    "const t = 'Run ' + CLI_NAME + ' init';",
    'const t = `run \\`pitdeck doctor\\``;',
  ];
  const fine = [
    "const t = `Run \\`${deckCommand('init')}\\` first`;",
    'const t = `Usage: ${CLI_NAME} <command> [--project <folder>]`;',
    "<code className={code}>{deckCommand('start')}</code>",
    "const t = 'pitdeck: ' + message;",
  ];
  for (const line of bad) it(`catches ${line}`, () => expect(BARE.test(line)).toBe(true));
  for (const line of fine) it(`allows ${line}`, () => expect(BARE.test(line)).toBe(false));
});

describe('user-facing text', () => {
  it('never tells the user to run a bare `pitdeck <command>`', async () => {
    const bare: string[] = [];
    const scanned: string[] = [];
    for (const package_ of await readdir(PACKAGES)) {
      const src = join(PACKAGES, package_, 'src');
      const files = await sources(src).catch(() => []);
      for (const file of files) {
        const shown = relative(PACKAGES, file).split('\\').join('/');
        scanned.push(shown);
        if (ALLOWED.has(shown)) continue;
        for (const [n, line] of (await readFile(file, 'utf8')).split('\n').entries()) {
          // Comments explain the code to developers; they are not shown to users.
          if (/^\s*(\/\/|\/?\*)/.test(line)) continue;
          if (BARE.test(line)) bare.push(`${shown}:${n + 1}`);
        }
      }
    }
    // JSX text lives in .tsx files: the scan must reach them.
    expect(scanned).toContain('dashboard/src/ui/PageState.tsx');
    expect(bare).toEqual([]);
  });
});
