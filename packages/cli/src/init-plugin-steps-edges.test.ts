/**
 * `init` printing the public install steps from awkward places (M5 batch 3): a project and
 * a home folder with spaces, a person's name in the path, and a Windows-style path in the
 * environment. Nothing the user may paste into an issue or chat should name either folder.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DECK_VERSION } from '@project-deck/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from './init.js';
import type { RunTool } from './prerequisites.js';

let root: string;
let project: string;
let home: string;
let out: string[];
let errs: string[];

const PERSON = 'Alice Smithfield';
const tools: RunTool = () => Promise.resolve('version 1');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'deck-init-edges-'));
  home = join(root, 'Users', PERSON);
  project = join(home, 'My Flutter Apps', 'shop app');
  await mkdir(project, { recursive: true });
  await writeFile(
    join(project, 'pubspec.yaml'),
    'name: shop_app\ndependencies:\n  flutter:\n    sdk: flutter\n',
  );
  out = [];
  errs = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const init = (): Promise<number> =>
  runInit({
    projectDir: project,
    homeDir: home,
    run: tools,
    isFree: () => Promise.resolve(true),
    io: { out: (l) => out.push(l), err: (l) => errs.push(l) },
  });

describe('init output from a project path with spaces and a person’s name', () => {
  it('succeeds and prints the pinned npx entry as JSON that parses', async () => {
    expect(await init()).toBe(0);
    const text = out.join('\n');
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as {
      mcpServers: { pitdeck: { command: string; args: string[] } };
    };
    expect(json.mcpServers.pitdeck).toMatchObject({
      command: 'npx',
      args: ['-y', `pitdeck@${DECK_VERSION}`, 'mcp'],
    });
  });

  it('names neither the project folder, the home folder nor the person in the next steps', async () => {
    await init();
    // The header line "Pitdeck init in <folder>" is the user's own terminal; the steps are
    // what gets pasted into chat, issues and .mcp.json files.
    const steps = out.slice(out.indexOf('Next steps:')).join('\n');
    expect(steps).toContain('claude plugin install');
    const everything = [steps, ...errs].join('\n');
    for (const secret of [project, home, root, PERSON, 'My Flutter Apps']) {
      expect(everything).not.toContain(secret);
    }
    // Windows spellings of the same folders, as a pasted log would show them.
    for (const secret of [project, home].map((p) => p.replaceAll('/', '\\'))) {
      expect(everything).not.toContain(secret);
    }
  });

  it('does not tell the user to add the marketplace by a path', async () => {
    await init();
    const steps = out.join('\n');
    const adds = [...steps.matchAll(/marketplace add\s+(\S+)/g)].map((m) => m[1]);
    expect(adds).toEqual(['Thamzy265/project-deck']);
    expect(steps).not.toMatch(/pitdeck-dev|plugin-dev/);
  });
});
