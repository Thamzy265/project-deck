import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SpawnFn } from './spawn.js';
import { daemonMainPath, spawnDaemon } from './spawn.js';

describe('spawnDaemon', () => {
  it('finds the built daemon entry through the package, not PATH', () => {
    const path = daemonMainPath();
    expect(path.endsWith(['daemon', 'dist', 'main.js'].join(sep))).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it('runs node on the daemon entry, detached and quiet, and lets go of it', () => {
    const calls: { command: string; args: readonly string[]; options: object }[] = [];
    let unrefs = 0;
    const child = Object.assign(new EventEmitter(), {
      unref: () => {
        unrefs++;
      },
    });
    const spawn: SpawnFn = (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    };
    const errors: unknown[] = [];
    spawnDaemon('/work/shop app', { spawn, onError: (err) => errors.push(err) });
    expect(calls).toEqual([
      {
        command: process.execPath,
        args: [daemonMainPath(), '--project', '/work/shop app'],
        options: { detached: true, windowsHide: true, stdio: 'ignore', shell: false },
      },
    ]);
    expect(unrefs).toBe(1);
    // A failed spawn arrives as an 'error' event; it must not crash the server.
    child.emit('error', new Error('spawn EACCES'));
    expect(errors).toHaveLength(1);
  });

  it('sends the daemon errors to a private .flutterdeck/daemon.log, new at each start', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deck-spawn-'));
    try {
      await mkdir(join(dir, '.flutterdeck'));
      const log = join(dir, '.flutterdeck', 'daemon.log');
      await writeFile(log, 'old run\n', { mode: 0o644 });
      let stdio: unknown;
      const child = Object.assign(new EventEmitter(), { unref: () => undefined });
      const spawn: SpawnFn = (_command, _args, options) => {
        stdio = options.stdio;
        return child;
      };
      let exit: number | null | undefined;
      spawnDaemon(dir, { spawn, onExit: (code) => (exit = code) });
      expect(Array.isArray(stdio)).toBe(true);
      const [stdin, stdout, stderr] = stdio as unknown[];
      expect(stdin).toBe('ignore');
      // Only errors: the daemon's stdout (its address, where the token file is) is dropped.
      expect(stdout).toBe('ignore');
      expect(typeof stderr).toBe('number');
      expect(await readFile(log, 'utf8')).toBe('');
      if (process.platform !== 'win32') expect((await stat(log)).mode & 0o777).toBe(0o600);
      child.emit('exit', 3);
      expect(exit).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe('a daemon.log planted by a cloned repository', () => {
    const links = process.platform === 'win32' ? it.skip : it;
    let dir: string;
    let log: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'deck-spawn-link-'));
      await mkdir(join(dir, '.flutterdeck'));
      log = join(dir, '.flutterdeck', 'daemon.log');
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    function start(): unknown {
      let stdio: unknown;
      const child = Object.assign(new EventEmitter(), { unref: () => undefined });
      spawnDaemon(dir, {
        spawn: (_command, _args, options) => {
          stdio = options.stdio;
          return child;
        },
      });
      return stdio;
    }

    links('is replaced, never followed: the linked file keeps its content and mode', async () => {
      const target = join(dir, 'users-file');
      await writeFile(target, 'precious\n', { mode: 0o644 });
      await symlink(target, log);
      const stdio = start();
      expect(await readFile(target, 'utf8')).toBe('precious\n');
      expect((await stat(target)).mode & 0o777).toBe(0o644);
      expect((await lstat(log)).isFile()).toBe(true);
      expect(Array.isArray(stdio)).toBe(true);
    });

    links('is replaced when it is a dangling link, which is never created', async () => {
      const target = join(dir, 'not-there');
      await symlink(target, log);
      start();
      await expect(access(target)).rejects.toThrow();
      expect((await lstat(log)).isFile()).toBe(true);
    });

    it('is left alone when it is a folder, and the daemon still starts', async () => {
      await mkdir(log);
      expect(start()).toBe('ignore');
      expect((await lstat(log)).isDirectory()).toBe(true);
    });
  });
});
