/**
 * Tester probes of the MCP server over the SDK's in-memory transport: bad tool calls,
 * limits, concurrent calls, config changes between calls, the 20 kB cut after masking,
 * and that no token, VM service URI or DTD URI reaches any tool output.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { LogEntry } from '@project-deck/core';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DaemonClientOptions } from './daemon-client.js';
import { DaemonClient, DaemonError } from './daemon-client.js';
import { MAX_OUTPUT_BYTES } from './output.js';
import { createDeckServer } from './server.js';
import { FAKE_STATUS, FakeDaemon } from './testing/fake-daemon.js';

let projectDir: string;
const cleanups: (() => Promise<void>)[] = [];
/** Secrets that must never be in any tool output: tokens, VM service and DTD auth codes. */
const secrets = new Set<string>();
const outputs: string[] = [];

/** The VM service and DTD auth codes these tests put in front of the server. */
const VM_AUTH = 'Vt6jT5lXFNM=';
const DTD_AUTH = 'X7mQ2pLk9aB=';
const VM_URI = `http://127.0.0.1:40229/${VM_AUTH}/`;
const DTD_URI = `ws://127.0.0.1:53211/${DTD_AUTH}`;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'deck-mcp-srv-'));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await rm(projectDir, { recursive: true, force: true });
});

afterAll(() => {
  expect(outputs.length).toBeGreaterThan(10);
  for (const secret of secrets) for (const text of outputs) expect(text).not.toContain(secret);
});

async function fake(): Promise<FakeDaemon> {
  const f = await FakeDaemon.start(projectDir);
  secrets.add(f.token);
  cleanups.push(() => f.stop());
  return f;
}

async function connect(opts: Partial<DaemonClientOptions> = {}): Promise<Client> {
  const daemon = new DaemonClient({
    projectDir,
    version: '0.0.0',
    projectId: () => Promise.resolve('aaaaaaaaaaaa'),
    spawnDaemon: () => undefined,
    readyTimeoutMs: 300,
    pollMs: 20,
    ...opts,
  });
  const deck = createDeckServer({ projectDir, daemon });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await deck.server.connect(serverSide);
  await client.connect(clientSide);
  cleanups.push(async () => {
    await client.close();
    await deck.close();
  });
  return client;
}

interface ToolOutput {
  isError: boolean;
  text: string;
  json: Record<string, unknown>;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
  /** False for the known-bug repros, so the file-wide secret check stays green until they are fixed. */
  record = true,
): Promise<ToolOutput> {
  let text: string;
  let isError: boolean;
  try {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text: string }[];
    text = content.map((c) => c.text).join('\n');
    isError = result.isError === true;
  } catch (err) {
    // A protocol error is also an answer Claude sees.
    text = err instanceof Error ? err.message : String(err);
    isError = true;
  }
  if (record) outputs.push(text);
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Errors are plain text.
  }
  return { isError, text, json };
}

async function writeConfig(config: unknown): Promise<void> {
  await mkdir(join(projectDir, '.flutterdeck'), { recursive: true });
  await writeFile(join(projectDir, '.flutterdeck', 'config.json'), JSON.stringify(config));
}

const line = (message: string, extra: Partial<LogEntry> = {}): LogEntry => ({
  ts: 1,
  level: 'info',
  source: 'app',
  message,
  ...extra,
});

function logRequests(f: FakeDaemon): string[] {
  return f.requests.filter((r) => r.path.startsWith('/api/logs')).map((r) => r.path);
}

