import { describe, expect, it } from 'vitest';
import { AdbExitError, AdbOutputTooLargeError, AdbTimeoutError, nodeAdb } from './adb.js';
import { FakeAdb } from './testing/fake-adb.js';
import { FIXTURE_PACKAGE, FIXTURE_SERIAL, RUN_AS_NOT_DEBUGGABLE } from './testing/fixtures.js';

/** A cold Node start on busy CI can take seconds. */
const REAL_PROCESS_TIMEOUT_MS = 15_000;

describe('nodeAdb execBinary', { timeout: REAL_PROCESS_TIMEOUT_MS }, () => {
  const node = nodeAdb(process.execPath);

  it('returns stdout as bytes, unchanged', async () => {
    const out = await node.execBinary(
      ['-e', 'process.stdout.write(Buffer.from([0, 255, 83, 81, 0]))'],
      { timeoutMs: 10_000, maxBytes: 100 },
    );
    expect([...out]).toEqual([0, 255, 83, 81, 0]);
  });

  it('kills the command and rejects when the output passes the cap', async () => {
    await expect(
      node.execBinary(['-e', 'setInterval(() => process.stdout.write("x".repeat(4096)), 1)'], {
        timeoutMs: 10_000,
        maxBytes: 64 * 1024,
      }),
    ).rejects.toBeInstanceOf(AdbOutputTooLargeError);
  });

  it('kills the command and rejects when it runs past its timeout', async () => {
    const started = Date.now();
    await expect(
      node.execBinary(['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 300, maxBytes: 10 }),
    ).rejects.toBeInstanceOf(AdbTimeoutError);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('rejects a failing command with its exit code and the start of its stderr', async () => {
    const err: unknown = await node
      .execBinary(
        ['-e', 'process.stderr.write("run-as: package not debuggable"); process.exit(1)'],
        {
          timeoutMs: 10_000,
          maxBytes: 10,
        },
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdbExitError);
    expect((err as AdbExitError).code).toBe(1);
    expect((err as AdbExitError).stderr).toBe('run-as: package not debuggable');
  });
});

describe('nodeAdb exec with a per-call timeout', { timeout: REAL_PROCESS_TIMEOUT_MS }, () => {
  it('uses the timeout the caller gives', async () => {
    const node = nodeAdb(process.execPath, { timeoutMs: 60_000 });
    await expect(
      node.exec(['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 300 }),
    ).rejects.toBeInstanceOf(AdbTimeoutError);
  });
});

describe('FakeAdb run-as files', () => {
  const db = Buffer.from('SQLite format 3\0rest');
  const adb = new FakeAdb({
    files: {
      [FIXTURE_SERIAL]: {
        [FIXTURE_PACKAGE]: { 'app_flutter/app.sqlite': db, 'app_flutter/notes.txt': 'hi' },
      },
    },
  });
  const runAs = ['-s', FIXTURE_SERIAL, 'exec-out', 'run-as', FIXTURE_PACKAGE];

  it('lists a folder and serves a file with cat and head', async () => {
    expect(await adb.exec([...runAs, 'ls', '-1', 'app_flutter'])).toBe('app.sqlite\nnotes.txt\n');
    expect(await adb.exec([...runAs, 'ls', '-1', 'databases'])).toBe('');
    const opts = { timeoutMs: 1000, maxBytes: 1000 };
    expect(await adb.execBinary([...runAs, 'cat', '--', 'app_flutter/app.sqlite'], opts)).toEqual(
      db,
    );
    expect(
      await adb.execBinary([...runAs, 'head', '-c', '6', '--', 'app_flutter/app.sqlite'], opts),
    ).toEqual(db.subarray(0, 6));
  });

  it('answers like run-as for an app that is not debuggable', async () => {
    const release = new FakeAdb({
      files: { [FIXTURE_SERIAL]: { [FIXTURE_PACKAGE]: 'not-debuggable' } },
    });
    const err: unknown = await release
      .exec([...runAs, 'ls', '-1', 'app_flutter'])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdbExitError);
    expect((err as AdbExitError).stderr).toBe(RUN_AS_NOT_DEBUGGABLE);
  });
});
