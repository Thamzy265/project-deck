#!/usr/bin/env node
/**
 * Pitdeck MCP server over stdio, for the project in the current folder:
 *   node packages/mcp/dist/main.js [--project <dir>]
 * The same server as `pitdeck mcp` (see run.ts).
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runMcpServer } from './run.js';

const { values } = parseArgs({
  options: { project: { type: 'string', default: process.cwd() } },
});
await runMcpServer(resolve(values.project));
