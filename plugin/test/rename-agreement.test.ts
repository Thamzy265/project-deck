/**
 * The FlutterDeck -> Pitdeck rename (M5 batch 1). The hook is plain JavaScript that cannot
 * import core, so it repeats a few names. These tests tie each repeated name to the one
 * the daemon and CLI really use, and check that a leftover `.flutterdeck/` is never read.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REGISTRY_DIR,
  REGISTRY_FILE,
  RUNTIME_FILE,
  STATE_DIR,
  projectIdFor,
  projectKey,
} from '@project-deck/core/node';
import { TOKEN_HEADER as DAEMON_TOKEN_HEADER } from '@project-deck/core';
import * as hook from '../hooks/deck-hook.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'deck-hook.mjs');
const TOKEN = 'tok-0123456789abcdef0123456789abcdef0123456789';

let base: string;
let project: string;
let home: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'deck-hook-rename-'));
  project = join(base, 'app');
  home = join(base, 'home');
  await mkdir(project);
  await mkdir(home);
});
afterEach(() => rm(base, { recursive: true, force: true }));

describe('names the hook repeats', () => {
  it('reads the state folder and files that core names', async () => {
    const source = await readFile(HOOK, 'utf8');
    expect(source).toContain(`join(projectDir, '${STATE_DIR}')`);
    expect(source).toContain(`'${RUNTIME_FILE}'`);
    expect(source).toContain(`join(home, '${REGISTRY_DIR}', '${REGISTRY_FILE}')`);
  });

  it('sends the token in the header the daemon reads', () => {
    expect(hook.TOKEN_HEADER).toBe(DAEMON_TOKEN_HEADER);
  });

  it('matches the reload tools of both Dart servers this plugin can see, and no other tool', () => {
    const re = new RegExp(hook.RELOAD_TOOL_PATTERN);
    for (const tool of [
      'mcp__plugin_pitdeck_dart__hot_reload',
      'mcp__plugin_pitdeck_dart__hot_restart',
      'mcp__plugin_dart-flutter_dart-mcp-server__hot_reload',
      'mcp__dart__hot_restart',
    ]) {
      expect(re.test(tool), tool).toBe(true);
    }
    for (const tool of [
      'mcp__plugin_pitdeck_pitdeck__deck_status',
      'mcp__plugin_pitdeck_pitdeck__hot_reload',
      'mcp__plugin_flutterdeck_flutterdeck__db_query',
      'hot_reload',
    ]) {
      expect(re.test(tool), tool).toBe(false);
    }
  });

  it("finds the id in the registry core writes, under the home's .pitdeck", async () => {
    const salt = randomBytes(32).toString('hex');
    await mkdir(join(home, REGISTRY_DIR));
    await writeFile(
      join(home, REGISTRY_DIR, REGISTRY_FILE),
      JSON.stringify({ version: 1, salt, projects: {} }),
      { mode: 0o600 },
    );
    expect(await hook.ownProjectId(project, home)).toBe(
      projectIdFor(salt, await projectKey(project)),
    );
  });
});

describe('a leftover FlutterDeck install', () => {
  it('is not read: the hook finds no daemon from .flutterdeck/runtime.json', async () => {
    await mkdir(join(project, '.flutterdeck'));
    await writeFile(join(project, '.flutterdeck', 'config.json'), '{"version":1}');
    await writeFile(
      join(project, '.flutterdeck', 'runtime.json'),
      JSON.stringify({ port: 9147, token: TOKEN }),
    );
    expect(await hook.readDaemonAddress(project)).toBeUndefined();
    expect(resolve(project, '.flutterdeck')).not.toBe(resolve(project, STATE_DIR));
  });

  it('gives no project id from ~/.flutterdeck/ports.json', async () => {
    await mkdir(join(home, '.flutterdeck'));
    await writeFile(
      join(home, '.flutterdeck', 'ports.json'),
      JSON.stringify({ version: 1, salt: randomBytes(32).toString('hex'), projects: {} }),
    );
    expect(await hook.ownProjectId(project, home)).toBeUndefined();
  });
});
