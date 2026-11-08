/**
 * A stdout that fails for a reason other than a closed pipe must not be hidden: main.js
 * says so on stderr and exits 1. Scratch folders only; no daemon, no network.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));

describe('main.js with a stdout that fails for another reason', () => {
  let project: string;
  let home: string;
  let readOnly: string;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'deck-cli-ebadf-'));
    home = await mkdtemp(join(tmpdir(), 'deck-cli-ebadf-home-'));
    readOnly = join(home, 'read-only.txt');
    await writeFile(readOnly, 'x');
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  /** stdout is a file opened read-only, so every write fails (EBADF, EPERM on Windows). */
  async function runWithBrokenStdout(
    args: string[],
  ): Promise<{ code: number | null; stderr: string }> {
    const fd = openSync(readOnly, 'r');
    try {
      const child = spawn(process.execPath, [MAIN, ...args], {
        stdio: ['ignore', fd, 'pipe'],
        env: { HOME: home, USERPROFILE: home, PATH: '' },
      });
      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => (stderr += String(d)));
      child.on('error', () => undefined);
      const [code] = (await once(child, 'close')) as [number | null];
      return { code, stderr };
    } finally {
      closeSync(fd);
    }
  }

  // Repro for a bug: the write error is emitted on the next tick, after main.ts has
  // already read failed(), so a run whose last write fails still exits 0.
  it.each([['--version'], ['--help'], ['stop']])(
    '`%s` says the output failed and exits 1',
    async (cmd) => {
      const args = cmd === 'stop' ? ['stop', '--project', project] : [cmd];
      const result = await runWithBrokenStdout(args);
      expect(result.stderr).toContain("Couldn't write output");
      expect(result.code).toBe(1);
    },
    20_000,
  );

  it('keeps a failing command exit code when output also fails', async () => {
    // `bogus` writes only to stderr, which works: stdout's breakage is not involved.
    const result = await runWithBrokenStdout(['bogus']);
    expect(result.code).toBe(2);
  }, 20_000);
});
