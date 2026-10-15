/**
 * What `init` reports about the tools FlutterDeck uses. It runs three fixed commands
 * with fixed arguments and never fails because of them: a missing tool is a line in the
 * report. Only a version number is taken from their output.
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { resolveAdbPath } from '@project-deck/logs-android';

export type Tool = 'dart' | 'flutter' | 'adb';
/** Runs one tool and returns stdout and stderr together; rejects when it can't. */
export type RunTool = (tool: Tool, args: readonly string[]) => Promise<string>;

export interface Prerequisite {
  tool: Tool;
  found: boolean;
  version?: string;
  note?: string;
}

/** The Dart MCP server needs Dart 3.9 or newer. */
const MIN_DART: readonly [number, number] = [3, 9];

/**
 * The only commands `runTool` runs. On Windows dart and flutter go through cmd.exe, so
 * nothing but these fixed arguments may ever reach it.
 */
export const ALLOWED_COMMANDS: Readonly<Record<Tool, readonly string[]>> = {
  dart: ['--version'],
  flutter: ['--version'],
  adb: ['version'],
};

const CHECKS: readonly { tool: Tool; args: readonly string[]; version: RegExp }[] = [
  { tool: 'dart', args: ALLOWED_COMMANDS.dart, version: /Dart SDK version:\s*(\d+\.\d+\.\d+)/ },
  { tool: 'flutter', args: ALLOWED_COMMANDS.flutter, version: /^Flutter\s+(\d+\.\d+\.\d+)/m },
  {
    tool: 'adb',
    args: ALLOWED_COMMANDS.adb,
    version: /Android Debug Bridge version\s+(\d+\.\d+\.\d+)/,
  },
];

/** Exactly one of the allowed (command, arguments) pairs. */
export function isAllowedCommand(tool: string, args: readonly string[]): tool is Tool {
  if (!Object.hasOwn(ALLOWED_COMMANDS, tool)) return false;
  const allowed = ALLOWED_COMMANDS[tool as Tool];
  return args.length === allowed.length && args.every((arg, i) => arg === allowed[i]);
}

const MISSING_NOTE: Record<Tool, string> = {
  dart: 'needed for the Dart MCP server (hot reload for Claude)',
  flutter: 'needed to run your app',
  adb: 'needed for Android native logs (Android SDK platform-tools)',
};

export async function checkPrerequisites(run: RunTool): Promise<Prerequisite[]> {
  return Promise.all(
    CHECKS.map(async ({ tool, args, version }): Promise<Prerequisite> => {
      let output: string;
      try {
        output = await run(tool, args);
      } catch {
        return { tool, found: false, note: MISSING_NOTE[tool] };
      }
      const found = version.exec(output)?.[1];
      if (found === undefined) return { tool, found: true };
      const result: Prerequisite = { tool, found: true, version: found };
      if (tool === 'dart' && olderThan(found, MIN_DART)) {
        result.note = `the Dart MCP server needs Dart ${MIN_DART.join('.')} or newer`;
      }
      return result;
    }),
  );
}

function olderThan(version: string, min: readonly [number, number]): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major < min[0] || (major === min[0] && minor < min[1]);
}

export function formatPrerequisites(list: readonly Prerequisite[]): string[] {
  return list.map((p) => {
    const state = p.found ? `found${p.version === undefined ? '' : ` ${p.version}`}` : 'missing';
    return `  ${p.tool.padEnd(8)}${state}${p.note === undefined ? '' : ` (${p.note})`}`;
  });
}

const TIMEOUT_MS: Record<Tool, number> = { dart: 15_000, flutter: 60_000, adb: 10_000 };

/**
 * The real tools, run from the home folder so a `dart.bat` planted in a cloned project
 * can't stand in for the SDK (cmd.exe looks in the current folder first). `dart` and
 * `flutter` are .bat files on Windows, which only start through a shell; the arguments
 * must be one of ALLOWED_COMMANDS, checked before anything starts. adb is found the way the daemon finds it.
 */
export const runTool: RunTool = (tool, args) => {
  if (!isAllowedCommand(tool, args)) {
    return Promise.reject(new Error('Refused: not one of the fixed prerequisite commands'));
  }
  const file = tool === 'adb' ? resolveAdbPath() : tool;
  if (file === undefined) return Promise.reject(new Error('adb not found'));
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        cwd: homedir(),
        shell: tool !== 'adb' && process.platform === 'win32',
        windowsHide: true,
        timeout: TIMEOUT_MS[tool],
        maxBuffer: 1_048_576,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (err === null) resolve(`${stdout}\n${stderr}`);
        else reject(new Error(err.message, { cause: err }));
      },
    );
    // The callback reports spawn errors; this keeps the emitter's from being unhandled.
    child.on('error', () => undefined);
  });
};
