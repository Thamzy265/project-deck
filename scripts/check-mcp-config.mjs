#!/usr/bin/env node
// Starts every stdio server in an .mcp.json, runs MCP initialize + tools/list, prints the server
// name and its tools, then kills the process. Proves the config works without Claude Code.
// Runs only the command and args written in the file, without a shell.
// Usage: node scripts/check-mcp-config.mjs [path/to/.mcp.json]   (default: plugin/.mcp.json)
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const TIMEOUT_MS = 30_000;
const PROTOCOL_VERSION = '2025-06-18';

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function checkServer(entry) {
  return new Promise((resolve, reject) => {
    const child = spawn(entry.command, entry.args ?? [], {
      env: { ...process.env, ...entry.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const pending = new Map();
    let stderr = '';
    let done = false;
    const finish = (fn) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      fn();
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
  }
}

process.exitCode = failed ? 1 : 0;
