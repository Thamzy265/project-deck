import type { ActivityEntry } from '@project-deck/core';
import { fakeApp } from '@project-deck/core/testing';
import { describe, expect, it } from 'vitest';
import type { DeckAction, DeckState } from './deck.js';
import { deckReducer, initialState } from './deck.js';

const run = (...actions: DeckAction[]): DeckState => actions.reduce(deckReducer, initialState);
const app = fakeApp();
const status = {
  version: '0.1.0',
  dashboardUrl: 'x',
  projectName: 'shop_app',
  discovering: false,
  apps: [app],
};

describe('deckReducer', () => {
  it('reads the status answer', () => {
    const s = run({ type: 'status', status: { ...status, attached: app } });
    expect(s.info).toEqual({ version: '0.1.0', projectName: 'shop_app' });
    expect(s.attached).toEqual(app);
    expect(s.lastApp).toEqual(app);
  });

  it('keeps the stopped app and its logs when the app exits', () => {
    const s = run(
      { type: 'attached', app },
      { type: 'logs-append', entries: [{ ts: 1, level: 'info', source: 'app', message: 'x' }] },
      { type: 'exited', appId: app.id },
    );
    expect(s.attached).toBeNull();
    expect(s.stoppedApp).toEqual(app);
    expect(s.logs.entries).toHaveLength(1);
    expect(run({ type: 'attached', app }, { type: 'exited', appId: 'other' }).attached).toEqual(
      app,
    );
  });

  it('times our own reload from when it started', () => {
    const s = run(
      { type: 'attached', app },
      { type: 'action-start', kind: 'reload', at: 100 },
      { type: 'reloaded', result: { ok: true, kind: 'hot-reload', durationMs: 182 }, at: 400 },
      { type: 'action-done', result: { ok: true, kind: 'hot-reload', durationMs: 182 }, at: 450 },
    );
    expect(s.running).toBeNull();
    expect(s.lastResult).toEqual({
      ok: true,
      kind: 'reload',
      external: false,
      durationMs: 182,
      startedAt: 100,
      mark: { seq: undefined, key: 0 },
    });
  });

  it('shows reloads and restarts made by Claude or the IDE', () => {
    const s = run({
      type: 'reloaded',
      result: { ok: true, kind: 'hot-restart', source: 'external' },
      at: 50,
    });
    expect(s.lastResult).toEqual({
      ok: true,
      kind: 'restart',
      external: true,
      startedAt: 50,
      mark: { seq: undefined, key: 0 },
    });
  });

  it('keeps the failure message and which action failed', () => {
    const s = run(
      { type: 'action-start', kind: 'restart', at: 5 },
      {
        type: 'action-done',
        result: { ok: false, reason: 'compile-error', message: 'bad' },
        at: 6,
      },
    );
    expect(s.lastResult).toMatchObject({ ok: false, kind: 'restart', message: 'bad' });
  });

  it('matches the socket event to our restart when the HTTP answer came first (review C4)', () => {
    const failed = { ok: false, reason: 'compile-error', message: 'bad' } as const;
    const s = run(
      { type: 'action-start', kind: 'restart', at: 5 },
      { type: 'action-done', result: failed, at: 6 },
      { type: 'reloaded', result: failed, at: 7 },
    );
    expect(s.lastResult).toMatchObject({ ok: false, kind: 'restart', startedAt: 5 });
    // A later reload by another tab is its own event.
    const later = deckReducer(s, { type: 'reloaded', result: failed, at: 9000 });
    expect(later.lastResult).toMatchObject({ kind: 'reload', startedAt: 9000 });
  });

  it('turns a failed HTTP call into a failed result and frees the buttons', () => {
    const s = run(
      { type: 'action-start', kind: 'reload', at: 5 },
      { type: 'action-failed', message: 'Network error', at: 6 },
    );
    expect(s.running).toBeNull();
    expect(s.lastResult).toMatchObject({ ok: false, message: 'Network error' });
  });

  it('remembers apps that cannot reload', () => {
    const s = run(
      { type: 'attached', app },
      { type: 'action-start', kind: 'reload', at: 1 },
      { type: 'action-done', result: { ok: false, reason: 'unsupported', message: 'no' }, at: 2 },
    );
    expect(s.unsupported).toEqual([app.id]);
  });

  it('clears the attach state once the app is attached', () => {
    const s = run({ type: 'attach-start', appId: app.id }, { type: 'attached', app });
    expect(s.attach).toEqual({ status: 'idle' });
    const failed = run(
      { type: 'attach-start', appId: app.id },
      { type: 'attach-failed', appId: app.id, error: 'gone' },
    );
    expect(failed.attach).toEqual({ status: 'error', appId: app.id, error: 'gone' });
  });

  it('drops an old attach error once an app is attached (review C5)', () => {
    const s = run(
      { type: 'attach-start', appId: 'app-2' },
      { type: 'attach-failed', appId: 'app-2', error: 'gone' },
      { type: 'attached', app },
    );
    expect(s.attach).toEqual({ status: 'idle' });
  });

  it('keeps at most 500 Activity entries, the newest, in time order (review C7)', () => {
    const adds: DeckAction[] = Array.from({ length: 600 }, (_, i) => ({
      type: 'activity-add',
      entry: { id: i, ts: 1000 + i, kind: 'claude.done' },
    }));
    const s = run(...adds, { type: 'activity-local', text: 'Reconnected', at: 1050 });
    expect(s.activity.items).toHaveLength(500);
    const times = s.activity.items.map((i) => i.ts);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times.at(-1)).toBe(1599);
  });

  it('merges activity by id and adds local entries', () => {
    const a: ActivityEntry = { id: 1, ts: 1, kind: 'claude.done' };
    const b: ActivityEntry = { id: 2, ts: 2, kind: 'claude.waiting', message: 'Allow?' };
    const s = run(
      { type: 'activity-add', entry: a },
      { type: 'activity-add', entry: a },
      { type: 'activity-local', text: 'Reconnected', at: 3 },
      { type: 'activity-loaded', entries: [a, b] },
    );
    expect(s.activity.items.map((i) => (i.kind === 'local' ? i.text : i.id))).toEqual([
      1,
      2,
      'Reconnected',
    ]);
    expect(s.activity.load).toEqual({ status: 'ready' });
  });

  it('empties the list and notes it in Activity when logs are cleared', () => {
    const s = run(
      {
        type: 'logs-loaded',
        gen: 0,
        entries: [{ ts: 1, level: 'info', source: 'app', message: 'x' }],
        merge: false,
      },
      { type: 'logs-cleared', at: 9 },
    );
    expect(s.logs.entries).toEqual([]);
    expect(s.activity.items).toMatchObject([{ kind: 'local', text: 'Logs cleared', ts: 9 }]);
  });

  it('notes a clear only once: the daemon event announces, this tab only empties', () => {
    const s = run({ type: 'logs-cleared-here', at: 9, gen: 0 }, { type: 'logs-cleared', at: 9 });
    expect(s.activity.items).toHaveLength(1);
  });

  it('drops a backfill that was on its way when the logs were cleared (review C2)', () => {
    const line = (ts: number, message: string) =>
      ({ ts, level: 'info', source: 'app', message }) as const;
    const s = run(
      { type: 'logs-append', entries: [line(50, 'private')] },
      { type: 'logs-cleared', at: 10 },
      // Asked for before the clear (generation 0). The device clock is ahead of the
      // computer's, so comparing times would keep these lines.
      { type: 'logs-loaded', entries: [line(40, 'old'), line(50, 'private')], merge: true, gen: 0 },
      { type: 'logs-append', entries: [line(60, 'after the clear')] },
    );
    expect(s.logs.entries.map((e) => e.message)).toEqual(['after the clear']);
    expect(s.logs.load).toEqual({ status: 'ready' });
  });

  it('does not clear again on the HTTP answer after the event already did (review C1)', () => {
    const line = (message: string) => ({ ts: 1, level: 'info', source: 'app', message }) as const;
    const s = run(
      { type: 'logs-append', entries: [line('before')] },
      { type: 'logs-cleared', at: 10 },
      { type: 'logs-append', entries: [line('arrived in between')] },
      { type: 'logs-cleared-here', at: 11, gen: 0 },
    );
    expect(s.logs.entries.map((e) => e.message)).toEqual(['arrived in between']);
    // Without the event (socket down), the HTTP answer clears.
    const alone = run(
      { type: 'logs-append', entries: [line('before')] },
      { type: 'logs-cleared-here', at: 11, gen: 0 },
    );
    expect(alone.logs.entries).toEqual([]);
  });
});
