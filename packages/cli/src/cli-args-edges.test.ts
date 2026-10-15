/**
 * Argument parsing and exit codes of `runCli`. Exit 2 is a usage error, 1 a failed
 * command, 0 success. `it.fails` tests are repros of open bugs (BUG-CLI-Tn).
 */
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
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
let opened: string[];

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'deck-cli-argv-'));
  home = await mkdtemp(join(tmpdir(), 'deck-cli-argv-home-'));
  await mkdir(join(cwd, 'a'));
  await mkdir(join(cwd, 'b'));
  out = [];
  err = [];
  served = [];
  spawned = 0;
  opened = [];
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
    openBrowser: (url) => {
      opened.push(url);
      return true;
    },
    runMcp: (dir) => {
      served.push(dir);
      return Promise.resolve();
    },
  };
}

describe('runCli argument edges', () => {
  it('uses the last --project when it is given twice', async () => {
    expect(await runCli(['mcp', '--project', 'a', '--project', 'b'], deps())).toBe('serving');
    expect(served).toEqual([join(cwd, 'b')]);
  });

  it('accepts the --project=<folder> form', async () => {
    expect(await runCli(['mcp', '--project=a'], deps())).toBe('serving');
    expect(served).toEqual([join(cwd, 'a')]);
  });

  it.each([
    [['mcp', '--project']],
    [['mcp', '--project', '--browser']],
    [['mcp', '--no-project']],
    [['open', '--browser=false']],
    [['mcp', '-p', '.']],
    [['mcp', '--', 'x']],
    [['MCP']],
    [['--project', '.', 'mcp']],
    [['init', 'extra']],
  ])('exits 2 for %j and runs nothing', async (argv) => {
    expect(await runCli(argv, deps())).toBe(2);
    expect(err.length).toBeGreaterThan(0);
    expect(served).toEqual([]);
    expect(spawned).toBe(0);
    expect(opened).toEqual([]);
    expect(await readdir(cwd)).toEqual(['a', 'b']);
  });

  it('cuts a very long unknown command in its message', async () => {
    expect(await runCli(['x'.repeat(5000)], deps())).toBe(2);
    expect(err[0]?.length).toBeLessThan(100);
  });

  it('prints the version on stdout with exit 0', async () => {
    expect(await runCli(['--version'], deps())).toBe(0);
    expect(out).toHaveLength(1);
    expect(err).toEqual([]);
  });

  it('exits 1, not 2, when init finds no Flutter app', async () => {
    expect(await runCli(['init', '--project', 'a'], deps())).toBe(1);
    expect(await readdir(join(cwd, 'a'))).toEqual([]);
  });

  it('exits 2 for a --project that is a file', async () => {
    expect(await runCli(['stop', '--project', join(cwd, 'a', '..', 'nope.txt')], deps())).toBe(2);
  });

  // BUG-CLI-T9: an empty value (for example `--project="$DIR"` with DIR unset) silently
  // means the current folder, so init may set up the wrong folder.
  it.each([[['mcp', '--project=']], [['mcp', '--project', '']]])(
    'BUG-CLI-T9: refuses an empty --project in %j',
    async (argv) => {
      expect(await runCli(argv, deps())).toBe(2);
      expect(err).toContain('--project needs a folder');
      expect(served).toEqual([]);
    },
  );

  // BUG-CLI-T10: `<command> --help` is the usual way to ask for help.
  it.each([[['init', '--help']], [['stop', '-h']], [['open', '--project', '.', '--help']]])(
    'BUG-CLI-T10: prints usage with exit 0 for %j',
    async (argv) => {
      expect(await runCli(argv, deps())).toBe(0);
      expect(out[0]).toContain('Usage:');
      expect(served).toEqual([]);
      expect(spawned).toBe(0);
    },
  );
});
