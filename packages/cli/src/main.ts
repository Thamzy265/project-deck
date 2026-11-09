#!/usr/bin/env node
/**
 * `flutterdeck` (working name; see name.ts). Until the npm release:
 *   node packages/cli/dist/main.js <command> [--project <folder>]
 */
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { runMcpServer, spawnDaemon } from '@project-deck/mcp';
import { openBrowser } from './browser.js';
import { runCli } from './cli.js';
import { runTool } from './prerequisites.js';
import { createStdIo } from './stdio-io.js';

// Only the commands that finish get the guard. `mcp` serving owns stdout for JSON-RPC and
// must behave exactly as before, so its start releases the streams (`mcp --help` and
// usage errors never get there and keep the guard).
const std = createStdIo(process.stdout, process.stderr);
const { io } = std;

const result = await runCli(process.argv.slice(2), {
  io,
  cwd: process.cwd(),
  homeDir: homedir(),
  run: runTool,
  // This file: init prints `node <it> mcp` for .mcp.json.
  cliMainPath: fileURLToPath(import.meta.url),
  spawnDaemon: (dir, onExit) =>
    spawnDaemon(dir, {
      onError: (err) => io.err(`Couldn't start the daemon: ${err.message}`),
      onExit,
    }),
  openBrowser,
  runMcp: (dir) => {
    std.release();
    return runMcpServer(dir);
  },
});
// exitCode rather than exit(): output written to a pipe is flushed first.
// Wait for the last writes to land: a write error is reported after the call returns.
await std.flush();
if (result !== 'serving') process.exitCode = result === 0 && std.failed() ? 1 : result;
