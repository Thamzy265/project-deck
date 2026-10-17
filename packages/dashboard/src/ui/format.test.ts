import type { ActivityEntry } from '@project-deck/core';
import { fakeApp } from '@project-deck/core/testing';
import { describe, expect, it } from 'vitest';
import type { LastResult } from '../state/deck.js';
import { activityText, appLabel, clock, resultText } from './format.js';

const at = (h: number, m: number, s: number, ms = 0) =>
  new Date(2026, 9, 14, h, m, s, ms).getTime();

describe('clock', () => {
  it('formats short, medium and full times', () => {
    const ts = at(9, 5, 7, 42);
    expect(clock(ts, 'short')).toBe('05:07');
    expect(clock(ts, 'medium')).toBe('09:05:07');
    expect(clock(ts, 'full')).toBe('09:05:07.042');
    expect(clock(ts, 'minutes')).toBe('09:05');
  });
});

describe('appLabel', () => {
  it('names the app, its device and how it was started', () => {
    expect(appLabel(fakeApp())).toBe('com.example.shop · Pixel 9 API 36 · IDE');
    expect(appLabel(fakeApp({ startedBy: 'terminal' }))).toBe(
      'com.example.shop · Pixel 9 API 36 · terminal',
    );
    // A live app from flutter run: device from the tool's name, no platform yet (QA B2-1).
    expect(
      appLabel(
        fakeApp({
          name: 'qa_sample_app',
          device: { id: 'unknown', name: 'sdk gphone64 arm64' },
          startedBy: 'unknown',
        }),
      ),
    ).toBe('qa_sample_app · sdk gphone64 arm64');
    const bare = fakeApp({ startedBy: 'unknown' });
    delete bare.device;
    expect(appLabel(bare)).toBe('com.example.shop');
  });
});

describe('resultText', () => {
  const base: LastResult = {
    ok: true,
    kind: 'reload',
    external: false,
    startedAt: 0,
    mark: { seq: undefined, key: 0 },
  };
  it('uses the spec copy', () => {
    expect(resultText({ ...base, durationMs: 182.4 })).toBe('Reloaded in 182 ms');
    expect(resultText({ ...base, kind: 'restart', durationMs: 900 })).toBe('Restarted in 900 ms');
    expect(resultText({ ...base, external: true })).toBe('Reloaded (from Claude or the IDE)');
    expect(resultText({ ...base, ok: false, message: 'x' })).toBe('Reload failed');
    expect(resultText({ ...base, ok: false, kind: 'restart' })).toBe('Restart failed');
  });
});

describe('activityText', () => {
  const app = { appId: 'a', appName: 'shop' };
  const cases: [ActivityEntry, string][] = [
    [{ id: 1, ts: 0, kind: 'claude.done' }, 'Claude finished'],
    [
      { id: 1, ts: 0, kind: 'claude.waiting', message: 'Allow Bash?' },
      'Claude is waiting: Allow Bash?',
    ],
    [{ id: 1, ts: 0, kind: 'claude.waiting' }, 'Claude is waiting'],
    [{ id: 1, ts: 0, kind: 'app.attached', ...app }, 'Attached to shop'],
    [{ id: 1, ts: 0, kind: 'app.detached', ...app }, 'Detached from shop'],
    [{ id: 1, ts: 0, kind: 'app.stopped', ...app }, 'App stopped'],
    [{ id: 1, ts: 0, kind: 'app.crashed', ...app }, 'App crashed'],
    [
      {
        id: 1,
        ts: 0,
        kind: 'app.reloaded',
        ...app,
        result: { ok: true, kind: 'hot-reload', durationMs: 182 },
      },
      'Reloaded in 182 ms',
    ],
    [
      {
        id: 1,
        ts: 0,
        kind: 'app.reloaded',
        ...app,
        result: { ok: true, kind: 'hot-restart', source: 'external' },
      },
      'Restarted (from Claude or the IDE)',
    ],
    [
      {
        id: 1,
        ts: 0,
        kind: 'app.reloaded',
        ...app,
        result: { ok: false, reason: 'compile-error', message: 'x' },
      },
      'Reload failed',
    ],
    [
      { id: 1, ts: 0, kind: 'claude.reload', ok: true, reload: 'hot-reload', ...app },
      'Reloaded (from Claude or the IDE)',
    ],
    [
      { id: 1, ts: 0, kind: 'claude.reload', ok: true, reload: 'hot-restart' },
      'Restarted (from Claude or the IDE)',
    ],
    [
      {
        id: 1,
        ts: 0,
        kind: 'claude.reload',
        ok: false,
        reload: 'hot-reload',
        message: 'Hot reload failed.',
      },
      'Reload failed: Hot reload failed.',
    ],
    [{ id: 1, ts: 0, kind: 'claude.reload', ok: false, reload: 'hot-restart' }, 'Restart failed'],
    [{ id: 1, ts: 0, kind: 'db.snapshot', db: 'app' }, 'Snapshot taken: app'],
    [{ id: 1, ts: 0, kind: 'db.diff', db: 'app' }, 'Diff shown: app'],
    [
      { id: 1, ts: 0, kind: 'db.write', db: 'app', tables: ['orders'], allowed: true, changes: 1 },
      'Write allowed: orders, 1 row changed',
    ],
    [
      { id: 1, ts: 0, kind: 'db.write', db: 'app', tables: ['a', 'b'], allowed: true, changes: 3 },
      'Write allowed: a, b, 3 rows changed',
    ],
    [
      { id: 1, ts: 0, kind: 'db.write', db: 'app', tables: ['orders'], allowed: false },
      'Write denied: orders',
    ],
  ];
  it.each(cases)('describes %j', (entry, text) => {
    expect(activityText(entry)).toBe(text);
  });

  it('names hidden characters in database and table names (TAB-6)', () => {
    const name = `ord${String.fromCodePoint(0x202e)}ers`;
    expect(activityText({ id: 1, ts: 0, kind: 'db.diff', db: name })).toBe(
      'Diff shown: ord<U+202E>ers',
    );
    expect(
      activityText({ id: 1, ts: 0, kind: 'db.write', db: 'app', tables: [name], allowed: false }),
    ).toBe('Write denied: ord<U+202E>ers');
  });
});
