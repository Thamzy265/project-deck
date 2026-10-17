/**
 * runTool with child_process mocked: which program, which arguments, which folder, and
 * when a shell is used. On Windows `dart` and `flutter` are .bat files that need
 * cmd.exe, so only fixed text may reach it. `it.fails` marks a repro (BUG-CLI-T11).
 */
import { homedir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Call {
  file: string;
  args: readonly string[];
  options: { cwd?: string; shell?: boolean | string; timeout?: number };
}

const calls: Call[] = [];

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: readonly string[],
    options: Call['options'],
    callback: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    calls.push({ file, args, options });
    queueMicrotask(() => callback(null, 'out', ''));
    return { on: () => undefined };
  },
}));

vi.mock('@project-deck/android-adb', () => ({
  resolveAdbPath: () => '/sdk/platform-tools/adb',
}));

const { runTool, checkPrerequisites } = await import('./prerequisites.js');

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

beforeEach(() => {
  calls.length = 0;
});

afterEach(() => {
  setPlatform(realPlatform);
});

describe('runTool', () => {
  it('on Windows runs dart and flutter through the shell with fixed arguments only', async () => {
    setPlatform('win32');
    await checkPrerequisites(runTool);
    const byFile = Object.fromEntries(calls.map((c) => [c.file, c]));
    expect(byFile.dart?.args).toEqual(['--version']);
    expect(byFile.dart?.options.shell).toBe(true);
    expect(byFile.flutter?.args).toEqual(['--version']);
    expect(byFile.flutter?.options.shell).toBe(true);
    // adb is an .exe, found by absolute path: never a shell.
    expect(byFile['/sdk/platform-tools/adb']?.args).toEqual(['version']);
    expect(byFile['/sdk/platform-tools/adb']?.options.shell).toBe(false);
  });

  it('never uses a shell outside Windows', async () => {
    setPlatform('linux');
    await checkPrerequisites(runTool);
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.options.shell).toBe(false);
  });

  it('runs every tool from the home folder, never the project, with a timeout', async () => {
    setPlatform('win32');
    await checkPrerequisites(runTool);
    for (const call of calls) {
      expect(call.options.cwd).toBe(homedir());
      expect(call.options.timeout).toBeGreaterThan(0);
    }
  });

  // BUG-CLI-T11: runTool passes any arguments to cmd.exe on Windows. Today only fixed
  // constants reach it, but nothing stops a later caller; CLAUDE.md asks for arguments
  // validated against strict patterns.
  it('BUG-CLI-T11: refuses arguments other than the fixed version flags', async () => {
    setPlatform('win32');
    const injected = ['--version', '&', 'calc'].join(' ');
    await expect(runTool('dart', [injected])).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
