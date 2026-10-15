import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '@project-deck/core';
import { FakeAppConnector, fakeApp } from '@project-deck/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Daemon } from './daemon.js';
import { startDaemon } from './daemon.js';
import { REGEX_TOO_SLOW } from './regex-filter.js';

let projectDir: string;
let daemon: Daemon | undefined;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'deck-regex-'));
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await rm(projectDir, { recursive: true, force: true });
});

async function start(messages: (string | { message: string; stack: string })[]): Promise<Daemon> {
  const connector = new FakeAppConnector('fake', [fakeApp()]);
  const registry = new Registry();
  registry.connectors.register(connector);
  daemon = await startDaemon({ projectDir, registry, port: 0, log: () => undefined });
  const d = daemon;
  await vi.waitFor(() => expect(d.manager.attachedApp()).toBeDefined());
  const logs = connector.sessions.get('app-1')?.logs();
  messages.forEach((m, i) =>
    logs?.push({
      ts: i,
      level: 'info',
      source: 'app',
      ...(typeof m === 'string' ? { message: m } : m),
    }),
  );
  return d;
}

function logs(d: Daemon, query: string): Promise<Response> {
  return fetch(`${d.url}/api/logs?${query}`, { headers: { 'x-deck-token': d.token } });
}

describe('GET /api/logs with a regex', () => {
  it('filters with the regex and keeps the newest matches up to the limit', async () => {
    const d = await start(['boom 1', 'fine', 'boom 2', 'boom 3']);
    const res = await logs(d, `regex=${encodeURIComponent('boom \\d')}&limit=2`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: { message: string }[]; truncated: boolean };
    expect(body.entries.map((e) => e.message)).toEqual(['boom 2', 'boom 3']);
    expect(body.truncated).toBe(true);
  });

  it('tests the message and the stack separately', async () => {
    const d = await start([{ message: 'Bad state', stack: '#0 main' }, 'other']);
    for (const regex of ['^Bad state$', '^#0 main$']) {
      const res = await logs(d, `regex=${encodeURIComponent(regex)}`);
      const body = (await res.json()) as { entries: { message: string }[] };
      expect(body.entries.map((e) => e.message)).toEqual(['Bad state']);
    }
  });

  it('applies the other filters too', async () => {
    const d = await start(['boom x', 'boom y']);
    const res = await logs(d, 'regex=boom&text=y');
    const body = (await res.json()) as { entries: { message: string }[] };
    expect(body.entries.map((e) => e.message)).toEqual(['boom y']);
  });

  it('stops a catastrophic regex within its budget and stays responsive', async () => {
    const d = await start(Array.from({ length: 20 }, () => 'a'.repeat(4000)));
    const t0 = performance.now();
    const query = logs(d, `regex=${encodeURIComponent('(a|a)*b')}`);
    // The event loop isn't blocked while the regex runs.
    const health = await fetch(`${d.url}/api/health`);
    expect(health.status).toBe(200);
    expect(performance.now() - t0).toBeLessThan(150);
    const res = await query;
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: REGEX_TOO_SLOW });
    expect(REGEX_TOO_SLOW).toBe('That regex took too long; use a simpler pattern or `text`');

    // A fresh worker answers the next query.
    const next = await logs(d, 'regex=aaa&limit=1');
    expect(next.status).toBe(200);
  });
});
