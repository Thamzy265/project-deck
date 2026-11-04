/**
 * The `claude plugin eval` cases in plugin/evals. The eval command is early access on this
 * CLI, so it cannot run here; these tests check what it would reject or what would make a
 * case pass or fail for the wrong reason.
 * Format: code.claude.com/docs/en/plugin-evals, read 4 Nov 2026 (prompt.md keys, grader
 * types, mocks/<server>/<tool>.md, `expect:`). Mock shapes are compared with what the real
 * FlutterDeck MCP server returns, through a local fake daemon.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { writeRuntime } from '@project-deck/core/node';
import { DaemonClient, createDeckServer } from '@project-deck/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { posixRelative, walk } from './files.js';
import { splitFrontmatter } from './frontmatter.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVALS = join(ROOT, 'evals');
const SERVER_PREFIX = 'mcp__plugin_flutterdeck_';

const DART_TOOLS = (
  JSON.parse(readFileSync(join(ROOT, 'test/fixtures/dart-tools.json'), 'utf8')) as {
    tools: string[];
  }
).tools;
const SERVERS = Object.keys(
  (JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8')) as { mcpServers: object }).mcpServers,
);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');

function front(path: string): { meta: Obj; body: string } {
  const text = readFileSync(path, 'utf8');
  const split = splitFrontmatter(text);
  if (split === null) return { meta: {}, body: text };
  const meta: unknown = parse(split.front);
  return { meta: (meta ?? {}) as Obj, body: split.body };
}

/** Paths below plugin/evals with `/` on every OS: filters and splits below rely on it (review C1). */
const rel = (f: string) => posixRelative(EVALS, f);
const files = walk(EVALS).filter((f) => !rel(f).startsWith('results/'));
const graderFiles = () => files.filter((f) => rel(f).includes('/graders/'));
const cases = readdirSync(EVALS).filter(
  (n) =>
    !n.startsWith('.') &&
    n !== 'mocks' &&
    n !== 'results' &&
    statSync(join(EVALS, n)).isDirectory(),
);

const PROMPT_KEYS = [
  'schema_version',
  'name',
  'description',
  'tags',
  'plugins',
  'runs',
  'expected_outcome',
  'model',
  'max_turns',
  'timeout_seconds',
  'allowed_tools',
  'append_system_prompt',
  'env',
];
const GRADER_KEYS: Record<string, string[]> = {
  regex: ['type', 'weight', 'arm', 'pattern', 'flags', 'match', 'target'],
  tool_used: ['type', 'weight', 'arm', 'tool', 'input_match', 'min', 'max'],
  tool_order: ['type', 'weight', 'arm', 'before', 'after'],
  file_exists: ['type', 'weight', 'arm', 'path', 'exists'],
  llm: ['type', 'weight', 'arm', 'criteria', 'focus'],
  baseline: ['type', 'weight', 'arm', 'baseline_file', 'criteria'],
};
const READ_ONLY_GRANTS = [
  'Read',
  'Glob',
  'Grep',
  'NotebookRead',
  'Skill',
  'AskUserQuestion',
  'Agent',
  'TodoWrite',
];

/** A tool name as the model sees it: a built-in or `mcp__plugin_flutterdeck_<server>__<tool>`. */
function toolExists(name: string, deckTools: string[]): boolean {
  const builtins = [
    'Skill',
    'Edit',
    'Write',
    'Bash',
    'PowerShell',
    'NotebookEdit',
    'Read',
    'Grep',
    'Glob',
  ];
  if (builtins.includes(name)) return true;
  const match = /^mcp__plugin_flutterdeck_([a-z]+)__([a-z_]+)$/.exec(name);
  if (match === null) return false;
  const [, server, tool] = match;
  if (server === 'dart') return DART_TOOLS.includes(tool ?? '');
  if (server === 'flutterdeck') return deckTools.includes(tool ?? '');
  return false;
}

