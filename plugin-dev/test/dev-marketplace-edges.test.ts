/**
 * scripts/dev-marketplace.mjs on the paths a contributor might hand it (M5 batch 3):
 * folders with spaces, links, files, a re-run, a bad option. It must write only its --out,
 * leave the real HOME and Claude config alone, and never commit its output.
 */
import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLUGIN, REPO } from './paths.js';

const SCRIPT = join(REPO, 'scripts', 'dev-marketplace.mjs');
const links = process.platform === 'win32' ? it.skip : it;

let scratch: string;
let home: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'deck dev market edges-'));
  home = join(scratch, 'home');
  await mkdir(home);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function run(args: string[]): Promise<{ code: number; out: string }> {
  // A scratch HOME: if the script ever wrote Claude config, it would show up here.
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, 'c') };
  return new Promise((done) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env, encoding: 'utf8' },
      (err, stdout, stderr) => {
        done({
          code: err === null ? 0 : typeof err.code === 'number' ? err.code : 1,
          out: `${stdout}${stderr}`,
        });
      },
    );
  });
}

async function fakeCli(...parts: string[]): Promise<string> {
  const dir = join(scratch, ...parts);
  await mkdir(dir, { recursive: true });
  const cli = join(dir, 'cli.js');
  await writeFile(cli, '');
  return cli;
}

const mcpOf = async (out: string): Promise<{ mcpServers: Record<string, unknown> }> =>
  JSON.parse(await readFile(join(out, 'pitdeck', '.mcp.json'), 'utf8')) as {
    mcpServers: Record<string, unknown>;
  };

describe('dev marketplace script: paths', () => {
  it('handles spaces in --out and --cli, and keeps the path as one argument', async () => {
    const cli = await fakeCli('a build dir');
    const out = join(scratch, 'out dir');
    expect((await run(['--out', out, '--cli', cli])).code).toBe(0);
    expect((await mcpOf(out)).mcpServers['pitdeck']).toEqual({
      type: 'stdio',
      command: 'node',
      args: [cli, 'mcp'],
    });
  });

  it('resolves a relative --cli against the working folder, so the server gets an absolute path', async () => {
    const cli = await fakeCli('rel');
    const out = join(scratch, 'out');
    const result = await new Promise<number>((done) => {
      execFile(
        process.execPath,
        [SCRIPT, '--out', out, '--cli', 'rel/cli.js'],
        { cwd: scratch, env: { ...process.env, HOME: home, USERPROFILE: home } },
        (err) => done(err === null ? 0 : 1),
      );
    });
    expect(result).toBe(0);
    const server = (await mcpOf(out)).mcpServers['pitdeck'] as { args: string[] };
    expect(isAbsolute(server.args[0] ?? '')).toBe(true);
    // macOS reaches the same folder as /var and /private/var.
    expect(await realpath(server.args[0] ?? '')).toBe(await realpath(cli));
    expect(server.args[1]).toBe('mcp');
  });

  it('refuses an --out that is a file, and leaves it as it was', async () => {
    const out = join(scratch, 'afile');
    await writeFile(out, 'mine');
    const result = await run(['--out', out, '--cli', await fakeCli('b')]);
    expect(result.code).toBe(1);
    expect(await readFile(out, 'utf8')).toBe('mine');
  });

  links('refuses a link to a folder it did not write, and leaves the target alone', async () => {
    const target = join(scratch, 'foreign');
    await mkdir(target);
    await writeFile(join(target, 'keep.txt'), 'mine');
    const out = join(scratch, 'link');
    await symlink(target, out, 'dir');
    const result = await run(['--out', out, '--cli', await fakeCli('c')]);
    expect(result.code).toBe(1);
    expect(await readdir(target)).toEqual(['keep.txt']);
  });

  links('never writes through a link to one of its own folders: the target stays', async () => {
    const cli = await fakeCli('d');
    const real = join(scratch, 'real');
    expect((await run(['--out', real, '--cli', cli])).code).toBe(0);
    await writeFile(join(real, 'extra.txt'), 'x');
    const out = join(scratch, 'link');
    await symlink(real, out, 'dir');
    expect((await run(['--out', out, '--cli', cli])).code).toBe(0);
    // The link is replaced, not followed: the earlier folder keeps what it had.
    expect(await readFile(join(real, 'extra.txt'), 'utf8')).toBe('x');
  });

  it('exits 1 with no output folder for an unknown option or a missing value', async () => {
    const out = join(scratch, 'never');
    expect((await run(['--bogus'])).code).toBe(1);
    expect((await run(['--out'])).code).toBe(1);
    expect((await run(['--out', out, 'extra-positional', '--cli', await fakeCli('e')])).code).toBe(
      1,
    );
    await expect(readdir(out)).rejects.toThrow();
  });
});

