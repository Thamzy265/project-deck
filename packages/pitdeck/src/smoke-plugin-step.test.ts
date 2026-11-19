/**
 * The plugin step of scripts/smoke/tarball.mjs (M5 batch 3): a package that is at the
 * version plugin/.mcp.json pins must make `npx -y pitdeck@<pin> mcp` start through a
 * registry on 127.0.0.1 that serves only that tarball. The stand-in package below is
 * hand-made: an MCP server that answers initialize and tools/list, and a daemon that
 * writes runtime.json. Nothing here reaches a real registry; HOME and npm's cache are scratch.
 */
import { execFile, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'smoke', 'tarball.mjs');
const TOOLS = ['deck_status', 'get_logs', 'db_list', 'db_schema', 'db_query', 'db_snapshot'];

// Same shape as a real stdio MCP server: newline-delimited JSON-RPC.
const CLI = `#!/usr/bin/env node
const fs = require('node:fs');
const [cmd] = process.argv.slice(2);
const tools = ${JSON.stringify(TOOLS)};
function daemonAlive() {
  try {
    process.kill(JSON.parse(fs.readFileSync('.pitdeck/runtime.json', 'utf8')).pid, 0);
    return true;
  } catch {
    return false;
  }
}
if (cmd === '--help') console.log('Usage: pitdeck <command>');
else if (cmd === '--version') console.log(require('../package.json').version);
else if (cmd === 'stop') {
  const { pid } = JSON.parse(fs.readFileSync('.pitdeck/runtime.json', 'utf8'));
  process.kill(pid);
  console.log('Pitdeck stopped.');
} else if (cmd === 'mcp') {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    for (let at = buf.indexOf('\\n'); at >= 0; at = buf.indexOf('\\n')) {
      const msg = JSON.parse(buf.slice(0, at));
      buf = buf.slice(at + 1);
      if (msg.id === undefined) continue;
      // Like the real server: the first call starts a daemon in the background, which
      // writes runtime.json a little later. A stop that runs before then would miss it.
      // Only when none answers, as the real server does (it never starts a second one).
      if (msg.method === 'initialize' && !daemonAlive())
        require('node:child_process')
          .spawn(process.execPath, [require('node:path').join(__dirname, 'daemon.js'), '--project', process.cwd()], { detached: true, stdio: 'ignore' })
          .unref();
      let result = {};
      if (msg.method === 'initialize')
        result = { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'pitdeck', version: '0' } };
      else if (msg.method === 'tools/list') result = { tools: tools.map((name) => ({ name, inputSchema: { type: 'object' } })) };
      else if (msg.method === 'tools/call') {
        const { name, arguments: args } = msg.params;
        const text = name === 'db_list' ? '{"databases":[{"name":"app"}]}' : '{"rows":[[3]]}';
        result = /DELETE/.test(JSON.stringify(args)) ? { isError: true, content: [{ type: 'text', text: 'read-only' }] } : { content: [{ type: 'text', text }] };
      }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
} else process.exit(1);
`;

const DAEMON = `const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const version = require('../package.json').version;
const project = process.argv[process.argv.indexOf('--project') + 1];
const token = 'stand-in-' + process.pid;
// Never outlives a run that forgot it: a daemon with no one to stop it exits by itself.
setTimeout(() => process.exit(0), 120000);
const server = http.createServer((req, res) => {
  res.setHeader('content-type', req.url === '/' ? 'text/html' : 'application/json');
  if (req.url === '/api/health') return res.end(JSON.stringify({ ok: true, version, pid: process.pid }));
  if (req.url === '/') return res.end('<script src="/assets/app.js"></script>');
  if (req.url === '/assets/app.js') { res.setHeader('content-type', 'text/javascript'); return res.end('0'); }
  if (req.headers['x-deck-token'] !== token) { res.statusCode = 401; return res.end('{}'); }
  res.end(JSON.stringify({ attached: { id: 'fake' } }));
});
server.listen(0, '127.0.0.1', () => {
  // A test reads this list afterwards to prove that no stand-in daemon is left running. The
  // port lets it check, before it signals a pid, that the pid is still a stand-in.
  if (process.env.STAND_IN_PIDS)
    fs.appendFileSync(process.env.STAND_IN_PIDS, process.pid + ' ' + server.address().port + '\\n');
  setTimeout(() => {
  try {
    fs.writeFileSync(path.join(project, '.pitdeck', 'runtime.json'),
      JSON.stringify({ token, port: server.address().port, pid: process.pid }));
  } catch {
    process.exit(1); // its folder is gone: nobody can find or stop it
  }
  }, 1500);
});
`;

