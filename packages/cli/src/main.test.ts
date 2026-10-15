/**
 * The built entrypoint as a process (CI builds first), with its own scratch HOME so it
 * never sees the user's port registry.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));

let project: string;
let home: string;
let client: Client | undefined;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'deck-cli-main-'));
  home = await mkdtemp(join(tmpdir(), 'deck-cli-main-home-'));
});

afterEach(async () => {
  await client?.close();
  client = undefined;
  await rm(project, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [MAIN, ...args],
      // PATH empty: the prerequisite checks find no tools, as on a bare machine.
      { env: { HOME: home, USERPROFILE: home, PATH: '' }, timeout: 20_000 },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === 'number' ? err.code : -1;
        resolve({ code, stdout, stderr });
      },
    );
    child.on('error', () => undefined);
  });
}

describe('main.js', () => {
  it('runs init for --project and exits 0', async () => {
    await writeFile(
      join(project, 'pubspec.yaml'),
      'name: shop_app\ndependencies:\n  flutter:\n    sdk: flutter\n',
    );
    const result = await run(['init', '--project', project]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Changes:');
    // The snippet is JSON, so a Windows path shows with escaped backslashes: parse it.
    const out = result.stdout;
    const snippet = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) as {
      mcpServers: { flutterdeck: { command: string; args: string[] } };
    };
    const { command, args } = snippet.mcpServers.flutterdeck;
    expect(command).toBe('node');
    expect(args).toHaveLength(2);
    expect(args[0]?.endsWith(join('packages', 'cli', 'dist', 'main.js'))).toBe(true);
    expect(args[1]).toBe('mcp');
    const config = JSON.parse(
      await readFile(join(project, '.flutterdeck', 'config.json'), 'utf8'),
    ) as { port: number };
    expect(config.port).toBeGreaterThanOrEqual(9147);
    // The registry went to the scratch HOME.
    await readFile(join(home, '.flutterdeck', 'ports.json'), 'utf8');
  }, 30_000);

  it('runs three init processes at once into one block and one entry (BUG-CLI-T1)', async () => {
    await writeFile(
      join(project, 'pubspec.yaml'),
      'name: shop_app\ndependencies:\n  flutter:\n    sdk: flutter\n',
    );
    await writeFile(join(project, '.gitignore'), 'build/\n');
    const results = await Promise.all([1, 2, 3].map(() => run(['init', '--project', project])));
    expect(results.map((r) => r.code)).toEqual([0, 0, 0]);
    const ignore = await readFile(join(project, '.gitignore'), 'utf8');
    expect(ignore.split('\n').filter((l) => l.startsWith('# >>> flutterdeck'))).toHaveLength(1);
    const launch = JSON.parse(await readFile(join(project, '.claude', 'launch.json'), 'utf8')) as {
      configurations: unknown[];
    };
    expect(launch.configurations).toHaveLength(1);
  }, 60_000);

  it('exits 2 with usage for an unknown command', async () => {
    const result = await run(['frobnicate']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Usage:');
  });

  it('serves the MCP tools for `mcp`, and starts nothing in a folder init never set up', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MAIN, 'mcp', '--project', project],
      stderr: 'pipe',
      env: { ...getDefaultEnvironment(), HOME: home, USERPROFILE: home },
    });
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['deck_status', 'get_logs']);
    const status = await client.callTool({ name: 'deck_status', arguments: {} });
    const text = (status.content as { text: string }[])[0]?.text ?? '';
    expect(text).toContain('flutterdeck init');
  }, 30_000);
});
