#!/usr/bin/env node
// Starts every stdio server in an .mcp.json, runs MCP initialize + tools/list, prints the server
// name and its tools, then kills the process. Proves the config works without Claude Code.
// Runs only the command and args written in the file, without a shell.
// Usage: node scripts/check-mcp-config.mjs [path/to/.mcp.json]   (default: plugin/.mcp.json)
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

const TIMEOUT_MS = 30_000;
const PROTOCOL_VERSION = '2025-06-18';

const KILL_GRACE_MS = 2_000;
const isWindows = process.platform === 'win32';

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// Kills the server and everything it started. Wrappers such as `npx` leave a grandchild that
// keeps stdout open, and some servers ignore SIGTERM, so a plain child.kill() is not enough.
async function killTree(child) {
  const pid = child.pid;
  if (pid === undefined) return; // Never started.
  if (isWindows) {
    await new Promise((done) =>
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => done()),
    );
  } else {
    // The child leads its own process group (detached: true), so -pid reaches all of it.
    const signalGroup = (signal) => {
      try {
        process.kill(-pid, signal);
        return true;
      } catch {
        return false; // The group is gone.
      }
    };
    if (signalGroup('SIGTERM')) {
      for (let waited = 0; waited < KILL_GRACE_MS && signalGroup(0); waited += 100)
        await sleep(100);
      signalGroup('SIGKILL');
    }
  }
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
}

let running; // The child being checked, so Ctrl-C can clean it up.
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    if (running?.pid !== undefined && !isWindows) {
      try {
        process.kill(-running.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    process.exit(130);
  });

function checkServer(entry) {
  return new Promise((resolve, reject) => {
    const child = spawn(entry.command, entry.args ?? [], {
      env: { ...process.env, ...entry.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !isWindows, // Own process group on POSIX; on Windows it would open a console.
    });
    running = child;
    const pending = new Map();
    let stderr = '';
    let done = false;
    const finish = (fn) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void killTree(child).then(fn);
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`timed out after ${TIMEOUT_MS} ms`))),
      TIMEOUT_MS,
    );

    child.on('error', (err) => finish(() => reject(err)));
    child.stdin.on('error', () => {}); // An early exit is reported through 'exit' instead.
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('exit', (code) =>
      finish(() =>
        reject(new Error(`exited with code ${code}: ${stderr.trim().split('\n')[0] ?? ''}`)),
      ),
    );

    // stdio transport: one JSON-RPC message per line.
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        onLine(line);
      } catch (err) {
        // A throw here would be uncaught and leave the server running.
        finish(() => reject(err));
      }
    });
    const onLine = (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // Not a protocol message.
      }
      if (!isObject(msg)) return; // e.g. `null` or a bare number: not a JSON-RPC message.
      const waiter = pending.get(msg.id);
      if (msg.method !== undefined || !waiter) return; // Ignore server requests and notifications.
      pending.delete(msg.id);
      if (msg.error !== undefined)
        waiter.reject(new Error(String(msg.error?.message ?? msg.error)));
      else if (!isObject(msg.result)) waiter.reject(new Error('response has no result object'));
      else waiter.resolve(msg.result);
    };

    const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
    let nextId = 1;
    const request = (method, params) =>
      new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, { resolve: res, reject: rej });
        send({ id, method, params });
      });

    (async () => {
      const init = await request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'project-deck-check', version: '0.0.0' },
      });
      send({ method: 'notifications/initialized' });
      const { tools } = await request('tools/list', {});
      if (!Array.isArray(tools)) throw new Error('tools/list returned no tools array');
      return { init, tools };
    })().then(
      (result) => finish(() => resolve(result)),
      (err) => finish(() => reject(err)),
    );
  });
}

const file = process.argv[2] ?? 'plugin/.mcp.json';
const { mcpServers = {} } = JSON.parse(await readFile(file, 'utf8'));
let failed = false;

for (const [name, entry] of Object.entries(mcpServers)) {
  if ((entry.type ?? 'stdio') !== 'stdio') {
    console.log(`${name}: skipped (only stdio servers are checked)`);
    continue;
  }
  if (JSON.stringify(entry).includes('${')) {
    console.log(`${name}: skipped (uses \${...} variables that only Claude Code expands)`);
    continue;
  }
  try {
    const { init, tools } = await checkServer(entry);
    const info = init.serverInfo ?? {};
    console.log(
      `${name}: OK - server "${info.name}" ${info.version ?? ''}, protocol ${init.protocolVersion}, ${tools.length} tools`,
    );
    console.log(`  ${tools.map((t) => t.name).join(', ')}`);
  } catch (err) {
    failed = true;
    console.log(`${name}: FAILED - ${err.message}`);
    // Node refuses to run .bat/.cmd files without a shell (CVE-2024-27980), and Flutter's `dart`
    // on Windows is dart.bat. Using a shell would let the file inject commands, so explain instead.
    if (isWindows && err.code === 'EINVAL')
      console.log(
        `  Hint: "${entry.command}" is probably a .bat or .cmd file. Put the Dart SDK's dart.exe ` +
          '(<flutter>\\bin\\cache\\dart-sdk\\bin) first on PATH, or use its full path.',
      );
  }
}

// Exit explicitly: anything the kill missed must not keep this script alive.
process.exit(failed ? 1 : 0);
