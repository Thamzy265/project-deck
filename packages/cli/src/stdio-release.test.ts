/**
 * `mcp` serving must run without the stdio guard (stdout belongs to the JSON-RPC
 * transport); every other command keeps it. Observed from outside with a preload that
 * counts the 'error' listeners at exit. No daemon, no network.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));
// `--import` takes a URL: a raw absolute path fails on Windows (drive letter as scheme).
const PRELOAD = new URL('./testing/count-error-listeners.mjs', import.meta.url).href;

let scratch: string;
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'deck-cli-release-'));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function listeners(args: string[]): Promise<{ out: number; err: number }> {
  // stdin at EOF ends `mcp` at once; the scratch folder is not set up, so it starts nothing.
  const child = spawn(process.execPath, ['--import', PRELOAD, MAIN, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { HOME: scratch, USERPROFILE: scratch, PATH: '' },
  });
  child.on('error', () => undefined);
  child.stdout.on('error', () => undefined).resume();
  let stderr = '';
  child.stderr.on('error', () => undefined).on('data', (d: Buffer) => (stderr += String(d)));
  await once(child, 'close');
  const m = /LISTENERS out=(\d+) err=(\d+)/.exec(stderr);
  if (m === null) throw new Error(`no listener count in: ${stderr}`);
  return { out: Number(m[1]), err: Number(m[2]) };
}

describe('main.js stdio guard', () => {
  it('keeps the guard for a command that finishes', async () => {
    const counts = await listeners(['--version']);
    expect(counts.out).toBeGreaterThan(0);
    expect(counts.err).toBeGreaterThan(0);
  }, 20_000);

  it('releases the guard when `mcp` serves', async () => {
    expect(await listeners(['mcp', '--project', scratch])).toEqual({ out: 0, err: 0 });
  }, 20_000);
});