let scratch = '';
let pin = '';
let tarball = '';

function scratchEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env['NODE_PATH']; // pnpm points it at this workspace's packages
  return {
    ...env,
    TMPDIR: join(scratch, 'tmp'),
    TEMP: join(scratch, 'tmp'),
    TMP: join(scratch, 'tmp'),
    HOME: join(scratch, 'home'),
    USERPROFILE: join(scratch, 'home'),
    npm_config_cache: join(scratch, 'npm-cache'),
    npm_config_userconfig: join(scratch, 'npmrc'),
    npm_config_update_notifier: 'false',
    STAND_IN_PIDS: join(scratch, 'stand-in-pids.txt'),
  };
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'pitdeck-smoke-plugin-'));
  for (const dir of ['tmp', 'home', 'pkg/dist'])
    await mkdir(join(scratch, dir), { recursive: true });
  await writeFile(join(scratch, 'npmrc'), '');
  const mcp = JSON.parse(await readFile(join(ROOT, 'plugin', '.mcp.json'), 'utf8')) as {
    mcpServers: { pitdeck: { args: string[] } };
  };
  pin = (mcp.mcpServers.pitdeck.args.find((a) => a.startsWith('pitdeck@')) ?? '').slice(8);
  await writeFile(
    join(scratch, 'pkg', 'package.json'),
    JSON.stringify({ name: 'pitdeck', version: pin, bin: { pitdeck: 'dist/cli.js' } }),
  );
  await writeFile(join(scratch, 'pkg', 'dist', 'cli.js'), CLI, { mode: 0o755 });
  await writeFile(join(scratch, 'pkg', 'dist', 'daemon.js'), DAEMON);
  const [command, argv] =
    process.platform === 'win32'
      ? ['cmd.exe', ['/d', '/c', 'npm', 'pack', '--json', '--ignore-scripts']]
      : ['npm', ['pack', '--json', '--ignore-scripts']];
  const packed = await new Promise<string>((done, fail) => {
    execFile(
      command,
      argv,
      { cwd: join(scratch, 'pkg'), env: scratchEnv(), timeout: 60_000, encoding: 'utf8' },
      (err, stdout) => (err === null ? done(stdout) : fail(new Error(err.message))),
    );
  });
  tarball = join(scratch, 'pkg', (JSON.parse(packed) as { filename: string }[])[0]?.filename ?? '');
}, 90_000);

/** Pids the stand-in daemons wrote, still alive: each is killed so a failure leaves nothing. */
async function aliveStandIns(): Promise<number[]> {
  return killStandIns(await readFile(join(scratch, 'stand-in-pids.txt'), 'utf8').catch(() => ''));
}

/**
 * Kills the listed stand-ins ("pid port" per line) and returns their pids. A pid is only
 * signalled when the program on its port still answers health with that same pid: after
 * a stand-in exits the number can belong to any other process.
 */
async function killStandIns(listed: string): Promise<number[]> {
  const killed: number[] = [];
  for (const line of listed.split('\n').filter((l) => l !== '')) {
    const [pid, port] = line.split(' ').map(Number);
    if (pid === undefined || port === undefined || !Number.isInteger(pid) || pid <= 0) continue;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1500),
      });
      const body = (await res.json()) as { pid?: unknown };
      if (body.pid !== pid) continue;
      process.kill(pid);
      killed.push(pid);
    } catch {
      // nothing answers there, or the process is gone
    }
  }
  return killed;
}

afterAll(async () => {
  await aliveStandIns();
  if (scratch !== '')
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}, 30_000);

