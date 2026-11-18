/**
 * scripts/dev-marketplace.mjs: the contributors' marketplace. It copies plugin/ into a
 * git-ignored folder and points the copy's pitdeck server at this checkout's build, so the
 * public marketplace entry never has to point at a checkout.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLUGIN, REPO } from './paths.js';

const SCRIPT = join(REPO, 'scripts', 'dev-marketplace.mjs');

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'deck-dev-market-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function run(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    execFile(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof err.code === 'number' ? err.code : 1;
      done({ code, out: `${stdout}${stderr}` });
    });
  });
}

/** A stand-in for packages/pitdeck/dist/cli.js, so the test doesn't need a build. */
async function fakeCli(): Promise<string> {
  const cli = join(scratch, 'build', 'cli.js');
  await mkdir(join(scratch, 'build'));
  await writeFile(cli, '');
  return cli;
}

const readJson = async (...parts: string[]): Promise<unknown> =>
  JSON.parse(await readFile(join(...parts), 'utf8')) as unknown;

describe('the development marketplace script', () => {
  it('writes a pitdeck-dev marketplace whose plugin runs this checkout’s CLI', async () => {
    const out = join(scratch, 'market');
    const cli = await fakeCli();
    const result = await run(['--out', out, '--cli', cli]);
    expect(result.code).toBe(0);
    expect(await readJson(out, '.claude-plugin', 'marketplace.json')).toMatchObject({
      name: 'pitdeck-dev',
      plugins: [{ name: 'pitdeck', source: './pitdeck' }],
    });
    const mcp = (await readJson(out, 'pitdeck', '.mcp.json')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(mcp.mcpServers['pitdeck']).toEqual({
      type: 'stdio',
      command: 'node',
      args: [cli, 'mcp'],
    });
    const shipped = (await readJson(PLUGIN, '.mcp.json')) as { mcpServers: { dart: unknown } };
    expect(mcp.mcpServers['dart']).toEqual(shipped.mcpServers.dart);
    // Everything else is the shipped plugin as it is.
    expect((await readdir(join(out, 'pitdeck'))).sort()).toEqual((await readdir(PLUGIN)).sort());
    expect(await readFile(join(out, 'pitdeck', 'skills', 'db', 'SKILL.md'), 'utf8')).toBe(
      await readFile(join(PLUGIN, 'skills', 'db', 'SKILL.md'), 'utf8'),
    );
    expect(result.out).toContain('claude plugin install pitdeck@pitdeck-dev');
  });

  it('refuses without a build, and writes nothing', async () => {
    const out = join(scratch, 'market');
    const result = await run(['--out', out, '--cli', join(scratch, 'missing', 'cli.js')]);
    expect(result.code).toBe(1);
    expect(result.out).toContain('pnpm build');
    await expect(readdir(out)).rejects.toThrow();
  });

  it('replaces an earlier copy, so a file removed from plugin/ goes too', async () => {
    const out = join(scratch, 'market');
    const cli = await fakeCli();
    expect((await run(['--out', out, '--cli', cli])).code).toBe(0);
    await writeFile(join(out, 'pitdeck', 'stale.txt'), 'old');
    expect((await run(['--out', out, '--cli', cli])).code).toBe(0);
    expect(await readdir(join(out, 'pitdeck'))).not.toContain('stale.txt');
  });

  it('never replaces a folder it did not write', async () => {
    const out = join(scratch, 'someone-elses');
    await mkdir(out);
    await writeFile(join(out, 'keep.txt'), 'mine');
    const result = await run(['--out', out, '--cli', await fakeCli()]);
    expect(result.code).toBe(1);
    expect(await readFile(join(out, 'keep.txt'), 'utf8')).toBe('mine');
  });
});