describe('bad tool calls', () => {
  it('answers an unknown tool with an error and calls no daemon route', async () => {
    const f = await fake();
    const out = await call(await connect(), 'db_query', { sql: 'DELETE FROM users' });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/db_query/);
    expect(f.requests).toEqual([]);
  });

  it.each([
    ['limit 0', { limit: 0 }],
    ['negative limit', { limit: -1 }],
    ['fractional limit', { limit: 1.5 }],
    ['limit over the maximum', { limit: 5001 }],
    ['string limit', { limit: '10' }],
    ['null limit', { limit: null }],
    ['NaN-like since', { since: 'yesterday' }],
    ['unknown level', { minLevel: 'loud' }],
    ['regex of the wrong type', { regex: ['a'] }],
    ['invalid regex', { regex: '(' }],
    ['regex over 200 characters', { regex: 'a'.repeat(201) }],
    ['tag of the wrong type', { tag: 7 }],
  ])('refuses a %s before calling the daemon', async (_name, args) => {
    const f = await fake();
    const out = await call(await connect(), 'get_logs', args);
    expect(out.isError).toBe(true);
    expect(logRequests(f)).toEqual([]);
  });

  it('ignores extra arguments it does not know', async () => {
    const f = await fake();
    const out = await call(await connect(), 'get_logs', {
      limit: 5,
      sql: 'DROP TABLE x',
      url: 'http://x',
    });
    expect(out.isError).toBe(false);
    expect(logRequests(f)).toEqual(['/api/logs?limit=5']);
  });

  it('caps the largest allowed limit at 200 and says so', async () => {
    const f = await fake();
    const out = await call(await connect(), 'get_logs', { limit: 5000 });
    expect(logRequests(f)).toEqual(['/api/logs?limit=200']);
    expect(out.json.warnings).toEqual([
      'limit is at most 200 here; showing the newest 200 matches at most.',
    ]);
  });

  it('accepts limit 1 and no arguments at all', async () => {
    const f = await fake();
    const client = await connect();
    expect((await call(client, 'get_logs', { limit: 1 })).isError).toBe(false);
    expect((await call(client, 'get_logs')).isError).toBe(false);
    expect(logRequests(f)).toEqual(['/api/logs?limit=1', '/api/logs?limit=200']);
  });

  it('ignores arguments given to deck_status', async () => {
    await fake();
    const out = await call(await connect(), 'deck_status', { verbose: true });
    expect(out.isError).toBe(false);
    expect(out.json.project).toBe('shop_app');
  });
});

describe('concurrent calls', () => {
  it('answers 20 overlapping calls, each masked', async () => {
    const f = await fake();
    f.logs = { entries: [line('jane@example.com paid')], truncated: false };
    await writeConfig({ version: 1, logs: { rules: ['paid'] } });
    const client = await connect();
    const outs = await Promise.all(
      Array.from({ length: 20 }, (_, i) => call(client, i % 4 === 0 ? 'deck_status' : 'get_logs')),
    );
    for (const out of outs) {
      expect(out.isError).toBe(false);
      expect(out.text).not.toContain('jane');
    }
    const logs = outs.filter((o) => 'entries' in o.json);
    expect(logs.length).toBe(15);
    for (const out of logs) expect(out.json.entries).toEqual([line('[email masked] [masked]')]);
  });

  it('applies a config change at the next call, and built-ins stay on while it changes', async () => {
    const f = await fake();
    f.logs = { entries: [line('order-77 for jane@example.com by Bob')], truncated: false };
    const client = await connect();
    await writeConfig({ version: 1, logs: { rules: ['order-\\d+'] } });
    const first = await call(client, 'get_logs');
    await writeConfig({ version: 1, logs: { rules: ['Bob'] } });
    const [second, third] = await Promise.all([call(client, 'get_logs'), call(client, 'get_logs')]);
    expect(first.json.entries).toEqual([line('[masked] for [email masked] by Bob')]);
    for (const out of [second, third]) {
      expect(out.json.entries).toEqual([line('order-77 for [email masked] by [masked]')]);
    }
    await writeConfig({ version: 1, logs: { rules: ['(unclosed'] } });
    const broken = await call(client, 'get_logs');
    expect(broken.json.entries).toEqual([line('order-77 for [email masked] by Bob')]);
    expect(JSON.stringify(broken.json.warnings)).toMatch(/built-in patterns only/);
  });
});