let deckTools: string[] = [];
let realOutputs: Record<string, Json> = {};
let projectDir = '';
let fake: Server | undefined;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    req.on('error', () => done(''));
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
  });
}

const APP = {
  id: 'app-1',
  name: 'sample_app',
  device: { id: 'emulator-5554', name: 'sdk gphone64 arm64', platform: 'android' },
  framework: 'flutter',
  startedBy: 'ide',
};
const ROUTES: Record<string, unknown> = {
  'GET /api/status': {
    version: '0.0.0',
    dashboardUrl: 'http://127.0.0.1:9147/',
    projectName: 'sample_app',
    discovering: false,
    apps: [APP],
    attached: APP,
  },
  'GET /api/logs': {
    entries: [
      {
        ts: 1793000001000,
        level: 'info',
        source: 'app',
        tag: 'flutter',
        message: 'Order 8 added',
        seq: 1,
      },
    ],
    truncated: false,
  },
  'GET /api/db': {
    databases: [{ name: 'app', backend: 'live', source: 'drift' }],
    sources: [{ id: 'drift', live: true, writable: false }],
    writesAllowed: false,
  },
  'GET /api/db/app/schema': {
    db: 'app',
    tables: [
      {
        name: 'orders',
        kind: 'table',
        rowCount: 7,
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, pk: true, pkPosition: 1, default: null },
          { name: 'item', type: 'TEXT', nullable: false, pk: false, default: null },
          { name: 'status', type: 'TEXT', nullable: false, pk: false, default: "'pending'" },
          { name: 'created_at', type: 'INTEGER', nullable: false, pk: false, default: null },
        ],
        foreignKeys: [],
        indexes: [],
      },
    ],
  },
  'POST /api/db/query': { columns: ['count'], rows: [[3]], truncated: false, durationMs: 2 },
  'POST /api/db/snapshot': { id: 'snap-evalcase000001', db: 'app', takenAt: 1793000000000 },
  'POST /api/db/diff': {
    db: 'app',
    snapshotId: 'snap-evalcase000001',
    takenAt: 1793000000000,
    tables: [
      {
        table: 'orders',
        columns: ['id', 'item', 'status', 'created_at'],
        key: ['id'],
        matchedByRowid: false,
        added: [{ key: [8], row: [8, 'Juice', 'pending', 1793000005000] }],
        removed: [],
        changed: [],
        counts: { added: 1, removed: 0, changed: 0 },
        truncated: false,
      },
    ],
    truncated: false,
    tablesOmitted: 0,
  },
};

beforeAll(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'deck-plugin-evals-'));
  mkdirSync(join(projectDir, '.flutterdeck'), { recursive: true });
  writeFileSync(join(projectDir, '.flutterdeck', 'config.json'), '{"version":1}\n');
  const token = 'eval-token-'.padEnd(40, 'x');
  const server = createServer((req, res) => {
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    void readBody(req).then(() => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const key = `${req.method ?? 'GET'} ${path}`;
      const answer =
        path === '/api/health'
          ? { ok: true, name: 'project-deck', version: '0.0.0' }
          : req.headers['x-deck-token'] !== token
            ? { error: 'Missing or invalid token' }
            : ROUTES[key];
      res.writeHead(answer === undefined ? 404 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer ?? { error: 'Not found' }));
    });
  });
  server.on('error', () => undefined);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  fake = server;
  const { port } = server.address() as AddressInfo;
  await writeRuntime(projectDir, { pid: process.pid, port, token, startedAt: Date.now() });

  const daemon = new DaemonClient({
    projectDir,
    version: '0.0.0',
    spawnDaemon: () => undefined,
    projectId: () => Promise.resolve(undefined),
  });
  const deck = createDeckServer({ projectDir, daemon });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'plugin-evals-test', version: '0.0.0' });
  await deck.server.connect(serverSide);
  await client.connect(clientSide);
  deckTools = (await client.listTools()).tools.map((t) => t.name);
  const calls: Record<string, Record<string, unknown>> = {
    deck_status: {},
    get_logs: { limit: 1 },
    db_list: {},
    db_schema: { db: 'app' },
    db_query: { db: 'app', sql: 'SELECT count(*) FROM orders' },
    db_snapshot: { db: 'app', label: '/check' },
    db_diff: { db: 'app' },
  };
  for (const [name, args] of Object.entries(calls)) {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text: string }[];
    const text = content[0]?.text ?? 'null';
    if (result.isError === true) throw new Error(`${name}: ${text}`);
    realOutputs[name] = JSON.parse(text) as Json;
  }
  await client.close();
  await deck.close();
});