describe('the tarball smoke script, plugin step (scripts/smoke/tarball.mjs)', () => {
  it('passes for a package at the pinned version, fetched only from the loopback registry', async () => {
    const run = await new Promise<{ code: number | null; out: string }>((done) => {
      execFile(
        process.execPath,
        [SCRIPT, tarball],
        { env: scratchEnv(), timeout: 140_000, encoding: 'utf8' },
        (err, stdout, stderr) =>
          done({
            code: err === null ? 0 : typeof err.code === 'number' ? err.code : null,
            out: `${stdout}\n${stderr}`,
          }),
      );
    });
    expect(run.out).toMatch(/plugin \.mcp\.json pins this tarball\s+PASS/);
    expect(run.out).toMatch(/plugin \.mcp\.json: npx -y pitdeck@\S+ mcp\s+PASS/);
    const fetched = /npx fetched the pin from the loopback registry\s+PASS\s+(.*)/.exec(run.out);
    expect(fetched).not.toBeNull();
    // Only the packument and the tarball were asked for: nothing else was reachable.
    const requests = (fetched?.[1] ?? '').split(/(?= GET | POST | HEAD )/).map((r) => r.trim());
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests)
      expect(request).toMatch(/^GET \/pitdeck(\/-\/pitdeck-[^/\s]+\.tgz)?$/);
    // Nothing is left behind in the scratch folder the script made.
    expect(
      (await readdir(join(scratch, 'tmp'))).filter((n) => n.startsWith('pitdeck-smoke-')),
    ).toEqual([]);
    // The daemon the MCP server started late was found and stopped, not left running.
    expect(run.out).toMatch(/plugin step: pitdeck stop\s+PASS\s+Pitdeck stopped/);
    expect(run.out).not.toMatch(/\bFAIL\b/);
    expect(run.code).toBe(0);
  }, 150_000);

  it('ignores npm settings in the parent environment, in any letter case', async () => {
    // A decoy registry on loopback records any request. A real leak would go to a public
    // host; the decoy proves the same thing without the network. Keys in three cases cover
    // pnpm (lower), a developer shell (upper) and Windows' mixed spelling.
    const hits: string[] = [];
    const decoy: Server = createServer((req, res) => {
      hits.push(`${req.method ?? ''} ${req.url ?? ''}`);
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((ok) => decoy.listen(0, '127.0.0.1', ok));
    try {
      const address = decoy.address();
      const url = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}/`;
      const decoyRc = join(scratch, 'decoy-npmrc');
      await writeFile(decoyRc, `registry=${url}\n`);
      const hostile: NodeJS.ProcessEnv = {
        NPM_CONFIG_REGISTRY: url,
        npm_config_registry: url,
        Npm_Config_Registry: url,
        NPM_CONFIG_USERCONFIG: decoyRc,
        NPM_CONFIG_GLOBALCONFIG: decoyRc,
        npm_config_globalconfig: decoyRc,
      };
      const run = await new Promise<{ code: number | null; out: string }>((done) => {
        execFile(
          process.execPath,
          [SCRIPT, tarball],
          { env: scratchEnv(hostile), timeout: 140_000, encoding: 'utf8' },
          (err, stdout, stderr) =>
            done({
              code: err === null ? 0 : typeof err.code === 'number' ? err.code : null,
              out: `${stdout}\n${stderr}`,
            }),
        );
      });
      expect(hits).toEqual([]);
      expect(run.out).toMatch(/npx fetched the pin from the loopback registry\s+PASS/);
      expect(run.out).not.toMatch(/\bFAIL\b/);
      expect(run.code).toBe(0);
    } finally {
      decoy.close();
    }
  }, 150_000);
});

describe('cleaning up stand-in daemons', () => {
  it('leaves alone a pid that no stand-in answers for (a reused pid)', async () => {
    // A process that is not a stand-in, listed as if it were one.
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {
      stdio: 'ignore',
    });
    // A server on the listed port that answers health with a different pid.
    const impostor = createServer((_req, res) => res.end(JSON.stringify({ ok: true, pid: 1 })));
    await new Promise<void>((done) => impostor.listen(0, '127.0.0.1', done));
    const { port } = impostor.address() as { port: number };
    try {
      await killStandIns(`${other.pid} ${port}\n`);
      await sleep(200);
      expect(other.exitCode).toBeNull();
      expect(other.signalCode).toBeNull();
    } finally {
      other.kill();
      impostor.close();
    }
  });
});

describe('the stand-in package', () => {
  it('leaves no daemon running after the smoke runs', async () => {
    await sleep(500); // a stopped daemon needs a moment to exit
    expect(await aliveStandIns()).toEqual([]);
    // Without this the test would pass when no run happened (for example a skipped step).
    const listed = await readFile(join(scratch, 'stand-in-pids.txt'), 'utf8');
    expect(listed.split('\n').filter((l) => l !== '').length).toBeGreaterThan(0);
  });
});
