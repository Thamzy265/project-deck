import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FIRST_PORT,
  PortClaimedError,
  PortRegistryError,
  allocatePort,
  claimConfigPort,
  projectIdentity,
  registryPath,
} from './port-registry.js';

let homeDir: string;
let base: string;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'deck-reg-home-'));
  base = await realpath(await mkdtemp(join(tmpdir(), 'deck-reg-projects-')));
});

afterEach(async () => {
  for (const dir of [homeDir, base]) await rm(dir, { recursive: true, force: true });
});

const allFree = () => Promise.resolve(true);
const posixOnly = process.platform === 'win32' || process.getuid?.() === 0;

async function project(name: string): Promise<string> {
  const dir = join(base, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeRegistry(content: string): Promise<void> {
  await mkdir(join(homeDir, '.flutterdeck'), { recursive: true });
  await writeFile(registryPath(homeDir), content);
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof Error)) throw new Error('expected a rejection');
  return err;
}

const SALT = 'a'.repeat(43);

describe('port registry: damaged files', () => {
  it.each([
    ['empty', ''],
    ['not JSON', '{"version":1,'],
    ['null', 'null'],
    ['an array', '[]'],
    ['version 2', JSON.stringify({ version: 2, salt: SALT, projects: {} })],
    ['no salt', JSON.stringify({ version: 1, projects: {} })],
    ['a short salt', JSON.stringify({ version: 1, salt: 'short', projects: {} })],
    ['a string port', JSON.stringify({ version: 1, salt: SALT, projects: { '/x': '9147' } })],
    ['port 0', JSON.stringify({ version: 1, salt: SALT, projects: { '/x': 0 } })],
    ['port 65536', JSON.stringify({ version: 1, salt: SALT, projects: { '/x': 65536 } })],
    ['projects as an array', JSON.stringify({ version: 1, salt: SALT, projects: [] })],
  ])('refuses a registry that is %s and leaves it untouched', async (_name, text) => {
    await writeRegistry(text);
    const dir = await project('app');
    const calls: (() => Promise<unknown>)[] = [
      () => projectIdentity(dir, { homeDir }),
      () => allocatePort(dir, { homeDir, isFree: allFree }),
      () => claimConfigPort(dir, 9200, { homeDir }),
    ];
    for (const call of calls) {
      const err = await failure(call());
      expect(err).toBeInstanceOf(PortRegistryError);
      expect(err.message).toContain('is damaged');
    }
    expect(await readFile(registryPath(homeDir), 'utf8')).toBe(text);
  });

  it('keeps unknown extra keys readable (a newer FlutterDeck may add some)', async () => {
    await writeRegistry(JSON.stringify({ version: 1, salt: SALT, projects: {}, extra: true }));
    const dir = await project('app');
    expect(await projectIdentity(dir, { homeDir })).toMatch(/^[0-9a-f]{12}$/);
  });

  it.skipIf(posixOnly)('reports a registry it may not read, and does not replace it', async () => {
    await writeRegistry(JSON.stringify({ version: 1, salt: SALT, projects: {} }));
    await chmod(registryPath(homeDir), 0o000);
    try {
      const err = await failure(projectIdentity(await project('app'), { homeDir }));
      expect(err).toBeInstanceOf(PortRegistryError);
      expect(err.message).toContain("can't be read (EACCES)");
    } finally {
      await chmod(registryPath(homeDir), 0o600);
    }
    expect(JSON.parse(await readFile(registryPath(homeDir), 'utf8'))).toMatchObject({ salt: SALT });
  });

  it.skipIf(posixOnly)('tightens a registry left world-readable on the next write', async () => {
    await writeRegistry(JSON.stringify({ version: 1, salt: SALT, projects: {} }));
    await chmod(registryPath(homeDir), 0o644);
    await allocatePort(await project('app'), { homeDir, isFree: allFree });
    expect((await stat(registryPath(homeDir))).mode & 0o777).toBe(0o600);
  });

  it.skipIf(posixOnly)('creates the folder readable by the user only', async () => {
    await projectIdentity(await project('app'), { homeDir });
    expect((await stat(join(homeDir, '.flutterdeck'))).mode & 0o777).toBe(0o700);
  });

  it('leaves no temp files behind', async () => {
    for (const name of ['a', 'b', 'c']) {
      await allocatePort(await project(name), { homeDir, isFree: allFree });
    }
    expect(await readdir(join(homeDir, '.flutterdeck'))).toEqual(['ports.json']);
  });
});

