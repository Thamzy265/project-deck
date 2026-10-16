/**
 * Tester edge cases for the plugin lines in `init`'s next steps: a CLI that is not in a
 * FlutterDeck checkout must never be told to add some other folder's marketplace.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InitOptions } from './init.js';
import { runInit } from './init.js';
import type { RunTool } from './prerequisites.js';

const PUBSPEC = 'name: shop_app\ndependencies:\n  flutter:\n    sdk: flutter\n';

let project: string;
let home: string;
let outside: string;
let lines: string[];

const tools: RunTool = () => Promise.resolve('version 1');

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'deck-cli-steps-'));
  home = await mkdtemp(join(tmpdir(), 'deck-cli-steps-home-'));
  outside = await mkdtemp(join(tmpdir(), 'deck-cli-steps-outside-'));
  await writeFile(join(project, 'pubspec.yaml'), PUBSPEC);
  lines = [];
});

afterEach(async () => {
  for (const dir of [project, home, outside]) await rm(dir, { recursive: true, force: true });
});

function init(opts: Partial<InitOptions>): Promise<number> {
  return runInit({
    projectDir: project,
    homeDir: home,
    run: tools,
    cliMainPath: join(outside, 'packages', 'cli', 'dist', 'main.js'),
    isFree: () => Promise.resolve(true),
    io: { out: (l) => lines.push(l), err: () => undefined },
    ...opts,
  });
}

async function marketplace(root: string, body: unknown): Promise<void> {
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await writeFile(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify(body));
}

describe('init next steps for the plugin', () => {
  it('prints the MCP config only for a CLI near the file system root', async () => {
    expect(await init({ cliMainPath: '/main.js' })).toBe(0);
    const text = lines.join('\n');
    expect(text).not.toContain('claude plugin');
    expect(text).toContain('"mcpServers"');
  });

  // T-P5-9 too: only the path's existence is checked, so even a folder there counts.
  it('T-P5-9 prints the MCP config only when the marketplace file is a folder', async () => {
    await mkdir(join(outside, '.claude-plugin', 'marketplace.json'), { recursive: true });
    expect(await init({})).toBe(0);
    expect(lines.join('\n')).not.toContain('claude plugin marketplace add');
  });

  it('quotes a checkout path with spaces', async () => {
    const checkout = join(outside, 'my deck');
    await marketplace(checkout, {
      name: 'flutterdeck-dev',
      plugins: [{ name: 'flutterdeck', source: './plugin' }],
    });
    await init({ cliMainPath: join(checkout, 'packages', 'cli', 'dist', 'main.js') });
    expect(lines.join('\n')).toContain(`claude plugin marketplace add "${checkout}"`);
  });

  // T-P5-9: any `.claude-plugin/marketplace.json` four folders above the CLI counts as
  // FlutterDeck's checkout. A CLI installed under a cloned project as
  // `node_modules/flutterdeck/dist/main.js` (the M5 `npx flutterdeck` name) would tell the
  // user to add that project's own marketplace.
  it("T-P5-9 never tells the user to add another repo's marketplace", async () => {
    await marketplace(project, { name: 'someone-elses', plugins: [] });
    await init({ cliMainPath: join(project, 'node_modules', 'flutterdeck', 'dist', 'main.js') });
    expect(lines.join('\n')).not.toContain('claude plugin marketplace add');
  });

  it.each([
    [
      'another name',
      { name: 'someone-elses', plugins: [{ name: 'flutterdeck', source: './plugin' }] },
    ],
    [
      'no flutterdeck plugin',
      { name: 'flutterdeck-dev', plugins: [{ name: 'other', source: './x' }] },
    ],
    ['no plugins list', { name: 'flutterdeck-dev' }],
    ['not an object', ['flutterdeck-dev']],
  ])('T-P5-9 prints no plugin steps for a marketplace with %s', async (_, body) => {
    await marketplace(outside, body);
    await init({});
    expect(lines.join('\n')).not.toContain('claude plugin');
  });

  it('T-P5-9 prints no plugin steps for a marketplace file that is not JSON', async () => {
    await mkdir(join(outside, '.claude-plugin'), { recursive: true });
    await writeFile(join(outside, '.claude-plugin', 'marketplace.json'), '{ not json');
    await init({});
    expect(lines.join('\n')).not.toContain('claude plugin');
  });

  (process.platform === 'win32' ? it.skip : it)(
    'T-P5-9 never follows a link at marketplace.json',
    async () => {
      const real = join(project, 'real-marketplace.json');
      await writeFile(
        real,
        JSON.stringify({
          name: 'flutterdeck-dev',
          plugins: [{ name: 'flutterdeck', source: './plugin' }],
        }),
      );
      await mkdir(join(outside, '.claude-plugin'), { recursive: true });
      await symlink(real, join(outside, '.claude-plugin', 'marketplace.json'));
      await init({});
      expect(lines.join('\n')).not.toContain('claude plugin');
    },
  );

  it('T-P5-9 prints the plugin steps for the development marketplace', async () => {
    await marketplace(outside, {
      name: 'flutterdeck-dev',
      plugins: [{ name: 'flutterdeck', source: './plugin' }],
    });
    await init({});
    expect(lines.join('\n')).toContain('claude plugin install flutterdeck@flutterdeck-dev');
  });
});
