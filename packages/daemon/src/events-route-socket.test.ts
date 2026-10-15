/**
 * Tester edge cases for `POST /api/events` on a real daemon socket: the 16 kB limit with
 * multi-byte text, a Content-Length that promises far more than is sent, chunked bodies,
 * the order of the token and size checks, and a hook event all the way to the notifier.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '@project-deck/core';
import { FakeAppConnector, fakeApp } from '@project-deck/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENTS_BODY_LIMIT } from './api.js';
import type { Daemon } from './daemon.js';
import { startDaemon } from './daemon.js';

let projectDir: string;
let homeDir: string;
let daemon: Daemon | undefined;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'deck-events-'));
  homeDir = await mkdtemp(join(tmpdir(), 'deck-events-home-'));
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await rm(projectDir, { recursive: true, force: true });
  await rm(homeDir, { recursive: true, force: true });
});

async function start(notifier?: (title: string, text: string) => void): Promise<Daemon> {
  const registry = new Registry();
  registry.connectors.register(new FakeAppConnector('fake', [fakeApp()]));
  daemon = await startDaemon({
    projectDir,
    homeDir,
    registry,
    port: 0,
    log: () => undefined,
    ...(notifier === undefined ? {} : { notifier }),
  });
  return daemon;
}

const portOf = (d: Daemon) => Number(new URL(d.url).port);

/**
 * Sends raw HTTP and resolves with the status line once the daemon answers, or 'timeout'.
 * `body` may be shorter than the Content-Length it claims.
 */
function raw(port: number, head: string, body: string | Buffer, waitMs = 2000): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    let got = '';
    const timer = setTimeout(() => {
      socket.destroy();
      resolve('timeout');
    }, waitMs);
    socket.on('error', () => undefined);
    socket.on('data', (d: Buffer) => {
      got += d.toString('latin1');
      const line = got.split('\r\n')[0];
      if (line !== undefined && got.includes('\r\n')) {
        clearTimeout(timer);
        socket.destroy();
        resolve(line);
      }
    });
    socket.on('connect', () => {
      socket.write(head);
      socket.write(body);
    });
  });
}

const headers = (d: Daemon, extra: string[]) =>
  [
    'POST /api/events HTTP/1.1',
    `Host: 127.0.0.1:${portOf(d)}`,
    'Content-Type: application/json',
    `x-deck-token: ${d.token}`,
    ...extra,
    '',
    '',
  ].join('\r\n');

describe('POST /api/events on a real socket', () => {
  it('measures the limit in bytes: 16 kB of two-byte text is refused', async () => {
    const d = await start();
    const post = (message: string) =>
      fetch(`${d.url}/api/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-deck-token': d.token },
        body: JSON.stringify({ type: 'claude.waiting', message }),
      });
    // 2000 characters of é: under the schema's limit and about 4 kB, accepted.
    expect((await post('é'.repeat(2000))).status).toBe(200);
    // 8200 characters of é: over 16 kB in bytes although under 16 k characters.
    const big = 'é'.repeat(8200);
    expect(JSON.stringify({ type: 'claude.waiting', message: big }).length).toBeLessThan(
      EVENTS_BODY_LIMIT,
    );
    expect((await post(big)).status).toBe(413);
  });

  it('answers 413 at once to a Content-Length far over the limit, without waiting for the body', async () => {
    const d = await start();
    const started = Date.now();
    const line = await raw(portOf(d), headers(d, ['Content-Length: 1000000000']), '{"type":');
    expect(line).toBe('HTTP/1.1 413 Payload Too Large');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('refuses a chunked body once it passes the limit', async () => {
    const d = await start();
    const chunk = 'a'.repeat(4096);
    const body = `${Array.from({ length: 5 }, () => `1000\r\n${chunk}\r\n`).join('')}0\r\n\r\n`;
    const line = await raw(portOf(d), headers(d, ['Transfer-Encoding: chunked']), body);
    expect(line).toBe('HTTP/1.1 413 Payload Too Large');
  });

  it('checks the token before the size: no token and a huge Content-Length is 401', async () => {
    const d = await start();
    const head = [
      'POST /api/events HTTP/1.1',
      `Host: 127.0.0.1:${portOf(d)}`,
      'Content-Type: application/json',
      'Content-Length: 1000000000',
      '',
      '',
    ].join('\r\n');
    expect(await raw(portOf(d), head, '')).toBe('HTTP/1.1 401 Unauthorized');
  });

  it('refuses a hook event from a web page (Origin) even with a small valid body', async () => {
    const d = await start();
    const res = await fetch(`${d.url}/api/events`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        origin: 'https://evil.example',
        'x-deck-token': d.token,
      },
      body: JSON.stringify({ type: 'claude.waiting', message: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  it('takes a hook reload failure all the way to one notification', async () => {
    const notifier = vi.fn<(title: string, text: string) => void>();
    const d = await start(notifier);
    const post = (body: unknown) =>
      fetch(`${d.url}/api/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-deck-token': d.token },
        body: JSON.stringify(body),
      });
    expect((await post({ type: 'claude.reload', ok: false, kind: 'hot-reload' })).status).toBe(200);
    expect((await post({ type: 'claude.reload', ok: false, kind: 'hot-restart' })).status).toBe(
      200,
    );
    expect((await post({ type: 'claude.reload', ok: true, kind: 'hot-reload' })).status).toBe(200);
    await vi.waitFor(() => expect(notifier).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // One per kind per 30 s: the restart failure is held for the next one.
    expect(notifier).toHaveBeenCalledTimes(1);
    expect(notifier.mock.calls[0]?.[1]).toMatch(/^Reload failed( — .+)?$/);
  });

  it.each([
    ['ok as a string', { type: 'claude.reload', ok: 'false', kind: 'hot-reload' }],
    ['kind rebuild', { type: 'claude.reload', ok: false, kind: 'rebuild' }],
    [
      'a 301-character message',
      { type: 'claude.reload', ok: false, kind: 'hot-reload', message: 'x'.repeat(301) },
    ],
    [
      'a 129-character session id',
      { type: 'claude.reload', ok: true, kind: 'hot-reload', sessionId: 's'.repeat(129) },
    ],
    ['an array body', [{ type: 'claude.done' }]],
  ])('answers 400 to %s and notifies nobody', async (_, body) => {
    const notifier = vi.fn();
    const d = await start(notifier);
    const res = await fetch(`${d.url}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-deck-token': d.token },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notifier).not.toHaveBeenCalled();
  });
});
