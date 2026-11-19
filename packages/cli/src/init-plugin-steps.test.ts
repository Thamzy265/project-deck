/**
 * The plugin lines in `init`'s next steps (M5 batch 3, D2/D3; reviewer F9 of batch 2).
 * Whatever folder the CLI runs from (npx cache, a project's node_modules, a checkout),
 * init prints the public install commands and an `.mcp.json` that starts the pinned
 * release through npx: never a file path, so it can't point at a cache that npm cleans.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DECK_VERSION } from '@project-deck/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InitOptions } from './init.js';
import { runInit } from './init.js';
import { MARKETPLACE_NAME, MARKETPLACE_REPO, PLUGIN_NAME, pitdeckMcpServer } from './plugin.js';
import type { RunTool } from './prerequisites.js';

const PUBSPEC = 'name: shop_app\ndependencies:\n  flutter:\n    sdk: flutter\n';
const REPO = join(import.meta.dirname, '..', '..', '..');

let project: string;
let home: string;
let lines: string[];

const tools: RunTool = () => Promise.resolve('version 1');

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'deck-cli-steps-'));
  home = await mkdtemp(join(tmpdir(), 'deck-cli-steps-home-'));
  await writeFile(join(project, 'pubspec.yaml'), PUBSPEC);
  lines = [];
});

afterEach(async () => {
  for (const dir of [project, home]) await rm(dir, { recursive: true, force: true });
});

function init(opts: Partial<InitOptions> = {}): Promise<number> {
  return runInit({
    projectDir: project,
    homeDir: home,
    run: tools,
    isFree: () => Promise.resolve(true),
    io: { out: (l) => lines.push(l), err: () => undefined },
    ...opts,
  });
}

const snippet = (text: string): unknown =>
  JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));

describe('init next steps for the plugin', () => {
  it('prints the public marketplace and install commands', async () => {
    expect(await init()).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('claude plugin marketplace add Thamzy265/project-deck');
    expect(text).toContain('claude plugin install pitdeck@pitdeck');
    // The raw MCP config stays, for use without the plugin or with other agents.
    expect(text.indexOf('claude plugin install')).toBeLessThan(text.indexOf('"mcpServers"'));
  });

  it('prints an .mcp.json that starts the pinned release through npx', async () => {
    await init();
    expect(snippet(lines.join('\n'))).toEqual({
      mcpServers: {
        dart: { type: 'stdio', command: 'dart', args: ['mcp-server'] },
        pitdeck: { type: 'stdio', command: 'npx', args: ['-y', `pitdeck@${DECK_VERSION}`, 'mcp'] },
      },
    });
  });

  it('tells npx users how to start the dashboard, without pitdeck on the PATH', async () => {
    await init();
    const steps = lines.slice(lines.indexOf('Next steps:')).join('\n');
    expect(steps).toContain(`Start the dashboard: npx -y pitdeck@${DECK_VERSION} start`);
    expect(steps).not.toContain('dashboard: pitdeck start');
  });

  it('prints no file path at all: no npx cache, node_modules or checkout path', async () => {
    await init();
    const steps = lines.slice(lines.indexOf('Next steps:')).join('\n');
    expect(steps).not.toMatch(/_npx|node_modules|packages\/|\.js\b|[\\/]Users[\\/]|[A-Z]:\\/);
    expect(steps).not.toContain(project);
    expect(steps).not.toContain(home);
    expect(steps).not.toContain('pitdeck-dev');
  });

  it('prints the same .mcp.json server as the plugin ships', () => {
    const plugin = JSON.parse(readFileSync(join(REPO, 'plugin', '.mcp.json'), 'utf8')) as {
      mcpServers: { pitdeck: unknown };
    };
    expect(plugin.mcpServers.pitdeck).toEqual(pitdeckMcpServer(DECK_VERSION));
  });

  it('names the marketplace and plugin that the repo publishes', () => {
    const market = JSON.parse(
      readFileSync(join(REPO, '.claude-plugin', 'marketplace.json'), 'utf8'),
    ) as { name: string; plugins: { name: string; source: { url?: string } }[] };
    expect(market.name).toBe(MARKETPLACE_NAME);
    expect(market.plugins.map((p) => p.name)).toEqual([PLUGIN_NAME]);
    expect(market.plugins[0]?.source.url).toBe(MARKETPLACE_REPO);
  });
});