describe('dev marketplace script: what it touches', () => {
  it('writes nothing in HOME or the Claude config folder', async () => {
    const out = join(scratch, 'out');
    expect((await run(['--out', out, '--cli', await fakeCli('f')])).code).toBe(0);
    expect(await readdir(home)).toEqual([]);
  });

  it('can run twice in a row to the same result, and still leaves the marker', async () => {
    const cli = await fakeCli('g');
    const out = join(scratch, 'out');
    expect((await run(['--out', out, '--cli', cli])).code).toBe(0);
    const first = await mcpOf(out);
    expect((await run(['--out', out, '--cli', cli])).code).toBe(0);
    expect(await mcpOf(out)).toEqual(first);
    expect(await readdir(out)).toContain('.pitdeck-dev-marketplace');
  });

  it('leaves the shipped plugin/ folder byte for byte as it was', async () => {
    const before = await readFile(join(PLUGIN, '.mcp.json'), 'utf8');
    const out = join(scratch, 'out');
    await run(['--out', out, '--cli', await fakeCli('h')]);
    expect(await readFile(join(PLUGIN, '.mcp.json'), 'utf8')).toBe(before);
    expect(before).toContain('"npx"');
  });

  it('keeps the shipped pin in the copy for every server but pitdeck', async () => {
    const out = join(scratch, 'out');
    await run(['--out', out, '--cli', await fakeCli('i')]);
    const servers = Object.keys((await mcpOf(out)).mcpServers).sort();
    expect(servers).toEqual(['dart', 'pitdeck']);
  });
});

// Without any GIT_* variable, which would point git somewhere else.
const gitEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));

