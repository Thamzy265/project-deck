/**
 * The `flutterdeck` command line: parses the arguments and runs one command. Returns the
 * exit code, or 'serving' for `mcp`, which keeps running until Claude closes stdin.
 */
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DECK_VERSION } from '@project-deck/core';
import type { DaemonClientOptions } from '@project-deck/mcp';
import { runOpen, runStart, runStop } from './daemon-commands.js';
import { runInit } from './init.js';
import type { Io } from './io.js';
import { messageOf } from './io.js';
import { CLI_NAME } from './name.js';
import type { RunTool } from './prerequisites.js';

export interface CliDeps {
  io: Io;
  cwd: string;
  homeDir: string;
  run: RunTool;
  mcpMainPath: string;
  spawnDaemon: DaemonClientOptions['spawnDaemon'];
  openBrowser: (url: string) => boolean;
  runMcp: (projectDir: string) => Promise<void>;
}

export const USAGE = [
  `Usage: ${CLI_NAME} <command> [--project <folder>]`,
  '',
  'Commands:',
  '  init     Set up this Flutter project: config, .gitignore, Claude Desktop launch.json',
  "  start    Start the project's dashboard daemon in the background",
  '  stop     Stop it',
  '  open     Let the dashboard log in again and print its address',
  '           (--browser also opens it in the default browser)',
  '  mcp      Run the FlutterDeck MCP server over stdio (for Claude)',
  '',
  '--project defaults to the current folder.',
];

const COMMANDS = ['init', 'start', 'stop', 'open', 'mcp'] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(name: string | undefined): name is Command {
  return COMMANDS.some((c) => c === name);
}

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number | 'serving'> {
  const { io } = deps;
  const [command, ...rest] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    for (const line of USAGE) (command === undefined ? io.err : io.out)(line);
    return command === undefined ? 2 : 0;
  }
  if (command === '--version' || command === 'version') {
    io.out(DECK_VERSION);
    return 0;
  }
  if (!isCommand(command)) {
    io.err(`Unknown command: ${command.slice(0, 40)}`);
    for (const line of USAGE) io.err(line);
    return 2;
  }

  let values: { project?: string | undefined; browser?: boolean | undefined };
  try {
    ({ values } = parseArgs({
      args: [...rest],
      options: {
        project: { type: 'string' },
        // Only `open` takes it. Printing the address is the default: in Claude Desktop the
        // dashboard opens in the Browser pane, not the default browser.
        browser: { type: 'boolean' },
      },
      allowNegative: true,
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    io.err(messageOf(err));
    return 2;
  }
  if (command !== 'open' && values.browser !== undefined) {
    io.err(`--browser is an option of \`${CLI_NAME} open\` only`);
    return 2;
  }

  // An empty value (`--project="$DIR"` with DIR unset) must not mean the current folder.
  if (values.project?.trim() === '') {
    io.err('--project needs a folder');
    return 2;
  }
  const projectDir = resolve(deps.cwd, values.project ?? '.');
  if (!(await isFolder(projectDir))) {
    io.err(`No folder at ${projectDir}`);
    return 2;
  }

  const daemon = { projectDir, io, spawnDaemon: deps.spawnDaemon };
  switch (command) {
    case 'init':
      return runInit({
        projectDir,
        homeDir: deps.homeDir,
        run: deps.run,
        mcpMainPath: deps.mcpMainPath,
        io,
      });
    case 'start':
      return runStart(daemon);
    case 'stop':
      return runStop(daemon);
    case 'open':
      return runOpen({
        ...daemon,
        browser: values.browser ?? false,
        openBrowser: deps.openBrowser,
      });
    case 'mcp':
      await deps.runMcp(projectDir);
      return 'serving';
  }
}

async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