describe('port registry: the home folder', () => {
  it('creates a missing home folder', async () => {
    const missingHome = join(homeDir, 'not', 'yet');
    const dir = await project('app');
    expect(await allocatePort(dir, { homeDir: missingHome, isFree: allFree })).toBe(FIRST_PORT);
    expect((await stat(registryPath(missingHome))).isFile()).toBe(true);
  });

  it('reports a home that is a file, without crashing', async () => {
    const fileHome = join(homeDir, 'file');
    await writeFile(fileHome, 'x');
    const err = await failure(projectIdentity(await project('app'), { homeDir: fileHome }));
    expect((err as NodeJS.ErrnoException).code ?? err.message).toMatch(/ENOTDIR|EEXIST|can't/);
  });

  it('reports a ports.json that is a folder', async () => {
    await mkdir(registryPath(homeDir), { recursive: true });
    const err = await failure(projectIdentity(await project('app'), { homeDir }));
    expect(err).toBeInstanceOf(PortRegistryError);
  });
});

describe('port registry: project paths', () => {
  it('treats a trailing slash, ./ and .. as the same project', async () => {
    const dir = await project('app');
    const id = await projectIdentity(dir, { homeDir });
    for (const variant of [`${dir}/`, `${dir}/.`, join(dir, 'sub', '..'), `${dir}//`]) {
      expect(await projectIdentity(variant, { homeDir })).toBe(id);
    }
  });

  it('treats a symlinked parent folder as the same project, also for ports', async () => {
    const dir = await project('real/app');
    const link = join(base, 'link');
    await symlink(join(base, 'real'), link, 'dir');
    expect(await projectIdentity(join(link, 'app'), { homeDir })).toBe(
      await projectIdentity(dir, { homeDir }),
    );
    const port = await allocatePort(dir, { homeDir, isFree: allFree });
    expect(await allocatePort(join(link, 'app'), { homeDir, isFree: allFree })).toBe(port);
    await expect(claimConfigPort(join(link, 'app'), port, { homeDir })).resolves.toBeUndefined();
  });

  it.runIf(process.platform === 'darwin')(
    'treats another letter case as the same project on a case-insensitive Mac volume',
    async () => {
      const dir = await project('MyApp');
      const lower = join(base, 'myapp');
      const caseSensitive = await stat(lower).then(
        () => false,
        () => true,
      );
      if (caseSensitive) return;
      expect(await projectIdentity(lower, { homeDir })).toBe(
        await projectIdentity(dir, { homeDir }),
      );
      await claimConfigPort(dir, 9300, { homeDir });
      await expect(claimConfigPort(lower, 9300, { homeDir })).resolves.toBeUndefined();
    },
  );

  it('keeps two sibling projects whose names differ only by a suffix apart', async () => {
    const a = await project('app');
    const b = await project('app-2');
    expect(await projectIdentity(a, { homeDir })).not.toBe(await projectIdentity(b, { homeDir }));
    const portA = await allocatePort(a, { homeDir, isFree: allFree });
    const err = await failure(claimConfigPort(b, portA, { homeDir }));
    expect(err).toBeInstanceOf(PortClaimedError);
  });

  it('gives a project folder that does not exist yet a stable id', async () => {
    const missing = join(base, 'later');
    const id = await projectIdentity(missing, { homeDir });
    expect(await projectIdentity(missing, { homeDir })).toBe(id);
  });

  it('folds letter case for Windows-style paths only on Windows', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    const upper = join(base, 'Later-Win');
    const lower = join(base, 'later-win');
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const winUpper = await projectIdentity(upper, { homeDir });
      const winLower = await projectIdentity(lower, { homeDir });
      expect(winUpper).toBe(winLower);
    } finally {
      if (original !== undefined) Object.defineProperty(process, 'platform', original);
    }
    if (process.platform === 'linux') {
      expect(await projectIdentity(upper, { homeDir })).not.toBe(
        await projectIdentity(lower, { homeDir }),
      );
    }
  });

  it('never stores or shows the path in the id', async () => {
    const dir = await project('secret-client-name');
    const id = await projectIdentity(dir, { homeDir });
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    const other = await failure(
      (async () => {
        await allocatePort(await project('owner'), { homeDir, isFree: allFree });
        await claimConfigPort(dir, FIRST_PORT, { homeDir });
      })(),
    );
    expect(other.message).not.toContain('owner');
    expect(other.message).not.toContain(base);
  });
});