describe('output size after masking', () => {
  it('counts the 20 kB on masked text, and never cuts a marker', async () => {
    const f = await fake();
    // Each line is 4 kB of emails before masking, much less after.
    const emails = Array.from({ length: 200 }, (_, i) => `u${i}@example.com`).join(' ');
    f.logs = {
      entries: Array.from({ length: 200 }, (_, i) => line(`${i} ${emails}`, { seq: i })),
      truncated: false,
    };
    const out = await call(await connect(), 'get_logs');
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(out.json.truncated).toBe(true);
    const entries = out.json.entries as LogEntry[];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.message).not.toMatch(/@example/);
      // Every marker whole: no "[email mas" left at an end.
      expect(entry.message.replace(/\[email masked\]/g, '')).not.toMatch(/\[|\]/);
    }
  });

  it('stays under 20 kB with multi-byte text', async () => {
    const f = await fake();
    f.logs = {
      entries: Array.from({ length: 200 }, () => line('日本語のログ😀'.repeat(400))),
      truncated: false,
    };
    const out = await call(await connect(), 'get_logs');
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(out.json.truncated).toBe(true);
  });
});

describe('secrets never reach Claude', () => {
  it('leaves VM service and DTD URIs out of deck_status, even when the daemon sends them', async () => {
    const f = await fake();
    secrets.add(VM_AUTH);
    secrets.add(DTD_AUTH);
    const attached = {
      id: 'app-1',
      name: 'com.example.shop',
      device: { id: 'emulator-5554', name: 'Pixel 8', platform: 'android' },
      framework: 'flutter',
      startedBy: 'ide',
      vmServiceUri: VM_URI,
      dtdUri: DTD_URI,
    };
    f.route('GET', '/api/status', () => ({
      status: 200,
      body: { ...FAKE_STATUS, apps: [attached], attached, sessionSecret: 'S'.repeat(43) },
    }));
    secrets.add('S'.repeat(43));
    const out = await call(await connect(), 'deck_status');
    expect(out.isError).toBe(false);
    expect(out.json.attached).toEqual({
      name: 'com.example.shop',
      device: 'Pixel 8',
      platform: 'android',
      framework: 'flutter',
      startedBy: 'ide',
    });
  });

  it.fails('BUG-MCP-T1: masks the VM service URI that Flutter prints to logcat', async () => {
    // The engine prints this line to logcat on every Android start (logs-android fixture).
    const f = await fake();
    f.logs = {
      entries: [
        line(`The Dart VM service is listening on ${VM_URI}`, { source: 'native', tag: 'flutter' }),
      ],
      truncated: false,
    };
    const out = await call(await connect(), 'get_logs', {}, false);
    expect(out.text).not.toContain(VM_AUTH);
  });

  it.fails('BUG-MCP-T1: masks a DTD URI printed by the app or tool', async () => {
    const f = await fake();
    f.logs = {
      entries: [line(`Connected to the Dart Tooling Daemon at ${DTD_URI}`)],
      truncated: false,
    };
    const out = await call(await connect(), 'get_logs', {}, false);
    expect(out.text).not.toContain(DTD_AUTH);
  });

  it('keeps the token out of every error, for every failure kind', async () => {
    const f = await fake();
    const client = await connect();
    const answers = [
      { status: 401, body: { error: 'Missing or invalid token' } },
      { status: 500, body: '<html>oops</html>' },
      { status: 200, body: { nope: true } },
      { status: 302, body: null },
    ];
    for (const answer of answers) {
      f.route('GET', '/api/logs', () => answer);
      f.route('GET', '/api/status', () => answer);
      const logs = await call(client, 'get_logs');
      const status = await call(client, 'deck_status');
      expect(logs.isError).toBe(true);
      expect(status.json.daemon).toBe('unavailable');
      for (const text of [logs.text, status.text]) expect(text).not.toContain(f.token);
    }
  });
});

describe('the login window at start', () => {
  it('failing does not break the tools afterwards', async () => {
    const f = await fake();
    f.route('POST', '/api/login-window', () => ({ status: 500, body: { error: 'boom' } }));
    const daemon = new DaemonClient({
      projectDir,
      version: '0.0.0',
      projectId: () => Promise.resolve('aaaaaaaaaaaa'),
      spawnDaemon: () => undefined,
    });
    const err = await daemon.openLoginWindow().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DaemonError);
    expect(String(err)).not.toContain(f.token);
    const client = await connect();
    expect((await call(client, 'deck_status')).json.project).toBe('shop_app');
    expect((await call(client, 'get_logs')).isError).toBe(false);
  });
});