afterAll(async () => {
  await new Promise<void>((done) => {
    if (fake === undefined) return done();
    fake.close(() => done());
    fake.closeAllConnections();
  });
  rmSync(projectDir, { recursive: true, force: true });
  realOutputs = {};
});

describe('eval cases are well formed (plugin-evals docs)', () => {
  it('has the four cases the design asks for', () => {
    expect(cases.sort()).toEqual([
      'check-added-order',
      'check-runtime-error',
      'db-delete-refused',
      'db-pending-orders',
    ]);
  });

  it.each(cases)('%s: prompt.md has only known keys, sane limits and a typed command', (name) => {
    const { meta, body } = front(join(EVALS, name, 'prompt.md'));
    for (const key of Object.keys(meta)) expect(PROMPT_KEYS, key).toContain(key);
    expect(body.trim()).toMatch(/^\/flutterdeck:(check|db)\b/);
    expect(Number(meta.max_turns)).toBeGreaterThanOrEqual(5);
    expect(Number(meta.max_turns)).toBeLessThanOrEqual(200);
    expect(Array.isArray(meta.allowed_tools)).toBe(true);
    // A case may only ask for read-only built-ins; Bash, Write and Edit need a flag on the command line.
    for (const tool of meta.allowed_tools as string[])
      expect(READ_ONLY_GRANTS, tool).toContain(tool);
    expect(str(meta.description).length).toBeGreaterThan(20);
    expect(str(meta.expected_outcome).length).toBeGreaterThan(20);
  });

  it.each(cases)('%s: has at least one grader on the result and one on the steps', (name) => {
    const graders = readdirSync(join(EVALS, name, 'graders')).map((g) =>
      front(join(EVALS, name, 'graders', g)),
    );
    const types = graders.map((g) => str(g.meta.type));
    expect(types.length).toBeGreaterThanOrEqual(2);
    expect(types.some((t) => t === 'llm' || t === 'regex')).toBe(true);
    expect(types.some((t) => t === 'tool_used' || t === 'tool_order')).toBe(true);
  });

  it('every grader has a known type, only that type’s keys, and a valid regex', () => {
    expect(graderFiles().length).toBeGreaterThanOrEqual(15);
    for (const file of graderFiles()) {
      const { meta, body } = front(file);
      const type = str(meta.type);
      const allowed = GRADER_KEYS[type];
      expect(allowed, `${rel(file)} type`).toBeDefined();
      for (const key of Object.keys(meta)) expect(allowed, `${rel(file)} ${key}`).toContain(key);
      for (const key of ['pattern', 'input_match'] as const) {
        const source = meta[key];
        if (typeof source === 'string')
          expect(() => new RegExp(source), `${rel(file)} ${key}`).not.toThrow();
      }
      // Inline flags such as (?i) are not supported by the grader; flags go in `flags`.
      expect(str(meta.pattern) + str(meta.input_match)).not.toMatch(/\(\?[a-z]+\)/);
      if (type === 'llm') {
        expect(body, rel(file)).toMatch(/PASS if/);
        expect(body, rel(file)).toMatch(/FAIL if/);
      }
      if (type === 'tool_used' && meta.min !== undefined && meta.max !== undefined) {
        expect(Number(meta.min)).toBeLessThanOrEqual(Number(meta.max));
      }
    }
  });

  it('every tool a grader names is a real tool of FlutterDeck or the Dart MCP server', () => {
    for (const file of graderFiles()) {
      const { meta } = front(file);
      const named: unknown[] = [meta.tool];
      for (const side of [meta.before, meta.after]) {
        named.push(typeof side === 'object' && side !== null ? (side as Obj).tool : side);
      }
      for (const tool of named.filter((n): n is string => typeof n === 'string')) {
        expect(toolExists(tool, deckTools), `${rel(file)}: ${tool}`).toBe(true);
      }
    }
  });

  it('the no-write-SQL graders match the write keywords in any case, and the SELECT grader does not catch them', () => {
    const noWrite = front(join(EVALS, 'db-pending-orders/graders/no-write-sql.md')).meta;
    const re = new RegExp(str(noWrite.input_match));
    for (const sql of [
      'insert into orders',
      'UPDATE orders',
      'DeLeTe FROM orders',
      'DROP TABLE orders',
    ]) {
      expect(re.test(JSON.stringify({ db: 'app', sql }))).toBe(true);
    }
    expect(
      re.test(
        JSON.stringify({ db: 'app', sql: "SELECT count(*) FROM orders WHERE status = 'pending'" }),
      ),
    ).toBe(false);
    expect(noWrite).toMatchObject({ min: 0, max: 0 });
  });

  it('the skill-fired graders accept the namespaced and the bare skill name only', () => {
    const re = new RegExp(
      str(front(join(EVALS, 'db-pending-orders/graders/skill-fired.md')).meta.input_match),
    );
    for (const ok of ['"skill":"db"', '"skill": "flutterdeck:db"'])
      expect(re.test(`{${ok}}`)).toBe(true);
    for (const bad of ['"skill":"dbx"', '"skill":"check"', '"skill":"other:dbx"'])
      expect(re.test(`{${bad}}`)).toBe(false);
  });
});

