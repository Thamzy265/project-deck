import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundleIdFromPbxproj, parsePbxproj, readBundleId } from './ios-bundle-id.js';

const posix = process.platform === 'win32' ? it.skip : it;

/** examples/sample_app's own project file, as `flutter create` made it (16 Oct 2026). */
const SAMPLE = fileURLToPath(new URL('./testing/fixtures/sample-app.pbxproj', import.meta.url));

/** A small project file in the same shape: Runner and RunnerTests, Debug and Release. */
function pbxproj(opts: { debugId?: string; runner?: string; extraRunner?: boolean } = {}) {
  const id = opts.debugId ?? 'com.example.shopApp';
  const runner = opts.runner ?? 'Runner';
  const extra =
    opts.extraRunner === true
      ? `T3 /* Runner */ = { isa = PBXNativeTarget; buildConfigurationList = L1; name = Runner; };`
      : '';
  return `// !$*UTF8*$!
{
	archiveVersion = 1;
	objects = {
		T1 /* ${runner} */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = L1 /* Build configuration list for PBXNativeTarget "Runner" */;
			name = ${runner};
			productType = "com.apple.product-type.application";
		};
		T2 = { isa = PBXNativeTarget; buildConfigurationList = L2; name = RunnerTests; };
		${extra}
		L1 = { isa = XCConfigurationList; buildConfigurations = ( C1 /* Debug */, C2 /* Release */, ); };
		L2 = { isa = XCConfigurationList; buildConfigurations = ( C3, ); };
		C1 /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				LD_RUNPATH_SEARCH_PATHS = ( "$(inherited)", "@executable_path/Frameworks", );
				PRODUCT_BUNDLE_IDENTIFIER = ${id};
				PRODUCT_NAME = "$(TARGET_NAME)";
			};
			name = Debug;
		};
		C2 = { isa = XCBuildConfiguration; buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = com.example.release; }; name = Release; };
		C3 = { isa = XCBuildConfiguration; buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = com.example.tests; }; name = Debug; };
	};
	rootObject = P1;
}
`;
}

describe('bundleIdFromPbxproj', () => {
  it("reads the Runner target's Debug id from the sample app's real project file", async () => {
    expect(bundleIdFromPbxproj(await readFile(SAMPLE, 'utf8'))).toEqual({
      kind: 'found',
      id: 'dev.flutterdeck.flutterdeckSample',
    });
  });

  it('takes the Debug configuration of Runner, never RunnerTests or Release', () => {
    expect(bundleIdFromPbxproj(pbxproj())).toEqual({ kind: 'found', id: 'com.example.shopApp' });
  });

  it('reads a quoted id', () => {
    expect(bundleIdFromPbxproj(pbxproj({ debugId: '"com.example.quoted"' }))).toEqual({
      kind: 'found',
      id: 'com.example.quoted',
    });
  });

  it.each([
    ['a build variable', '"com.example.$(FLAVOR)"'],
    ['a bare variable', '"$(PRODUCT_BUNDLE_IDENTIFIER_BASE)"'],
    ['a shell command', '"com.example;touch x"'],
    ['a space', '"com.example app"'],
    ['a path', '"../../etc"'],
    ['an underscore', 'com.example.shop_app'],
    ['a leading dot', '.com.example'],
    ['an id that is too long', `com.${'a'.repeat(160)}`],
  ])('refuses %s, so init asks the user to set ios.bundleId', (_name, id) => {
    expect(bundleIdFromPbxproj(pbxproj({ debugId: id }))).toEqual({ kind: 'unusable' });
  });

  it('refuses two Runner targets (it never guesses), and finds none without one', () => {
    expect(bundleIdFromPbxproj(pbxproj({ extraRunner: true }))).toEqual({ kind: 'unusable' });
    expect(bundleIdFromPbxproj(pbxproj({ runner: 'MyApp' }))).toEqual({ kind: 'unusable' });
  });

  it.each([
    ['empty text', ''],
    ['an unclosed dictionary', '{ objects = { A = { isa = PBXNativeTarget; '],
    ['an unclosed string', '{ a = "abc'],
    ['an unclosed comment', '{ a = b; /* never ends'],
    ['deep nesting', '('.repeat(10_000)],
    ['JSON', '{"objects": {}}'],
    ['a key with no value', '{ objects = ; }'],
  ])('treats %s as unusable without throwing', (_name, text) => {
    expect(bundleIdFromPbxproj(text)).toEqual({ kind: 'unusable' });
  });

  it('keeps __proto__ and constructor keys as plain data', () => {
    const parsed = parsePbxproj('{ __proto__ = { isa = x; }; constructor = y; }');
    expect(parsed instanceof Map && parsed.get('__proto__')).toBeInstanceOf(Map);
    expect(({} as Record<string, unknown>).isa).toBeUndefined();
  });

  it('parses a 1 MB file of comments in linear time', () => {
    const text = `{ a = b; ${'/* x */'.repeat(150_000)} }`;
    const start = performance.now();
    expect(parsePbxproj(text)).toBeInstanceOf(Map);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe('readBundleId', () => {
  let dir: string;
  let outside: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'deck-cli-ios-'));
    outside = await mkdtemp(join(tmpdir(), 'deck-cli-ios-outside-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const project = () => join(dir, 'ios', 'Runner.xcodeproj');

  it('reads it from ios/Runner.xcodeproj/project.pbxproj', async () => {
    await mkdir(project(), { recursive: true });
    await writeFile(join(project(), 'project.pbxproj'), pbxproj());
    expect(await readBundleId(dir)).toEqual({ kind: 'found', id: 'com.example.shopApp' });
  });

  it('finds none without an iOS folder', async () => {
    expect(await readBundleId(dir)).toEqual({ kind: 'none' });
  });

  it('is unusable for a file over 2 MB, without reading it as a project', async () => {
    await mkdir(project(), { recursive: true });
    await writeFile(join(project(), 'project.pbxproj'), pbxproj() + ' '.repeat(2 * 1024 * 1024));
    expect(await readBundleId(dir)).toEqual({ kind: 'unusable' });
  });

  posix('never reads through a linked project file', async () => {
    await mkdir(project(), { recursive: true });
    const target = join(outside, 'project.pbxproj');
    await writeFile(target, pbxproj({ debugId: 'org.private.outside' }));
    await symlink(target, join(project(), 'project.pbxproj'));
    expect(await readBundleId(dir)).toEqual({ kind: 'none' });
  });

  posix.each([['ios'], ['ios/Runner.xcodeproj']])(
    'never reads through a linked %s folder',
    async (linked) => {
      const real = join(outside, 'real');
      const xcodeproj = linked === 'ios' ? join(real, 'Runner.xcodeproj') : real;
      await mkdir(xcodeproj, { recursive: true });
      await writeFile(join(xcodeproj, 'project.pbxproj'), pbxproj({ debugId: 'org.linked' }));
      if (linked !== 'ios') await mkdir(join(dir, 'ios'));
      await symlink(real, join(dir, ...linked.split('/')), 'dir');
      expect(await readBundleId(dir)).toEqual({ kind: 'none' });
    },
  );
});
