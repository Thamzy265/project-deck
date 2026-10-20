/**
 * `init` writes android.applicationId and ios.bundleId into .flutterdeck/config.json
 * when the project shows them plainly (docs/notes/untrusted-project-files.md), and
 * keeps every value the config already has.
 */
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '@project-deck/core/node';
import { parse } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InitOptions } from './init.js';
import { runInit } from './init.js';
import type { RunTool } from './prerequisites.js';

const posix = process.platform === 'win32' ? it.skip : it;

const PUBSPEC = 'name: shop_app\ndependencies:\n  flutter:\n    sdk: flutter\n';
const SAMPLE_PBXPROJ = fileURLToPath(
  new URL('./testing/fixtures/sample-app.pbxproj', import.meta.url),
);
const tools: RunTool = () => Promise.reject(new Error('ENOENT'));

let project: string;
let home: string;
let outside: string;
let lines: string[];
let errors: string[];

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'deck-cli-ids-'));
  home = await mkdtemp(join(tmpdir(), 'deck-cli-ids-home-'));
  outside = await mkdtemp(join(tmpdir(), 'deck-cli-ids-outside-'));
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
    cliMainPath: '/opt/deck/packages/cli/dist/main.js',
    isFree: () => Promise.resolve(true),
    io: { out: (l) => lines.push(l), err: (l) => errors.push(l) },
    ...opts,
  });
}

const config = async (): Promise<unknown> =>
  parse(await readFile(join(project, '.flutterdeck', 'config.json'), 'utf8'));

async function android(gradle: string): Promise<void> {
  await mkdir(join(project, 'android', 'app'), { recursive: true });
  await writeFile(join(project, 'android', 'app', 'build.gradle.kts'), gradle);
}

async function ios(): Promise<void> {
  await mkdir(join(project, 'ios', 'Runner.xcodeproj'), { recursive: true });
  await copyFile(SAMPLE_PBXPROJ, join(project, 'ios', 'Runner.xcodeproj', 'project.pbxproj'));
}