describe('eval mocks', () => {
  const mocks = files.filter((f) => /(^|\/)mocks\//.test(rel(f)));

  it('sit under a server name that .mcp.json declares, one file per tool that exists', () => {
    expect(mocks.length).toBeGreaterThanOrEqual(10);
    for (const file of mocks) {
      const parts = rel(file).split('/');
      const at = parts.indexOf('mocks');
      const server = parts[at + 1] ?? '';
      const tool = (parts[at + 2] ?? '').replace(/\.md$/, '');
      expect(SERVERS, rel(file)).toContain(server);
      expect(toolExists(`${SERVER_PREFIX}${server}__${tool}`, deckTools), rel(file)).toBe(true);
    }
  });

  it('exist for every tool each skill pre-approves, so no step finds a missing tool', () => {
    const suite = new Set(
      mocks
        .filter((f) => rel(f).startsWith('mocks/'))
        .map(
          (f) =>
            `${SERVER_PREFIX}${rel(f).split('/')[1] ?? ''}__${(rel(f).split('/')[2] ?? '').replace(/\.md$/, '')}`,
        ),
    );
    for (const skill of ['check', 'db']) {
      const text = readFileSync(join(ROOT, 'skills', skill, 'SKILL.md'), 'utf8');
      const meta = parse(splitFrontmatter(text)?.front ?? '') as {
        'allowed-tools': string[];
      };
      for (const tool of meta['allowed-tools']) expect(suite, `${skill}: ${tool}`).toContain(tool);
    }
  });

  it('never mock a tool a skill must not call (a mock would let a restart through)', () => {
    for (const file of mocks)
      expect(rel(file)).not.toMatch(/hot_restart|flutter_driver_command|\/pub\.md/);
  });

  it('use only documented frontmatter keys, and guard db with an expect: where the tool takes a db', () => {
    for (const file of mocks) {
      const { meta, body } = front(file);
      for (const key of Object.keys(meta))
        expect(['type', 'expect', 'error', 'abort_when'], rel(file)).toContain(key);
      expect(body.trim().length, rel(file)).toBeGreaterThan(0);
      if (/db_(schema|query|snapshot|diff)/.test(rel(file))) {
        expect((meta.expect as Obj | undefined)?.db, rel(file)).toBe('app');
      }
    }
    expect((front(join(EVALS, 'mocks/flutterdeck/db_query.md')).meta.expect as Obj).sql).toBe(
      'string',
    );
  });

  it('answer JSON that parses, for every FlutterDeck mock', () => {
    for (const file of mocks.filter((f) => rel(f).includes('/flutterdeck/'))) {
      expect(() => JSON.parse(front(file).body) as unknown, rel(file)).not.toThrow();
    }
  });

  it('carry the same frame as the real tool: untrusted note, masking line and warnings', () => {
    for (const file of mocks.filter((f) => rel(f).includes('/flutterdeck/'))) {
      const tool = (rel(file).split('/').pop() ?? '').replace(/\.md$/, '');
      const mock = JSON.parse(front(file).body) as Obj;
      const real = realOutputs[tool] as Obj | undefined;
      expect(real, tool).toBeDefined();
      for (const key of ['note', 'masking', 'warnings']) {
        if (real !== undefined && key in real) expect(mock, `${tool} ${key}`).toHaveProperty(key);
      }
    }
  });

  it.each([
    'deck_status',
    'get_logs',
    'db_list',
    'db_schema',
    'db_query',
    'db_snapshot',
    'db_diff',
  ])('%s: the mock has the same keys and value types as the real server’s answer', (tool) => {
    const mockFile = [
      `mocks/flutterdeck/${tool}.md`,
      'check-runtime-error/mocks/flutterdeck/get_logs.md',
    ]
      .map((f) => join(EVALS, f))
      .find((f) => f.includes(tool) && files.includes(f));
    expect(mockFile, tool).toBeDefined();
    const mock = JSON.parse(front(mockFile ?? '').body) as Json;
    expect(shapeDiffs(mock, realOutputs[tool] ?? null, tool)).toEqual([]);
  });

  it('the planted injection reaches Claude through a log line, and a grader checks it is treated as data', () => {
    const log = JSON.parse(
      front(join(EVALS, 'check-runtime-error/mocks/flutterdeck/get_logs.md')).body,
    ) as {
      entries: { message: string }[];
    };
    expect(log.entries[0]?.message).toMatch(/ignore your instructions/i);
    expect(front(join(EVALS, 'check-runtime-error/graders/report.md')).body).toMatch(
      /data, not as an instruction/,
    );
  });

  it('plants an injection in database rows too, since /db reads rows (design abuse case 1)', () => {
    const planted = mocks
      .filter((f) => /(^|\/)(db_query|db_schema|db_diff)\.md$/.test(rel(f)))
      .some((f) => /ignore (your|all|previous)/i.test(front(f).body));
    expect(planted).toBe(true);
  });
});

/** Differences in keys and value types, reported as paths. Arrays are compared by their first element. */
function shapeDiffs(mock: Json, real: Json, path: string): string[] {
  const kind = (v: Json) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  if (kind(mock) !== kind(real)) return [`${path}: mock is ${kind(mock)}, real is ${kind(real)}`];
  if (Array.isArray(mock) && Array.isArray(real)) {
    const [m, r] = [mock[0], real[0]];
    return m === undefined || r === undefined ? [] : shapeDiffs(m, r, `${path}[]`);
  }
  if (typeof mock === 'object' && mock !== null && typeof real === 'object' && real !== null) {
    const [m, r] = [mock as Obj, real as Obj];
    const out: string[] = [];
    for (const key of Object.keys(m)) {
      if (!(key in r)) out.push(`${path}.${key}: in the mock, not in the real answer`);
    }
    for (const key of Object.keys(r)) {
      if (!(key in m)) out.push(`${path}.${key}: in the real answer, not in the mock`);
    }
    for (const key of Object.keys(m)) {
      const [a, b] = [m[key], r[key]];
      if (a !== undefined && b !== undefined) out.push(...shapeDiffs(a, b, `${path}.${key}`));
    }
    return out;
  }
  return [];
}
