import { describe, expect, it } from 'vitest';
import type { RunTool, Tool } from './prerequisites.js';
import { checkPrerequisites, formatPrerequisites, isAllowedCommand } from './prerequisites.js';

function runner(outputs: Partial<Record<Tool, string | Error>>): {
  run: RunTool;
  calls: string[];
} {
  const calls: string[] = [];
  const run: RunTool = (tool, args) => {
    calls.push([tool, ...args].join(' '));
    const out = outputs[tool];
    if (out === undefined) return Promise.reject(new Error('not found'));
    return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
  };
  return { run, calls };
}

const DART = 'Dart SDK version: 3.9.2 (stable) (Wed Aug 27 2025) on "macos_arm64"\n';
const FLUTTER =
  'Flutter 3.35.2 • channel stable • https://github.com/flutter/flutter.git\nFramework • revision 05db968908\nTools • Dart 3.9.0 • DevTools 2.48.0\n';
const ADB = 'Android Debug Bridge version 1.0.41\nVersion 36.0.0-13206524\nInstalled as /x/adb\n';

describe('checkPrerequisites', () => {
  it('runs only the three fixed commands with fixed arguments', async () => {
    const { run, calls } = runner({ dart: DART, flutter: FLUTTER, adb: ADB });
    await checkPrerequisites(run);
    expect(calls.sort()).toEqual(['adb version', 'dart --version', 'flutter --version']);
  });

  it('reports versions and that Dart is new enough', async () => {
    const { run } = runner({ dart: DART, flutter: FLUTTER, adb: ADB });
    expect(await checkPrerequisites(run)).toEqual([
      { tool: 'dart', found: true, version: '3.9.2' },
      { tool: 'flutter', found: true, version: '3.35.2' },
      { tool: 'adb', found: true, version: '1.0.41' },
    ]);
  });

  it('says when Dart is older than 3.9, which the Dart MCP server needs', async () => {
    const { run } = runner({
      dart: 'Dart SDK version: 3.8.1 (stable)',
      flutter: FLUTTER,
      adb: ADB,
    });
    const [dart] = await checkPrerequisites(run);
    expect(dart).toMatchObject({ found: true, version: '3.8.1' });
    expect(dart?.note).toContain('3.9');
  });

  it('reports missing tools and never throws', async () => {
    const { run } = runner({ dart: new Error('ENOENT') });
    const result = await checkPrerequisites(run);
    expect(result.every((p) => !p.found)).toBe(true);
    expect(formatPrerequisites(result).join('\n')).toContain('missing');
  });

  it('keeps a found tool whose version it can’t read as found, without a version', async () => {
    const { run } = runner({ dart: DART, flutter: 'Welcome to Flutter!', adb: ADB });
    const result = await checkPrerequisites(run);
    expect(result[1]).toEqual({ tool: 'flutter', found: true });
  });

  it('never repeats tool output beyond a version number', async () => {
    const { run } = runner({
      dart: 'Dart SDK version: 3.9.2; rm -rf ~',
      flutter: FLUTTER,
      adb: ADB,
    });
    const lines = formatPrerequisites(await checkPrerequisites(run)).join('\n');
    expect(lines).not.toContain('rm -rf');
  });
});

describe('isAllowedCommand', () => {
  it('accepts only the three fixed pairs', () => {
    expect(isAllowedCommand('dart', ['--version'])).toBe(true);
    expect(isAllowedCommand('flutter', ['--version'])).toBe(true);
    expect(isAllowedCommand('adb', ['version'])).toBe(true);
  });

  it.each([
    ['sh', ['-c', 'id']],
    ['dart', []],
    ['dart', ['--version', '--verbose']],
    ['adb', ['--version']],
    ['constructor', []],
    ['toString', []],
  ])('refuses %s %j', (tool, args) => {
    expect(isAllowedCommand(tool, args)).toBe(false);
  });
});
