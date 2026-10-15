import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GITIGNORE_BEGIN } from './gitignore.js';
import type { InitOptions } from './init.js';
import { runInit } from './init.js';
import { launchEntry } from './launch-json.js';
import type { RunTool } from './prerequisites.js';

const links = process.platform === 'win32' ? it.skip : it;

const PUBSPEC = 'name: shop_app\ndependencies:\n  flutter:\n    sdk: flutter\n';
const MCP_MAIN = '/opt/deck/packages/mcp/dist/main.js';

let project: string;
let home: string;
let outside: string;
let lines: string[];
let errors: string[];

const tools: RunTool = (tool) =>
  Promise.resolve(
    tool === 'dart'
      ? 'Dart SDK version: 3.9.2 (stable)'
      : tool === 'flutter'
        ? 'Flutter 3.35.2 • channel stable'
        : 'Android Debug Bridge version 1.0.41',
  );

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'deck-cli-init-'));
  home = await mkdtemp(join(tmpdir(), 'deck-cli-init-home-'));
  outside = await mkdtemp(join(tmpdir(), 'deck-cli-init-outside-'));
  await writeFile(join(project, 'pubspec.yaml'), PUBSPEC);
  lines = [];
  errors = [];
});

afterEach(async () => {
  for (const dir of [project, home, outside]) await rm(dir, { recursive: true, force: true });
});

function init(opts: Partial<InitOptions> = {}): Promise<number> {
  return runInit({
    projectDir: project,
    homeDir: home,
    run: tools,
    cliMainPath: MCP_MAIN,
    isFree: () => Promise.resolve(true),
    io: { out: (l) => lines.push(l), err: (l) => errors.push(l) },
    ...opts,
  });
}

const read = (...parts: string[]) => readFile(join(project, ...parts), 'utf8');
const readJson = async (...parts: string[]): Promise<unknown> => parse(await read(...parts));

/** Every file under the project, with its contents, to show nothing changed. */
async function snapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const entries = await readdir(project, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    const path = join(e.parentPath, e.name);
    out[path] = e.isFile() ? await readFile(path, 'utf8') : e.isSymbolicLink() ? 'link' : 'dir';
  }
  return out;
}

function countBlocks(text: string): number {
  return text.split('\n').filter((l) => l === GITIGNORE_BEGIN).length;
}

describe('init in a fresh Flutter project', () => {
  it('writes config, the gitignore block and the launch.json entry, and says so', async () => {
    expect(await init()).toBe(0);
    expect(errors).toEqual([]);
    expect(await readJson('.flutterdeck', 'config.json')).toEqual({ version: 1, port: 9147 });
    expect(countBlocks(await read('.gitignore'))).toBe(1);
    expect(await readJson('.claude', 'launch.json')).toEqual({
      version: '0.0.1',
      configurations: [launchEntry(9147)],
    });
    const text = lines.join('\n');
    expect(text).toMatch(/created +\.flutterdeck\/config\.json/);
    expect(text).toMatch(/created +\.gitignore/);
    expect(text).toMatch(/created +\.claude\/launch\.json/);
    expect(text).toContain('shop_app');
    expect(text).toContain('dart    found 3.9.2');
  });

  it('records the port in the per-user registry in the given home', async () => {
    await init();
    const registry = JSON.parse(
      await readFile(join(home, '.flutterdeck', 'ports.json'), 'utf8'),
    ) as { projects: Record<string, number> };
    expect(Object.values(registry.projects)).toEqual([9147]);
  });

  it('prints an .mcp.json snippet that runs `flutterdeck mcp` through the CLI, as valid JSON', async () => {
    await init({ cliMainPath: 'C:\\Users\\Jo Doe\\deck\\packages\\cli\\dist\\main.js' });
    const text = lines.join('\n');
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    expect(JSON.parse(json)).toEqual({
      mcpServers: {
        dart: { type: 'stdio', command: 'dart', args: ['mcp-server'] },
        flutterdeck: {
          type: 'stdio',
          command: 'node',
          args: ['C:\\Users\\Jo Doe\\deck\\packages\\cli\\dist\\main.js', 'mcp'],
        },
      },
    });
  });

  it('prints how to install the plugin from the checkout this CLI runs from', async () => {
    const checkout = join(outside, 'deck checkout');
    await mkdir(join(checkout, '.claude-plugin'), { recursive: true });
    await writeFile(join(checkout, '.claude-plugin', 'marketplace.json'), '{}');
    await init({ cliMainPath: join(checkout, 'packages', 'cli', 'dist', 'main.js') });
    const text = lines.join('\n');
    expect(text).toContain(`claude plugin marketplace add "${checkout}"`);
    expect(text).toContain('claude plugin install flutterdeck@flutterdeck-dev');
    // The raw MCP config stays, for use without the plugin or with other agents.
    expect(text.indexOf('claude plugin install')).toBeLessThan(text.indexOf('"mcpServers"'));
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    expect(JSON.parse(json)).toHaveProperty('mcpServers.flutterdeck.command', 'node');
  });

  it('prints the MCP config only when the CLI is not in a checkout with the plugin', async () => {
    await init();
    const text = lines.join('\n');
    expect(text).not.toContain('claude plugin');
    expect(text).toContain('"mcpServers"');
  });

  it('never fails because a tool is missing', async () => {
    expect(await init({ run: () => Promise.reject(new Error('ENOENT')) })).toBe(0);
    expect(lines.join('\n')).toContain('flutter missing');
  });
});

