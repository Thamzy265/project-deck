import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliDeps } from './cli.js';
import { runCli } from './cli.js';

let cwd: string;
let home: string;
let out: string[];
let err: string[];
let served: string[];
let spawned: number;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'deck-cli-args-'));
  home = await mkdtemp(join(tmpdir(), 'deck-cli-args-home-'));
  out = [];
  err = [];
  served = [];
  spawned = 0;
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

function deps(): CliDeps {
  return {
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    cwd,
    homeDir: home,
    run: () => Promise.reject(new Error('not installed')),
    cliMainPath: '/x/main.js',
    spawnDaemon: () => {
      spawned++;
    },
    openBrowser: () => true,
    runMcp: (dir) => {
      served.push(dir);
      return Promise.resolve();
    },
  };
}

describe('runCli', () => {
  it('prints usage for help (exit 0) and for no command (exit 2)', async () => {
    expect(await runCli(['--help'], deps())).toBe(0);
    expect(out[0]).toContain('Usage: flutterdeck');
    expect(await runCli([], deps())).toBe(2);
    expect(err[0]).toContain('Usage: flutterdeck');
  });

  it('refuses an unknown command or option', async () => {
    expect(await runCli(['deploy'], deps())).toBe(2);
    expect(await runCli(['init', '--force'], deps())).toBe(2);
    expect(await runCli(['stop', 'extra'], deps())).toBe(2);
    // --browser belongs to open only.
    expect(await runCli(['start', '--browser'], deps())).toBe(2);
  });

  it('refuses a --project that is not a folder', async () => {
    expect(await runCli(['stop', '--project', join(cwd, 'nope')], deps())).toBe(2);
    expect(err.join('\n')).toContain('No folder');
  });

  it('resolves --project against the current folder', async () => {
    expect(await runCli(['mcp', '--project', '.'], deps())).toBe('serving');
    expect(served).toEqual([cwd]);
  });

  it('runs init in the current folder', async () => {
    await writeFile(
      join(cwd, 'pubspec.yaml'),
      'name: a\ndependencies:\n  flutter:\n    sdk: flutter\n',
    );
    expect(await runCli(['init'], deps())).toBe(0);
    expect(out.join('\n')).toContain('FlutterDeck init in');
  });

  it('accepts --browser and --no-browser for open', async () => {
    // No daemon here: both fail the same way, after parsing.
    expect(await runCli(['open', '--browser'], deps())).toBe(1);
    expect(await runCli(['open', '--no-browser'], deps())).toBe(1);
    expect(spawned).toBe(0);
  });
});
