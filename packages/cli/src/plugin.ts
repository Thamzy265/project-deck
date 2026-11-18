/**
 * How users get the Pitdeck plugin (M5 D2, D3): the public marketplace in this GitHub
 * repo, and the pinned release that its `.mcp.json` starts. `init` prints these; a test
 * keeps them equal to plugin/.mcp.json and .claude-plugin/marketplace.json.
 */
import { CLI_NAME } from './name.js';

export const MARKETPLACE_REPO = 'Thamzy265/project-deck';
export const MARKETPLACE_NAME = 'pitdeck';
export const PLUGIN_NAME = 'pitdeck';

/**
 * The Pitdeck MCP server as `.mcp.json` declares it: the published package at one exact
 * version through npx (ADR 0007), never a file path, which would point into npm's cache.
 */
export function pitdeckMcpServer(version: string): {
  type: 'stdio';
  command: 'npx';
  args: string[];
} {
  return { type: 'stdio', command: 'npx', args: ['-y', `${CLI_NAME}@${version}`, 'mcp'] };
}
