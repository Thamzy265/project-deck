#!/usr/bin/env node
// Smoke test of the packed `pitdeck` npm package (M5 batch 2): installs the tarball into a
// scratch folder the way a user's npx would, then runs it from there, never from the
// workspace. Prints a CHECK/RESULT table and exits 1 on any failure.
//
// Usage: pnpm build && node scripts/smoke/tarball.mjs [path/to/pitdeck-<version>.tgz]
// Without a path it packs packages/pitdeck first (npm pack, into the scratch folder).
//
// Safety: everything happens in one new scratch folder, which is removed at the end.
// HOME, USERPROFILE and npm's cache point into it, so the real home is never touched.
// Only 127.0.0.1 is contacted. The token is read from .pitdeck/runtime.json into memory
// and never printed; child output shown on failure has it masked. `npm install` gets
// --ignore-scripts, and npx runs offline with "yes" off, so a missing local install fails
// instead of fetching a package called pitdeck from the registry. Every step has a timeout.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const { fetch, AbortSignal } = globalThis;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WIN = process.platform === 'win32';
const STEP_MS = 60_000;
/** Tools Pitdeck's MCP server must list (CLAUDE.md: no Dart MCP server duplicates). */
const TOOLS = ['deck_status', 'get_logs', 'db_list', 'db_schema', 'db_query', 'db_snapshot'];

const rows = [];
const secrets = [];
const mask = (text) => secrets.reduce((t, s) => t.split(s).join('<token>'), String(text));

function record(check, ok, detail = '') {
  rows.push([check, ok ? 'PASS' : 'FAIL', mask(detail).replace(/\s+/g, ' ').slice(0, 160)]);
  return ok;
}
function info(check, detail) {
  rows.push([check, 'INFO', mask(detail).replace(/\s+/g, ' ').slice(0, 160)]);
}

/**
 * The command line for npx. On Windows npx is npx.cmd, which Node only runs through a
 * shell; `cmd /c` is the same wrapper a `.mcp.json` would need (notes/m5-release.md).
 * No npx flags: npx reads `--no pitdeck --version` as its own --version.
 */
const npx = (args) => (WIN ? ['cmd.exe', ['/d', '/c', 'npx', ...args]] : ['npx', args]);
const npm = (args) => (WIN ? ['cmd.exe', ['/d', '/c', 'npm', ...args]] : ['npm', args]);

/** Runs a command to the end, with a timeout, and returns its output. Never rejects. */
function run([command, args], { cwd, env, timeoutMs = STEP_MS }) {
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(command, args, { cwd, env, shell: false, windowsHide: true });
    } catch (err) {
      done({ code: null, stdout, stderr, error: err });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done({ code: null, stdout, stderr, error: new Error(`timed out after ${timeoutMs} ms`) });
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ code: null, stdout, stderr, error: err });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}

const why = (r) => r.error?.message ?? `exit ${r.code}: ${r.stderr || r.stdout}`;

async function waitFor(what, fn, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try {
      value = await fn();
    } catch (err) {
      // ENOENT and friends mean "not yet"; a stated reason ends the wait.
      if (err instanceof Error && err.message.startsWith('daemon exited')) throw err;
    }
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`${what}: timed out after ${timeoutMs} ms`);
    await sleep(200);
  }
}

/** A loopback request to the daemon, with a timeout. */
function daemonFetch(port, path, init = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    signal: AbortSignal.timeout(10_000),
  });
}

/** Newline-delimited JSON-RPC over the MCP server's stdio. */
function mcpClient(child) {
  const pending = new Map();
  let buffer = '';
  let nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line === '') continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  child.stdin.on('error', () => undefined);
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  return {
    notify: (method, params = {}) => send({ jsonrpc: '2.0', method, params }),
    request(method, params = {}, timeoutMs = 20_000) {
      const id = nextId++;
      return new Promise((done, fail) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          fail(new Error(`${method}: no answer in ${timeoutMs} ms`));
        }, timeoutMs);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          if (msg.error) fail(new Error(`${method}: ${msg.error.message}`));
          else done(msg.result);
        });
        send({ jsonrpc: '2.0', id, method, params });
      });
    },
  };
}

const toolJson = (result) => JSON.parse(result?.content?.[0]?.text ?? 'null');

