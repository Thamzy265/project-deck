#!/usr/bin/env node
/**
 * `flutterdeck` (working name; see name.ts). Until the npm release:
 *   node packages/cli/dist/main.js <command> [--project <folder>]
 */
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { runMcpServer, spawnDaemon } from '@project-deck/mcp';
import { openBrowser } from './browser.js';
import { runCli } from './cli.js';
import type { Io } from './io.js';
import { runTool } from './prerequisites.js';

const io: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

const result = await runCli(process.argv.slice(2), {
  io,
  cwd: process.cwd(),
  homeDir: homedir(),
  run: runTool,
  // Only the path is resolved; it is printed for .mcp.json.
  mcpMainPath: createRequire(import.meta.url).resolve('@project-deck/mcp/main'),
  spawnDaemon: (dir, onExit) =>
    spawnDaemon(dir, {
      onError: (err) => io.err(`Couldn't start the daemon: ${err.message}`),
      onExit,
    }),
  openBrowser,
  runMcp: runMcpServer,
});
// exitCode rather than exit(): output written to a pipe is flushed first.
if (result !== 'serving') process.exitCode = result;
