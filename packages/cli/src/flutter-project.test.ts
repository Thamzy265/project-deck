import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectFlutterProject,
  hasFlutterDependency,
  readApplicationId,
} from './flutter-project.js';

const PUBSPEC = `name: shop_app
description: A sample.
environment:
  sdk: ^3.9.0

dependencies:
  # The SDK
  flutter:
    sdk: flutter
  drift: ^2.28.0

dev_dependencies:
  flutter_test:
    sdk: flutter
`;

describe('hasFlutterDependency', () => {
  it('finds flutter under dependencies', () => {
    expect(hasFlutterDependency(PUBSPEC)).toBe(true);
    expect(hasFlutterDependency(PUBSPEC.replace(/\n/g, '\r\n'))).toBe(true);
  });

  it('ignores flutter only under dev_dependencies, or nested deeper', () => {
    const dartOnly = `name: tool\ndependencies:\n  args: ^2.0.0\n  nested:\n    flutter: x\ndev_dependencies:\n  flutter:\n    sdk: flutter\n`;
    expect(hasFlutterDependency(dartOnly)).toBe(false);
    expect(hasFlutterDependency('name: x\n')).toBe(false);
  });
});

describe('readApplicationId', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'deck-cli-flutter-'));
    await mkdir(join(dir, 'android', 'app'), { recursive: true });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('reads it from build.gradle.kts', async () => {
    await writeFile(
      join(dir, 'android', 'app', 'build.gradle.kts'),
      'android {\n    defaultConfig {\n        applicationId = "com.example.shop_app"\n    }\n}\n',
    );
    expect(await readApplicationId(dir)).toBe('com.example.shop_app');
  });

  it('reads it from Groovy build.gradle', async () => {
    await writeFile(
      join(dir, 'android', 'app', 'build.gradle'),
      "defaultConfig {\n  applicationId 'org.acme.app'\n}\n",
    );
    expect(await readApplicationId(dir)).toBe('org.acme.app');
  });

  it('skips anything that is not a plain package name', async () => {
    await writeFile(
      join(dir, 'android', 'app', 'build.gradle.kts'),
      'applicationId = "$(touch x)"\napplicationId = flavorId\n',
    );
    expect(await readApplicationId(dir)).toBeUndefined();
  });

  it("reads the sample app's real build.gradle.kts", async () => {
    const sample = await readFile(
      new URL('../../../examples/sample_app/android/app/build.gradle.kts', import.meta.url),
      'utf8',
    );
    await writeFile(join(dir, 'android', 'app', 'build.gradle.kts'), sample);
    expect(await readApplicationId(dir)).toBe('dev.flutterdeck.flutterdeck_sample');
  });

  it('ignores an id inside a block comment', async () => {
    await writeFile(
      join(dir, 'android', 'app', 'build.gradle.kts'),
      '/*\napplicationId = "org.evil.commented"\n*/\ndefaultConfig {\n  applicationId = "com.example.real"\n}\n',
    );
    expect(await readApplicationId(dir)).toBe('com.example.real');
  });

  it('never guesses between two different ids (flavors)', async () => {
    await writeFile(
      join(dir, 'android', 'app', 'build.gradle.kts'),
      'defaultConfig {\n  applicationId = "com.example.app"\n}\nproductFlavors {\n  create("free") {\n    applicationId = "com.example.free"\n  }\n}\n',
    );
    expect(await readApplicationId(dir)).toBeUndefined();
  });

  it('takes an id written twice the same way', async () => {
    await writeFile(
      join(dir, 'android', 'app', 'build.gradle'),
      'applicationId \'com.example.app\'\napplicationId "com.example.app"\n',
    );
    expect(await readApplicationId(dir)).toBe('com.example.app');
  });

  it('refuses ids config.json would refuse: a digit after a dot, or over 255 characters', async () => {
    for (const id of ['com.1example', `com.${'a'.repeat(260)}`]) {
      await writeFile(join(dir, 'android', 'app', 'build.gradle'), `applicationId "${id}"\n`);
      expect(await readApplicationId(dir), id).toBeUndefined();
    }
  });

  it('reads a 1 MB file of unclosed comment openers in linear time', async () => {
    await writeFile(join(dir, 'android', 'app', 'build.gradle'), '/*x'.repeat(300_000));
    const start = performance.now();
    expect(await readApplicationId(dir)).toBeUndefined();
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it('is undefined without an Android folder', async () => {
    await rm(join(dir, 'android'), { recursive: true });
    expect(await readApplicationId(dir)).toBeUndefined();
  });
});

describe('detectFlutterProject', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'deck-cli-flutter-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('names the project from pubspec.yaml', async () => {
    await writeFile(join(dir, 'pubspec.yaml'), PUBSPEC);
    expect(await detectFlutterProject(dir)).toEqual({ ok: true, name: 'shop_app' });
  });

  it('explains a missing pubspec.yaml', async () => {
    const result = await detectFlutterProject(dir);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain('pubspec.yaml');
  });

  it('explains a Dart project without Flutter', async () => {
    await writeFile(join(dir, 'pubspec.yaml'), 'name: tool\ndependencies:\n  args: any\n');
    const result = await detectFlutterProject(dir);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain('flutter');
  });
});
