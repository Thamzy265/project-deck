/**
 * Tester probes for the adb runner's caps and timeouts (design review S9: every spawned
 * command has a timeout and is killed on expiry). Node stands in for adb.
 * Tests marked `it.fails` (DB-n) are repros of open tester findings: they turn into
 * plain `it` tests when the fix lands.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AdbOutputTooLargeError, isPackageName, isSerial, nodeAdb } from './adb.js';

const REAL_PROCESS_TIMEOUT_MS = 20_000;
const node = nodeAdb(process.execPath);
let dir: string | undefined;

afterEach(() => {
  if (dir === undefined) return;
  // Kill any child a probe left behind, then remove its folder.
  try {
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone, or never started.
  }
  rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const sleep = (ms: number) => new Promise<string>((r) => setTimeout(() => r('still waiting'), ms));

describe('nodeAdb caps and timeouts (tester probes)', { timeout: REAL_PROCESS_TIMEOUT_MS }, () => {
  it('DB-8: stops a command that ignores SIGTERM once its timeout passes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'deck-adb-'));
    const pidFile = join(dir, 'pid');
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
    const outcome = await Promise.race([
      node.execBinary(['-e', script], { timeoutMs: 500, maxBytes: 10 }).then(
        () => 'resolved',
        (err: unknown) => (err as Error).constructor.name,
      ),
      sleep(6000),
    ]);
    expect(outcome).toBe('AdbTimeoutError');
  });

  it('accepts output of exactly the cap, and refuses one byte more', async () => {
    const write = (n: number) => `process.stdout.write(Buffer.alloc(${n}, 65))`;
    const exact = await node.execBinary(['-e', write(4096)], { timeoutMs: 10_000, maxBytes: 4096 });
    expect(exact.length).toBe(4096);
    await expect(
      node.execBinary(['-e', write(4097)], { timeoutMs: 10_000, maxBytes: 4096 }),
    ).rejects.toBeInstanceOf(AdbOutputTooLargeError);
  });

  it('keeps at most 4 kB of stderr from a command that prints a lot of it', async () => {
    const err: unknown = await node
      .execBinary(['-e', 'process.stderr.write("e".repeat(1024 * 1024)); process.exit(1)'], {
        timeoutMs: 10_000,
        maxBytes: 10,
      })
      .catch((e: unknown) => e);
    expect((err as { stderr: string }).stderr.length).toBeLessThanOrEqual(4096);
  });
});

describe('adb argument checks (tester probes)', () => {
  it('refuses serials that are empty, too long, option-like or carry shell text', () => {
    for (const serial of [
      '',
      '-',
      '--help',
      'a'.repeat(65),
      'emulator-5554 ',
      'emulator-5554\r',
      'emulator-5554\u0000',
      'emu;lator',
      'emu|lator',
      'emu&lator',
      'emu>lator',
      'émulator',
      '../x',
    ]) {
      expect(isSerial(serial), JSON.stringify(serial)).toBe(false);
    }
    expect(isSerial('a'.repeat(64))).toBe(true);
    expect(isSerial('192.168.1.20:5555')).toBe(true);
    expect(isSerial('adb-R58M123ABC-xyz._adb-tls-connect._tcp')).toBe(true);
  });

  it('refuses package names with shell text, unicode or a trailing newline', () => {
    for (const pkg of [
      'com.example.shop\n',
      'com.example.shop\r',
      'com.example.shop;id',
      'com.example.$x',
      'com.exämple.shop',
      'com.example.shop:remote',
      'com.example.shop/..',
      'com. example',
    ]) {
      expect(isPackageName(pkg), JSON.stringify(pkg)).toBe(false);
    }
  });
});