describe('init writes the app ids it can read safely', () => {
  it('writes both ids into a new config.json, which the daemon accepts', async () => {
    await android('defaultConfig {\n  applicationId = "com.example.shop_app"\n}\n');
    await ios();
    expect(await init()).toBe(0);
    expect(errors).toEqual([]);
    expect(await config()).toEqual({
      version: 1,
      port: 9147,
      android: { applicationId: 'com.example.shop_app' },
      ios: { bundleId: 'dev.flutterdeck.flutterdeckSample' },
    });
    await expect(readConfig(project)).resolves.toMatchObject({
      android: { applicationId: 'com.example.shop_app' },
      ios: { bundleId: 'dev.flutterdeck.flutterdeckSample' },
    });
    const text = lines.join('\n');
    expect(text).toContain('android.applicationId com.example.shop_app');
    expect(text).toContain('ios.bundleId dev.flutterdeck.flutterdeckSample');
  });

  it('adds missing ids to an existing config and keeps its settings and layout', async () => {
    await android('applicationId = "com.example.shop_app"\n');
    await ios();
    await mkdir(join(project, '.flutterdeck'));
    const before =
      '{\n    "version": 1,\n    "port": 9300,\n    "db": { "hiddenColumns": ["users.email"] }\n}\n';
    await writeFile(join(project, '.flutterdeck', 'config.json'), before);
    expect(await init()).toBe(0);
    const after = await readFile(join(project, '.flutterdeck', 'config.json'), 'utf8');
    // Its own four-space layout, and the db line as the user wrote it.
    expect(after).toContain('\n    "db": { "hiddenColumns": ["users.email"] }');
    expect(after).toContain('\n    "android": {');
    expect(parse(after)).toEqual({
      version: 1,
      port: 9300,
      db: { hiddenColumns: ['users.email'] },
      android: { applicationId: 'com.example.shop_app' },
      ios: { bundleId: 'dev.flutterdeck.flutterdeckSample' },
    });
    expect(lines.join('\n')).toMatch(
      /updated +\.flutterdeck\/config\.json \(added android\.applicationId/,
    );
  });

  it('never replaces ids the config already has', async () => {
    await android('applicationId = "com.example.other"\n');
    await ios();
    await mkdir(join(project, '.flutterdeck'));
    const before = JSON.stringify({
      version: 1,
      port: 9300,
      android: { applicationId: 'com.mine.app' },
      ios: { bundleId: 'com.mine.app' },
    });
    await writeFile(join(project, '.flutterdeck', 'config.json'), before);
    expect(await init()).toBe(0);
    expect(await readFile(join(project, '.flutterdeck', 'config.json'), 'utf8')).toBe(before);
    expect(lines.join('\n')).toMatch(/unchanged +\.flutterdeck\/config\.json/);
  });

  it('changes nothing on a second run', async () => {
    await android('applicationId = "com.example.shop_app"\n');
    await ios();
    await init();
    const first = await readFile(join(project, '.flutterdeck', 'config.json'), 'utf8');
    await init();
    expect(await readFile(join(project, '.flutterdeck', 'config.json'), 'utf8')).toBe(first);
  });

  it('writes no ids for a project without android or ios folders', async () => {
    expect(await init()).toBe(0);
    expect(await config()).toEqual({ version: 1, port: 9147 });
    expect(lines.join('\n')).not.toMatch(/bundleId/);
  });

  it.each([
    ['a build variable', 'applicationId = "$(touch x)"\n'],
    ['a Kotlin expression', 'applicationId = flavorId\n'],
    ['string interpolation', 'applicationId = "com.example.${suffix}"\n'],
    ['two flavors', 'applicationId = "com.example.a"\napplicationId = "com.example.b"\n'],
    ['only a comment', '/* applicationId = "com.example.hidden" */\n'],
    ['a quote break-out', 'applicationId = "com.example.a" + "\\"; rm -rf ~"\n'],
  ])('writes no Android id for %s', async (_name, gradle) => {
    await android(gradle);
    expect(await init()).toBe(0);
    expect(await config()).toEqual({ version: 1, port: 9147 });
  });

  it('asks the user to set ios.bundleId when the project uses a build variable', async () => {
    await mkdir(join(project, 'ios', 'Runner.xcodeproj'), { recursive: true });
    const text = (await readFile(SAMPLE_PBXPROJ, 'utf8')).replaceAll(
      'PRODUCT_BUNDLE_IDENTIFIER = dev.flutterdeck.flutterdeckSample;',
      'PRODUCT_BUNDLE_IDENTIFIER = "dev.flutterdeck.$(FLAVOR)";',
    );
    await writeFile(join(project, 'ios', 'Runner.xcodeproj', 'project.pbxproj'), text);
    expect(await init()).toBe(0);
    expect(await config()).toEqual({ version: 1, port: 9147 });
    const out = lines.join('\n');
    expect(out).toContain('set ios.bundleId in .flutterdeck/config.json');
    expect(out).not.toContain('$(FLAVOR)');
  });

  posix('never reads an id through a linked project file or folder', async () => {
    const real = join(outside, 'Runner.xcodeproj');
    await mkdir(real, { recursive: true });
    const secret = ['org', 'private', 'outside'].join('.');
    await writeFile(
      join(real, 'project.pbxproj'),
      (await readFile(SAMPLE_PBXPROJ, 'utf8')).replaceAll(
        'dev.flutterdeck.flutterdeckSample',
        secret,
      ),
    );
    await mkdir(join(project, 'ios'));
    await symlink(real, join(project, 'ios', 'Runner.xcodeproj'), 'dir');
    await mkdir(join(project, 'android', 'app'), { recursive: true });
    await writeFile(join(outside, 'build.gradle.kts'), `applicationId = "${secret}"\n`);
    await symlink(
      join(outside, 'build.gradle.kts'),
      join(project, 'android', 'app', 'build.gradle.kts'),
    );
    expect(await init()).toBe(0);
    const written = await readFile(join(project, '.flutterdeck', 'config.json'), 'utf8');
    expect(written).not.toContain(secret);
    expect(lines.join('\n')).not.toContain(secret);
  });
});