describe('port registry: allocation edges', () => {
  it('skips busy ports and registered ports together', async () => {
    const a = await project('a');
    const b = await project('b');
    expect(await allocatePort(a, { homeDir, isFree: allFree })).toBe(FIRST_PORT);
    const busy = new Set([FIRST_PORT + 1, FIRST_PORT + 2]);
    const port = await allocatePort(b, { homeDir, isFree: (p) => Promise.resolve(!busy.has(p)) });
    expect(port).toBe(FIRST_PORT + 3);
  });

  it('gives up with a clear error when no port is free', async () => {
    const err = await failure(
      allocatePort(await project('a'), { homeDir, isFree: () => Promise.resolve(false) }),
    );
    expect(err).toBeInstanceOf(PortRegistryError);
    expect(err.message).toContain('No free port');
  });

  it('does not write the registry when allocation fails', async () => {
    await allocatePort(await project('a'), { homeDir, isFree: allFree });
    const before = await readFile(registryPath(homeDir), 'utf8');
    await failure(
      allocatePort(await project('b'), { homeDir, isFree: () => Promise.resolve(false) }),
    );
    expect(await readFile(registryPath(homeDir), 'utf8')).toBe(before);
  });

  it('keeps one salt when many first calls race on a new machine', async () => {
    const dirs = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(project));
    const ids = await Promise.all(dirs.map((dir) => projectIdentity(dir, { homeDir })));
    const again = await Promise.all(dirs.map((dir) => projectIdentity(dir, { homeDir })));
    expect(again).toEqual(ids);
  });

  it('gives the same project the same port when it allocates twice at once', async () => {
    const dir = await project('a');
    const ports = await Promise.all([
      allocatePort(dir, { homeDir, isFree: allFree }),
      allocatePort(dir, { homeDir, isFree: allFree }),
    ]);
    expect(ports[0]).toBe(ports[1]);
    expect(await allocatePort(dir, { homeDir, isFree: allFree })).toBe(ports[0]);
  });

  // BUG-T3: two `init`s for different projects at the same moment both got 9147.
  it('never gives two projects the same port when they allocate at once (BUG-T3)', async () => {
    await projectIdentity(await project('seed'), { homeDir });
    const a = await project('a');
    const b = await project('b');
    const [portA, portB] = await Promise.all([
      allocatePort(a, { homeDir, isFree: allFree }),
      allocatePort(b, { homeDir, isFree: allFree }),
    ]);
    expect(portA).not.toBe(portB);
  });

  it('lets the owner re-claim its port after another project registered the next one', async () => {
    const a = await project('a');
    const b = await project('b');
    const portA = await allocatePort(a, { homeDir, isFree: allFree });
    await allocatePort(b, { homeDir, isFree: allFree });
    await expect(claimConfigPort(a, portA, { homeDir })).resolves.toBeUndefined();
  });

  it('moves a project to a new config port and frees the old one for others', async () => {
    const a = await project('a');
    const b = await project('b');
    await claimConfigPort(a, 9300, { homeDir });
    await claimConfigPort(a, 9301, { homeDir });
    await expect(claimConfigPort(b, 9300, { homeDir })).resolves.toBeUndefined();
    const err = await failure(claimConfigPort(b, 9301, { homeDir }));
    expect(err).toBeInstanceOf(PortClaimedError);
  });
});
