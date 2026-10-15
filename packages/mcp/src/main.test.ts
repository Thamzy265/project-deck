import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeDaemon, initProject } from './testing/fake-daemon.js';

// The entrypoint runs top-level code, so it is exercised as a process. CI builds first.
const MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));

let projectDir: string;
/**
 * Its own empty home: the other test files share the scratch HOME and may create a port
 * registry there, which would give main.js a project id the fake daemon doesn't know.
 */
let home: string;
let daemon: FakeDaemon;
let client: Client | undefined;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'deck-mcp-main-'));
  home = await mkdtemp(join(tmpdir(), 'deck-mcp-main-home-'));
  await initProject(projectDir);
  daemon = await FakeDaemon.start(projectDir);
});

afterEach(async () => {
  await client?.close();
  client = undefined;
  await daemon.stop();
  await rm(projectDir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('main.js over stdio', () => {
  it('serves both tools for --project and opens the login window at start', async () => {
    daemon.logs = {
      entries: [{ ts: 5, level: 'error', source: 'native', message: 'call +44 7700 900123' }],
      truncated: false,
    };
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MAIN, '--project', projectDir],
      stderr: 'pipe',
      env: { ...getDefaultEnvironment(), HOME: home, USERPROFILE: home },
    });
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(transport);

    await waitFor(() => daemon.requests.some((r) => r.path === '/api/login-window'));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['deck_status', 'get_logs']);

    const logs = await client.callTool({ name: 'get_logs', arguments: { minLevel: 'error' } });
    const text = (logs.content as { text: string }[])[0]?.text ?? '';
    expect(JSON.parse(text)).toMatchObject({
      entries: [{ ts: 5, level: 'error', source: 'native', message: 'call [phone masked]' }],
    });
    const status = await client.callTool({ name: 'deck_status', arguments: {} });
    const statusText = (status.content as { text: string }[])[0]?.text ?? '';
    expect(JSON.parse(statusText)).toMatchObject({ project: 'shop_app' });
    for (const out of [text, statusText]) expect(out).not.toContain(daemon.token);
  });

  it('exits cleanly when Claude closes stdin', async () => {
    const child = spawn(process.execPath, [MAIN, '--project', projectDir], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('main.js did not exit'));
      }, 5000);
      child.once('error', reject);
      child.once('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
      setTimeout(() => child.stdin.end(), 300);
    });
    expect(code).toBe(0);
    expect(stderr).not.toContain('Unexpected error');
  });
});