// A source archive or a copy of the folder has no git history to ask.
const inGit = ((): boolean => {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: REPO,
      env: gitEnv(),
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!inGit)('the generated marketplace is never committed', () => {
  const env = gitEnv;

  it('is git-ignored at its default location, whole and file by file', () => {
    let ignored: string;
    try {
      ignored = execFileSync(
        'git',
        ['check-ignore', 'plugin-dev/marketplace/', 'plugin-dev/marketplace/pitdeck/.mcp.json'],
        { cwd: REPO, env: env(), encoding: 'utf8' },
      );
    } catch (err) {
      throw new Error(`git did not ignore the default output folder: ${String(err)}`);
    }
    expect(ignored.split('\n').filter((l) => l !== '')).toHaveLength(2);
  });

  it('has no tracked file under plugin-dev/marketplace/', () => {
    const tracked = execFileSync('git', ['ls-files', '--', 'plugin-dev/marketplace'], {
      cwd: REPO,
      env: env(),
      encoding: 'utf8',
    });
    expect(tracked).toBe('');
  });
});

describe('dev marketplace script: arguments checked before anything is deleted', () => {
  // T-B3-1: --cli inside --out. The script used to delete --out first, so the CLI it was told to
  // run is gone and the generated .mcp.json points at a missing file, with exit code 0.
  it('does not report success when --cli lives inside the folder it replaces', async () => {
    const out = join(scratch, 'out');
    expect((await run(['--out', out, '--cli', await fakeCli('j')])).code).toBe(0);
    const inside = join(out, 'cli.js');
    await writeFile(inside, '');
    const again = await run(['--out', out, '--cli', inside]);
    const gone = await readdir(out).then((names) => !names.includes('cli.js'));
    expect(again.code === 0 && gone).toBe(false);
  });

  // T-B3-2: --out inside plugin/. cp used to refuse to copy into itself, after the script had
  // already made the folder, so plugin/<out> is left behind in the shipped folder.
  it('leaves nothing behind when --out is inside plugin/', async () => {
    const out = join(PLUGIN, `zz-tester-probe-${String(process.pid)}`);
    try {
      await run(['--out', out, '--cli', await fakeCli('k')]);
      expect(await readdir(PLUGIN)).not.toContain(`zz-tester-probe-${String(process.pid)}`);
    } finally {
      await rm(out, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe('dev marketplace script: overlap with plugin/ is judged on real paths', () => {
  // The folder name `..dev` starts with two dots but is a child of plugin/.
  it('refuses --out plugin/..dev, which is inside plugin/', async () => {
    const out = join(PLUGIN, '..dev');
    try {
      const result = await run(['--out', out, '--cli', await fakeCli('o1')]);
      expect(result.code).toBe(1);
      expect(existsSync(out)).toBe(false);
    } finally {
      await rm(out, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  const foldsCase = existsSync(join(REPO, 'PLUGIN'));
  (foldsCase ? it : it.skip)('refuses --out Plugin/dev on a case-insensitive disk', async () => {
    const out = join(REPO, 'Plugin', 'zz-case-probe');
    try {
      const result = await run(['--out', out, '--cli', await fakeCli('o2')]);
      expect(result.code).toBe(1);
      expect(existsSync(join(PLUGIN, 'zz-case-probe'))).toBe(false);
    } finally {
      await rm(join(PLUGIN, 'zz-case-probe'), { recursive: true, force: true });
    }
  });

  links('refuses an --out reached through a link to plugin/', async () => {
    const link = join(scratch, 'to-plugin');
    await symlink(PLUGIN, link, 'dir');
    const inside = join(PLUGIN, 'zz-link-probe');
    try {
      const result = await run([
        '--out',
        join(link, 'zz-link-probe'),
        '--cli',
        await fakeCli('o3'),
      ]);
      expect(result.code).toBe(1);
      expect(existsSync(inside)).toBe(false);
    } finally {
      await rm(inside, { recursive: true, force: true });
    }
  });

  links('refuses a --cli that is inside --out through a link, and deletes nothing', async () => {
    const out = join(scratch, 'out');
    expect((await run(['--out', out, '--cli', await fakeCli('o4')])).code).toBe(0);
    await writeFile(join(out, 'cli.js'), '');
    const link = join(scratch, 'to-out');
    await symlink(out, link, 'dir');
    const result = await run(['--out', out, '--cli', join(link, 'cli.js')]);
    expect(result.code).toBe(1);
    expect(existsSync(join(out, 'cli.js'))).toBe(true);
  });
});

describe('dev marketplace script: a failed run', () => {
  it('leaves the marker, so the next run may replace the folder', async () => {
    // A copy of the script beside a plugin/ whose .mcp.json is broken: the run fails after
    // it made the folder and copied plugin/.
    const root = join(scratch, 'fake-root');
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'plugin'), { recursive: true });
    copyFileSync(SCRIPT, join(root, 'scripts', 'dev-marketplace.mjs'));
    const mcp = join(root, 'plugin', '.mcp.json');
    writeFileSync(mcp, '{ not json');
    const cli = await fakeCli('o5');
    const out = join(scratch, 'out');
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const go = (): Promise<number> =>
      new Promise((done) =>
        execFile(
          process.execPath,
          [join(root, 'scripts', 'dev-marketplace.mjs'), '--out', out, '--cli', cli],
          { env },
          (err) => done(err === null ? 0 : 1),
        ),
      );
    expect(await go()).toBe(1);
    expect(existsSync(join(out, '.pitdeck-dev-marketplace'))).toBe(true);
    writeFileSync(
      mcp,
      JSON.stringify({ mcpServers: { pitdeck: { type: 'stdio', command: 'npx', args: [] } } }),
    );
    expect(await go()).toBe(0);
    expect(dirname(out)).toBe(scratch);
  });
});