async function main(scratch, tarballArg) {
  const home = join(scratch, 'home');
  // The install folder is also the "project": npx finds pitdeck in its node_modules, and
  // the daemon keeps .pitdeck/ here.
  const app = join(scratch, 'app');
  await mkdir(home);
  await mkdir(app);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    npm_config_cache: join(scratch, 'npm-cache'),
    npm_config_userconfig: join(scratch, 'npmrc'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  };
  await writeFile(join(scratch, 'npmrc'), '');
  // npx must run the local install or fail, never fetch a package named pitdeck.
  const npxEnv = { ...env, npm_config_yes: 'false', npm_config_offline: 'true' };

  // 1. The tarball.
  let tarball = tarballArg === undefined ? undefined : resolve(tarballArg);
  if (tarball === undefined) {
    const r = await run(
      npm(['pack', '--ignore-scripts', '--pack-destination', scratch, '--json']),
      { cwd: join(ROOT, 'packages', 'pitdeck'), env },
    );
    const name = r.code === 0 ? JSON.parse(r.stdout)[0]?.filename : undefined;
    if (!record('npm pack', typeof name === 'string', name ?? why(r))) return;
    tarball = join(scratch, name);
  }
  record('tarball name', /pitdeck-\d+\.\d+\.\d+\.tgz$/.test(tarball), tarball.split(/[\\/]/).pop());

  // 2. Install it like a user would, with no install scripts.
  await writeFile(join(app, 'package.json'), '{ "name": "smoke-app", "private": true }\n');
  const installed = await run(
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball]),
    { cwd: app, env, timeoutMs: 120_000 },
  );
  if (!record('npm install --ignore-scripts', installed.code === 0, why(installed))) return;
  const pkgDir = join(app, 'node_modules', 'pitdeck');
  const { version } = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));
  const extra = (await readdir(join(app, 'node_modules'))).filter(
    (n) => !['pitdeck', '.bin', '.package-lock.json'].includes(n),
  );
  record('installs no other package', extra.length === 0, extra.join(', '));

  // 3. The bin through npx.
  const help = await run(npx(['pitdeck', '--help']), { cwd: app, env: npxEnv });
  record('npx pitdeck --help', help.code === 0 && /Usage: pitdeck/.test(help.stdout), why(help));
  const ver = await run(npx(['pitdeck', '--version']), { cwd: app, env: npxEnv });
  record(
    'npx pitdeck --version',
    ver.stdout.trim() === version,
    `${ver.stdout.trim()} vs ${version}`,
  );
  if (WIN) {
    // D2 (ADR 0007): can a launcher run npx without a shell, as an .mcp.json "command"?
    for (const command of ['npx', 'npx.cmd']) {
      const r = await run([command, ['pitdeck', '--version']], { cwd: app, env: npxEnv });
      info(
        `${command} without a shell`,
        r.error ? `fails: ${r.error.code ?? r.error.message}` : `exit ${r.code}`,
      );
    }
  }

  // 4. The daemon in fake mode, from the installed package, on a free port. The MCP
  // server only serves a folder `pitdeck init` set up; init needs a Flutter project, so
  // the smoke test writes the smallest config it would leave.
  await mkdir(join(app, '.pitdeck'));
  await writeFile(join(app, '.pitdeck', 'config.json'), '{ "version": 1 }\n');
  const daemonLog = [];
  const daemon = spawn(
    process.execPath,
    [join(pkgDir, 'dist', 'daemon.js'), '--fake', '--port', '0', '--project', app],
    { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  daemon.on('error', (err) => daemonLog.push(err.message));
  daemon.stdout.on('data', (d) => daemonLog.push(String(d)));
  daemon.stderr.on('data', (d) => daemonLog.push(String(d)));
  const exited = new Promise((done) => daemon.once('exit', done));
  try {
    const runtime = await waitFor('runtime.json', async () => {
      if (daemon.exitCode !== null) throw new Error(`daemon exited with ${daemon.exitCode}`);
      return JSON.parse(await readFile(join(app, '.pitdeck', 'runtime.json'), 'utf8'));
    }).catch((err) => {
      record('daemon starts (--fake)', false, `${err.message} ${daemonLog.join(' ')}`);
      return undefined;
    });
    if (runtime === undefined) return;
    secrets.push(runtime.token);
    const { port } = runtime;
    record('daemon starts (--fake)', true, `port ${port}`);
    const auth = { 'x-deck-token': runtime.token };

    const health = await daemonFetch(port, '/api/health').then((r) => r.json());
    record('GET /api/health', health.ok === true && health.version === version, health.version);
    const noToken = await daemonFetch(port, '/api/status');
    record('GET /api/status without token is 401', noToken.status === 401, `${noToken.status}`);
    const status = await daemonFetch(port, '/api/status', { headers: auth });
    record('GET /api/status with token', status.status === 200, `${status.status}`);

    // 5. The dashboard: open the login window, load the page as a browser would, then one asset.
    const login = await daemonFetch(port, '/api/login-window', { method: 'POST', headers: auth });
    const page = await daemonFetch(port, '/', {
      headers: { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' },
    });
    const html = await page.text();
    const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    record('dashboard page', login.ok && page.ok && script !== undefined, `${page.status}`);
    if (script !== undefined) {
      const asset = await daemonFetch(port, script, { headers: auth });
      const type = asset.headers.get('content-type') ?? '';
      record(
        'dashboard asset',
        asset.ok && type.startsWith('text/javascript'),
        `${asset.status} ${type}`,
      );
    }

    // 6. The MCP server over stdio, through npx, against this daemon.
    const [command, args] = npx(['pitdeck', 'mcp']);
    const mcpErr = [];
    const mcp = spawn(command, args, { cwd: app, env: npxEnv, stdio: 'pipe', windowsHide: true });
    mcp.on('error', (err) => mcpErr.push(err.message));
    mcp.stderr.on('data', (d) => mcpErr.push(String(d)));
    const mcpExited = new Promise((done) => mcp.once('exit', done));
    try {
      const client = mcpClient(mcp);
      const init = await client.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'pitdeck-smoke', version: '0' },
      });
      record('MCP initialize', init?.serverInfo?.name === 'pitdeck', init?.serverInfo?.name);
      client.notify('notifications/initialized');
      const { tools } = await client.request('tools/list');
      const names = tools.map((t) => t.name);
      const missing = TOOLS.filter((t) => !names.includes(t));
      record(
        'MCP tools/list',
        missing.length === 0,
        missing.length ? `missing ${missing}` : names.join(' '),
      );

      // The fake app attaches by itself shortly after start.
      await waitFor('attached app', async () => {
        const s = await daemonFetch(port, '/api/status', { headers: auth }).then((r) => r.json());
        return s.attached ?? undefined;
      });
      const list = toolJson(await client.request('tools/call', { name: 'db_list', arguments: {} }));
      const db = list?.databases?.[0]?.name;
      const query = await client.request('tools/call', {
        name: 'db_query',
        arguments: { db, sql: 'SELECT count(*) AS n FROM orders' },
      });
      const result = query?.isError ? undefined : toolJson(query);
      const n = result?.rows?.[0]?.[0];
      record(
        'MCP db_query (fake)',
        typeof n === 'number' && n > 0,
        result === undefined ? JSON.stringify(query) : `db ${db}: ${n} orders`,
      );
      // A write never reaches the database: the read-only gate (sql-guard worker) refuses it.
      const write = await client.request('tools/call', {
        name: 'db_query',
        arguments: { db, sql: 'DELETE FROM orders' },
      });
      record('MCP db_query refuses a write', write?.isError === true, write?.content?.[0]?.text);
    } catch (err) {
      record('MCP server', false, `${err.message} ${mcpErr.join(' ')}`);
    } finally {
      mcp.stdin.end();
      const closed = await Promise.race([mcpExited.then(() => true), sleep(10_000, false)]);
      if (!closed) mcp.kill();
      record('MCP server exits when stdin closes', closed);
    }

    // 7. Stop through the CLI.
    const stop = await run(npx(['pitdeck', 'stop']), { cwd: app, env: npxEnv });
    record('npx pitdeck stop', stop.code === 0 && /stopped/.test(stop.stdout), why(stop));
    const gone = await Promise.race([exited.then(() => true), sleep(15_000, false)]);
    record('daemon exits', gone);
  } finally {
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill();
    await Promise.race([exited, sleep(5000)]);
  }
}

const scratch = await mkdtemp(join(tmpdir(), 'pitdeck-smoke-'));
try {
  await main(scratch, process.argv[2]);
} catch (err) {
  record('smoke test', false, err instanceof Error ? err.message : String(err));
} finally {
  // Only the folder made above. Windows may hold a file briefly after a process exits.
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch((err) =>
    info('clean-up', `left ${scratch}: ${err.message}`),
  );
}

const width = Math.max(...rows.map((r) => r[0].length));
console.log(`${'CHECK'.padEnd(width)}  RESULT  DETAIL`);
for (const [check, result, detail] of rows) {
  console.log(`${check.padEnd(width)}  ${result.padEnd(6)}  ${detail}`);
}
const failed = rows.filter((r) => r[1] === 'FAIL').length;
console.log(
  `\n${process.platform} node ${process.version}: ${failed === 0 ? 'PASS' : `FAIL (${failed})`}`,
);
process.exitCode = failed === 0 && rows.length > 0 ? 0 : 1;
