/**
 * scripts/smoke/tarball.mjs on its failure paths (M5 batch 2): a broken package must fail
 * the run loudly (exit 1, a FAIL row), and the run must still remove its scratch folder,
 * stop the processes it started and never print the token. The packages here are tiny
 * hand-made stand-ins, packed offline into a scratch folder; TMPDIR points the script's own
 * scratch folder there too, and HOME and npm's cache never reach the real home.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../../scripts/smoke/tarball.mjs', import.meta.url));
// Built at run time so it never looks like a real credential.
const TOKEN = ['smoke', 'secret', 'value', String(Date.now())].join('-');

const CLI = `#!/usr/bin/env node
const fs = require('node:fs');
const [cmd] = process.argv.slice(2);
if (cmd === '--help') console.log('Usage: pitdeck <command>');
else if (cmd === '--version') console.log('0.0.1');
else if (cmd === 'mcp') {
  // Quotes the token back, as a broken server might: the script must mask it.
  const { token } = JSON.parse(fs.readFileSync('.pitdeck/runtime.json', 'utf8'));
  process.stderr.write('mcp saw ' + token + '\\n');
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    for (let at = buf.indexOf('\\n'); at >= 0; at = buf.indexOf('\\n')) {
      const msg = JSON.parse(buf.slice(0, at));
      buf = buf.slice(at + 1);
      const reply = { jsonrpc: '2.0', id: msg.id, error: { code: -1, message: 'bad ' + token } };
      if (msg.id !== undefined) process.stdout.write(JSON.stringify(reply) + '\\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
} else process.exit(1);
`;

const DAEMON = `const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
if (process.env.SMOKE_FAKE_MODE === 'crash') {
  console.error('fake daemon failed to start');
  process.exit(3);
}
fs.writeFileSync(process.env.SMOKE_FAKE_PIDFILE, String(process.pid));
const token = process.env.SMOKE_FAKE_TOKEN;
const project = process.argv[process.argv.indexOf('--project') + 1];
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api/health') return res.end(JSON.stringify({ ok: true, version: token }));
  if (req.headers['x-deck-token'] !== token) res.statusCode = 401;
  res.end('{}');
});
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  fs.writeFileSync(path.join(project, '.pitdeck', 'runtime.json'), JSON.stringify({ token, port }));
});
`;

let scratch = '';
let tarball = '';

function scratchEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // Without NODE_PATH: pnpm's vitest launcher points it at this workspace's packages.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['NODE_PATH'];
  return {
    ...env,
    TMPDIR: join(scratch, 'tmp'),
    TEMP: join(scratch, 'tmp'),
    TMP: join(scratch, 'tmp'),
    HOME: join(scratch, 'home'),
    USERPROFILE: join(scratch, 'home'),
    npm_config_cache: join(scratch, 'npm-cache'),
    npm_config_userconfig: join(scratch, 'npmrc'),
    npm_config_offline: 'true',
    npm_config_update_notifier: 'false',
    ...extra,
  };
}

interface Run {
  code: number | null;
  out: string;
}

function runSmoke(args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env, timeout: 100_000, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === 'number' ? err.code : null;
        done({ code, out: `${stdout}\n${stderr}` });
      },
    );
  });
}

const leftovers = async () =>
  (await readdir(join(scratch, 'tmp'))).filter((n) => n.startsWith('pitdeck-smoke-'));

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'pitdeck-smoke-test-'));
  for (const dir of ['tmp', 'home', 'pkg/dist'])
    await mkdir(join(scratch, dir), { recursive: true });
  await writeFile(join(scratch, 'npmrc'), '');
  await writeFile(
    join(scratch, 'pkg', 'package.json'),
    JSON.stringify({ name: 'pitdeck', version: '0.0.1', bin: { pitdeck: 'dist/cli.js' } }),
  );
  await writeFile(join(scratch, 'pkg', 'dist', 'cli.js'), CLI, { mode: 0o755 });
  await writeFile(join(scratch, 'pkg', 'dist', 'daemon.js'), DAEMON);
  const packed = await new Promise<string>((done, fail) => {
    const [command, argv] =
      process.platform === 'win32'
        ? ['cmd.exe', ['/d', '/c', 'npm', 'pack', '--json', '--ignore-scripts']]
        : ['npm', ['pack', '--json', '--ignore-scripts']];
    execFile(
      command,
      argv,
      { cwd: join(scratch, 'pkg'), env: scratchEnv(), timeout: 60_000, encoding: 'utf8' },
      (err, stdout) => {
        if (err === null) done(stdout);
        else fail(new Error(`npm pack failed: ${err.message}`));
      },
    );
  });
  const name = (JSON.parse(packed) as { filename: string }[])[0]?.filename ?? '';
  tarball = join(scratch, 'pkg', name);
});

afterAll(async () => {
  if (scratch !== '') await rm(scratch, { recursive: true, force: true });
});

describe('the tarball smoke script, failing (scripts/smoke/tarball.mjs)', () => {
  it('fails and cleans up when the tarball does not exist', async () => {
    const run = await runSmoke([join(scratch, 'missing-9.9.9.tgz')], scratchEnv());
    expect(run.code).toBe(1);
    expect(run.out).toMatch(/npm install --ignore-scripts\s+FAIL/);
    expect(run.out).toMatch(/: FAIL \(\d+\)/);
    expect(await leftovers()).toEqual([]);
  });

  it('fails and cleans up when the daemon exits without writing a port', async () => {
    const run = await runSmoke(
      [tarball],
      scratchEnv({ SMOKE_FAKE_MODE: 'crash', SMOKE_FAKE_PIDFILE: join(scratch, 'pid-crash') }),
    );
    expect(run.code).toBe(1);
    expect(run.out).toMatch(/daemon starts \(--fake\)\s+FAIL\s+daemon exited with 3/);
    expect(await leftovers()).toEqual([]);
  });

  it('masks the token, fails, stops its daemon and cleans up when the checks fail', async () => {
    const pidFile = join(scratch, 'pid-serve');
    const run = await runSmoke(
      [tarball],
      scratchEnv({
        SMOKE_FAKE_MODE: 'serve',
        SMOKE_FAKE_PIDFILE: pidFile,
        SMOKE_FAKE_TOKEN: TOKEN,
      }),
    );
    expect(run.code).toBe(1);
    // The fake daemon reports the token as its version and the fake MCP server quotes it.
    expect(run.out).toMatch(/GET \/api\/health\s+FAIL\s+<token>/);
    expect(run.out).toMatch(/MCP server\s+FAIL.*<token>/);
    expect(run.out).not.toContain(TOKEN);
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(alive(pid)).toBe(false);
    expect(await leftovers()).toEqual([]);
  }, 110_000);
});

describe('the tarball smoke script source', () => {
  it('contacts only 127.0.0.1', async () => {
    const source = await readFile(SCRIPT, 'utf8');
    const urls = [...source.matchAll(/\b(?:https?|wss?):\/\/[^\s`'"]+/g)].map((m) => m[0]);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((u) => !u.startsWith('http://127.0.0.1:'))).toEqual([]);
    expect(source).not.toMatch(/localhost|0\.0\.0\.0|registry\.npmjs/);
  });
});
