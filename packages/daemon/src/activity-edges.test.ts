import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActivityEntry, DeckEvents } from '@project-deck/core';
import { ACTIVITY_CAPACITY, ActivityEntrySchema, EventBus, Registry } from '@project-deck/core';
import { fakeApp } from '@project-deck/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { ActivityFeed } from './activity.js';
import type { Daemon } from './daemon.js';
import { startDaemon } from './daemon.js';

function feed(capacity?: number) {
  const bus = new EventBus<DeckEvents>();
  let clock = 0;
  const activity = new ActivityFeed(bus, {
    now: () => ++clock,
    ...(capacity === undefined ? {} : { capacity }),
  });
  const pushed: ActivityEntry[] = [];
  bus.on('activity', (entry) => pushed.push(entry));
  const stop = activity.start();
  return { bus, activity, pushed, stop };
}

describe('ActivityFeed ring buffer', () => {
  it('keeps exactly 500 entries at 500, and drops only the oldest at 501', () => {
    const { bus, activity } = feed();
    for (let i = 0; i < ACTIVITY_CAPACITY; i++) bus.emit('claude.done', { sessionId: `s${i}` });
    const full = activity.list();
    expect(full).toHaveLength(500);
    expect(full[0]?.id).toBe(0);
    expect(full.at(-1)?.id).toBe(499);
    bus.emit('claude.done', { sessionId: 's500' });
    const after = activity.list();
    expect(after).toHaveLength(500);
    expect(after[0]?.id).toBe(1);
    expect(after.at(-1)?.id).toBe(500);
  });

  it('stays oldest first with contiguous, increasing ids and times after many overflows', () => {
    const { bus, activity } = feed();
    for (let i = 0; i < ACTIVITY_CAPACITY * 3 + 7; i++) bus.emit('claude.done', {});
    const entries = activity.list();
    expect(entries).toHaveLength(ACTIVITY_CAPACITY);
    entries.forEach((entry, i) => {
      expect(entry.id).toBe(ACTIVITY_CAPACITY * 2 + 7 + i);
      if (i > 0) expect(entry.ts).toBeGreaterThan(entries[i - 1]?.ts ?? Infinity);
    });
  });

  it('never reuses an id after entries fall out', () => {
    const { bus, activity } = feed(3);
    for (let i = 0; i < 10; i++) bus.emit('claude.done', {});
    expect(activity.list().map((e) => e.id)).toEqual([7, 8, 9]);
  });

  it('keeps a capacity of 1 working', () => {
    const { bus, activity } = feed(1);
    bus.emit('claude.done', { sessionId: 'a' });
    bus.emit('claude.done', { sessionId: 'b' });
    expect(activity.list()).toEqual([expect.objectContaining({ id: 1, sessionId: 'b' })]);
  });

  it('hands out a copy: changing the returned list changes nothing inside', () => {
    const { bus, activity } = feed();
    bus.emit('claude.done', {});
    const list = activity.list();
    list.pop();
    list.push({ id: 99, ts: 0, kind: 'claude.done' });
    expect(activity.list()).toEqual([expect.objectContaining({ id: 0, kind: 'claude.done' })]);
  });

  it('pushes every entry once, in order, even the ones already dropped from the list', async () => {
    const { bus, pushed } = feed(2);
    for (let i = 0; i < 5; i++) bus.emit('claude.done', {});
    await Promise.resolve();
    expect(pushed.map((e) => e.id)).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps order across event kinds fired in one burst', async () => {
    const { bus, activity, pushed } = feed();
    const app = fakeApp();
    bus.emit('app.attached', { app });
    bus.emit('app.reloaded', { appId: app.id, result: { ok: true, kind: 'hot-reload' } });
    bus.emit('app.exit', { appId: app.id, crashed: true, code: 139 });
    bus.emit('claude.waiting', { message: 'Allow edit?' });
    await Promise.resolve();
    const kinds = ['app.attached', 'app.reloaded', 'app.crashed', 'claude.waiting'];
    expect(activity.list().map((e) => e.kind)).toEqual(kinds);
    expect(pushed.map((e) => e.kind)).toEqual(kinds);
    for (const entry of activity.list()) expect(ActivityEntrySchema.parse(entry)).toEqual(entry);
  });

  it('records an exit without a crash flag as a stop, and keeps a code of 0', () => {
    const { bus, activity } = feed();
    bus.emit('app.exit', { appId: 'a', code: 0, crashed: false });
    expect(activity.list()[0]).toMatchObject({ kind: 'app.stopped', code: 0 });
  });

  it('does not add an entry for its own activity events or log lines', async () => {
    const { bus, activity } = feed();
    bus.emit('app.log', {
      appId: 'a',
      entry: { ts: 1, level: 'error', source: 'app', message: 'x' },
    });
    bus.emit('claude.done', {});
    await Promise.resolve();
    await Promise.resolve();
    expect(activity.list()).toHaveLength(1);
  });
});

describe('GET /api/activity', () => {
  const dirs: string[] = [];
  const daemons: Daemon[] = [];
  afterEach(async () => {
    for (const d of daemons.splice(0)) await d.stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function start(): Promise<Daemon> {
    const dir = await mkdtemp(join(tmpdir(), 'deck-activity-'));
    dirs.push(dir);
    const d = await startDaemon({
      projectDir: dir,
      registry: new Registry(),
      port: 0,
      log: () => undefined,
    });
    daemons.push(d);
    return d;
  }

  function post(d: Daemon, path: string, body: string, method = 'POST'): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: d.port,
          path,
          method,
          headers: {
            host: `127.0.0.1:${d.port}`,
            'x-deck-token': d.token,
            'content-type': 'application/json',
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  async function activity(d: Daemon): Promise<ActivityEntry[]> {
    const res = await fetch(`${d.url}/api/activity`, { headers: { 'x-deck-token': d.token } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { entries: ActivityEntry[] }).entries;
  }

  it('returns hook events in the order they arrived, capped at 500', async () => {
    const d = await start();
    for (let i = 0; i < ACTIVITY_CAPACITY + 5; i++)
      d.bus.emit('claude.done', { sessionId: `s${i}` });
    const entries = await activity(d);
    expect(entries).toHaveLength(ACTIVITY_CAPACITY);
    expect(entries[0]).toMatchObject({ kind: 'claude.done', sessionId: 's5' });
    expect(entries.at(-1)).toMatchObject({ sessionId: `s${ACTIVITY_CAPACITY + 4}` });
  });

  it('keeps only schema fields from a hook body, and refuses a too-long message', async () => {
    const d = await start();
    const extra = JSON.stringify({
      type: 'claude.waiting',
      sessionId: 's1',
      message: 'Allow edit?',
      last_assistant_message: 'secret plan',
      transcript_path: '/home/u/.claude/x.jsonl',
    });
    expect(await post(d, '/api/events', extra)).toBe(200);
    const long = JSON.stringify({ type: 'claude.waiting', message: 'x'.repeat(2001) });
    expect(await post(d, '/api/events', long)).toBe(400);
    const entries = await activity(d);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      id: 0,
      ts: expect.any(Number) as number,
      kind: 'claude.waiting',
      sessionId: 's1',
      message: 'Allow edit?',
    });
  });

  it('is not changed by DELETE /api/logs', async () => {
    const d = await start();
    d.bus.emit('claude.done', {});
    expect(await post(d, '/api/logs', '', 'DELETE')).toBe(200);
    expect(await activity(d)).toHaveLength(1);
  });
});