describe('init run twice', () => {
  it('changes nothing the second time', async () => {
    await init();
    const before = await snapshot();
    lines = [];
    expect(await init()).toBe(0);
    expect(await snapshot()).toEqual(before);
    const text = lines.join('\n');
    expect(text).toMatch(/unchanged +\.flutterdeck\/config\.json/);
    expect(text).toMatch(/unchanged +\.gitignore/);
    expect(text).toMatch(/unchanged +\.claude\/launch\.json/);
  });
});

describe('init with existing files', () => {
  it('adds only a missing port to config.json and keeps every setting', async () => {
    await mkdir(join(project, '.flutterdeck'));
    await writeFile(
      join(project, '.flutterdeck', 'config.json'),
      '{\n  "version": 1,\n  "logs": { "redact": false, "rules": ["secret-\\\\d+"] }\n}\n',
    );
    expect(await init()).toBe(0);
    expect(await readJson('.flutterdeck', 'config.json')).toEqual({
      version: 1,
      logs: { redact: false, rules: ['secret-\\d+'] },
      port: 9147,
    });
    expect(lines.join('\n')).toContain('Masking for Claude is off');
  });

  it('keeps a port the config already has, and uses it in launch.json', async () => {
    await mkdir(join(project, '.flutterdeck'));
    const config = '{ "version": 1, "port": 9300 }\n';
    await writeFile(join(project, '.flutterdeck', 'config.json'), config);
    expect(await init()).toBe(0);
    expect(await read('.flutterdeck', 'config.json')).toBe(config);
    expect(await readJson('.claude', 'launch.json')).toMatchObject({
      configurations: [launchEntry(9300)],
    });
  });

  it('refuses an invalid config.json and changes nothing', async () => {
    await mkdir(join(project, '.flutterdeck'));
    await writeFile(join(project, '.flutterdeck', 'config.json'), '{ "version": 1, "prot": 1 }');
    const before = await snapshot();
    expect(await init()).toBe(1);
    expect(errors.join('\n')).toContain('config.json');
    expect(await snapshot()).toEqual(before);
  });

  it('appends to .gitignore once and keeps launch.json comments and other entries', async () => {
    await writeFile(join(project, '.gitignore'), 'build/\n');
    await mkdir(join(project, '.claude'));
    const launch =
      '{\n  // mine\n  "version": "0.0.1",\n  "configurations": [\n    { "name": "web", "url": "http://localhost:3000" }\n  ]\n}\n';
    await writeFile(join(project, '.claude', 'launch.json'), launch);
    await init();
    await init();
    const ignore = await read('.gitignore');
    expect(ignore.startsWith('build/\n')).toBe(true);
    expect(countBlocks(ignore)).toBe(1);
    const merged = await read('.claude', 'launch.json');
    expect(merged).toContain('// mine');
    expect(parse(merged)).toEqual({
      version: '0.0.1',
      configurations: [{ name: 'web', url: 'http://localhost:3000' }, launchEntry(9147)],
    });
  });

  it('refuses a launch.json it can’t parse and writes nothing at all', async () => {
    await mkdir(join(project, '.claude'));
    await writeFile(join(project, '.claude', 'launch.json'), '{ "configurations": [');
    const before = await snapshot();
    expect(await init()).toBe(1);
    expect(errors.join('\n')).toContain('.claude/launch.json');
    expect(await snapshot()).toEqual(before);
  });
});

describe('init and links planted in the project', () => {
  async function plantTarget(): Promise<string> {
    const target = join(outside, 'victim');
    await writeFile(target, 'untouched');
    return target;
  }

  links.each([
    ['.gitignore', ['.gitignore']],
    ['.claude/launch.json', ['.claude', 'launch.json']],
    ['.flutterdeck/config.json', ['.flutterdeck', 'config.json']],
  ])('refuses a linked %s, leaves the target alone and writes nothing', async (shown, parts) => {
    const target = await plantTarget();
    if (parts.length > 1) await mkdir(join(project, parts[0] ?? ''));
    await symlink(target, join(project, ...parts));
    const before = await snapshot();
    expect(await init()).toBe(1);
    expect(errors.join('\n')).toContain(shown);
    expect(errors.join('\n')).not.toContain(outside);
    expect(await readFile(target, 'utf8')).toBe('untouched');
    expect(await snapshot()).toEqual(before);
  });

  links.each([['.claude'], ['.flutterdeck']])(
    'refuses a linked %s folder and writes nothing into its target',
    async (name) => {
      await symlink(outside, join(project, name), 'dir');
      expect(await init()).toBe(1);
      expect(errors.join('\n')).toContain(name);
      expect(await readdir(outside)).toEqual([]);
    },
  );
});

describe('init in other folders', () => {
  it('refuses a folder that is not a Flutter app, and writes nothing', async () => {
    await writeFile(join(project, 'pubspec.yaml'), 'name: tool\ndependencies:\n  args: any\n');
    expect(await init()).toBe(1);
    expect(await readdir(project)).toEqual(['pubspec.yaml']);
  });

  it('gives two projects two ports', async () => {
    const second = await mkdtemp(join(tmpdir(), 'deck-cli-init-2-'));
    try {
      await writeFile(join(second, 'pubspec.yaml'), PUBSPEC);
      await init();
      await init({ projectDir: second });
      expect(await readJson('.flutterdeck', 'config.json')).toMatchObject({ port: 9147 });
      const other = JSON.parse(
        await readFile(join(second, '.flutterdeck', 'config.json'), 'utf8'),
      ) as unknown;
      expect(other).toMatchObject({ port: 9148 });
    } finally {
      await rm(second, { recursive: true, force: true });
    }
  });
});
