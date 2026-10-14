import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import { describe, expect, it } from 'vitest';
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
});
