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
      { type: 'action-done', result: { ok: true, kind: 'hot-reload', durationMs: 182 } },
    );
    expect(s.running).toBeNull();
    expect(s.lastResult).toEqual({
      ok: true,
      kind: 'reload',
      external: false,
      durationMs: 182,
      startedAt: 100,
    });
  });

  it('shows reloads and restarts made by Claude or the IDE', () => {
    const s = run({
      type: 'reloaded',
      result: { ok: true, kind: 'hot-restart', source: 'external' },
      at: 50,
    });
    expect(s.lastResult).toEqual({ ok: true, kind: 'restart', external: true, startedAt: 50 });
  });

  it('keeps the failure message and which action failed', () => {
    const s = run(
      { type: 'action-start', kind: 'restart', at: 5 },
      { type: 'action-done', result: { ok: false, reason: 'compile-error', message: 'bad' } },
    );
    expect(s.lastResult).toMatchObject({ ok: false, kind: 'restart', message: 'bad' });
  });

  it('turns a failed HTTP call into a failed result and frees the buttons', () => {
    const s = run(
      { type: 'action-start', kind: 'reload', at: 5 },
      { type: 'action-failed', message: 'Network error' },
    );
    expect(s.running).toBeNull();
    expect(s.lastResult).toMatchObject({ ok: false, message: 'Network error' });
  });

  it('remembers apps that cannot reload', () => {
    const s = run(
      { type: 'attached', app },
      { type: 'action-start', kind: 'reload', at: 1 },
      { type: 'action-done', result: { ok: false, reason: 'unsupported', message: 'no' } },
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
      'Reconnected',
      1,
      2,
    ]);
    expect(s.activity.load).toEqual({ status: 'ready' });
  });

  it('empties the list and notes it in Activity when logs are cleared', () => {
    const s = run(
      {
        type: 'logs-loaded',
        entries: [{ ts: 1, level: 'info', source: 'app', message: 'x' }],
        merge: false,
      },
      { type: 'logs-cleared', at: 9 },
    );
    expect(s.logs.entries).toEqual([]);
    expect(s.activity.items).toMatchObject([{ kind: 'local', text: 'Logs cleared', ts: 9 }]);
  });
});
