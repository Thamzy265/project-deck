/**
 * `--fake` (an in-memory app and database) is a developer and smoke-test switch of
 * dist/daemon.js only. The `pitdeck` command users run must refuse it everywhere, so a
 * user can never end up with a fake dashboard by mistake.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));

/**
 * The test's environment without NODE_PATH: pnpm's vitest launcher sets it to this
 * workspace's packages, which would let the copied bundle resolve them and hide a
 * missing bundled file.
 */
function isolatedEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env['NODE_PATH'];
  return env;
}

let scratch = '';
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'pitdeck-fake-flag-'));
});
afterAll(async () => {
  if (scratch !== '') await rm(scratch, { recursive: true, force: true });
});

describe('the bundled pitdeck command (run pnpm build first)', () => {
  it.each([
    ['--fake'],
    ['--fake', 'start'],
    ['start', '--fake'],
    ['start', '--fake=true'],
    ['start', '--project', '.', '--fake'],
    ['mcp', '--fake'],
    ['open', '--fake'],
    ['stop', '--fake'],
    ['init', '--fake'],
  ])('refuses %s with a usage error and starts nothing', (...args) => {
    const r = spawnSync(process.execPath, [join(DIST, 'cli.js'), ...args], {
      cwd: scratch,
      env: isolatedEnv({ HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home') }),
      encoding: 'utf8',
      input: '',
      timeout: 30_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Unknown (option|command)/);
    expect(existsSync(join(scratch, '.pitdeck'))).toBe(false);
  });

  it('holds the fake mode only in daemon.js', () => {
    const files = readdirSync(DIST).filter((f) => f.endsWith('.js'));
    const withFake = files.filter((f) =>
      /registerFake|FakeAppConnector|fake: \{ type: "boolean"/.test(
        readFileSync(join(DIST, f), 'utf8'),
      ),
    );
    expect(withFake).toEqual(['daemon.js']);
  });
});
