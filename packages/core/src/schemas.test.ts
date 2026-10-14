import { describe, expect, it } from 'vitest';
import { DbQueryInput, HookEventInput, TaskSetStatusInput } from './api.js';
import { ReloadResultSchema, RunningAppSchema } from './apps.js';
import { TaskSchema } from './tasks.js';
import { fakeApp, fakeTask } from './testing/index.js';

describe('domain schemas', () => {
  it('accept the fake fixtures', () => {
    expect(RunningAppSchema.parse(fakeApp())).toEqual(fakeApp());
    expect(TaskSchema.parse(fakeTask())).toEqual(fakeTask());
  });

  it('accept an optional process id on a running app, positive integers only', () => {
    expect(RunningAppSchema.parse(fakeApp({ pid: 4242 })).pid).toBe(4242);
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      expect(RunningAppSchema.safeParse(fakeApp({ pid })).success).toBe(false);
    }
  });

  it('discriminate reload results on ok', () => {
    expect(
      ReloadResultSchema.safeParse({ ok: true, kind: 'hot-reload', durationMs: 10 }).success,
    ).toBe(true);
    expect(ReloadResultSchema.safeParse({ ok: false, kind: 'hot-reload' }).success).toBe(false);
    expect(
      ReloadResultSchema.safeParse({ ok: false, reason: 'needs-restart', message: 'enum changed' })
        .success,
    ).toBe(true);
  });

  it('mark reloads made by others, whose duration FlutterDeck never sees', () => {
    expect(ReloadResultSchema.parse({ ok: true, kind: 'hot-reload', source: 'external' })).toEqual({
      ok: true,
      kind: 'hot-reload',
      source: 'external',
    });
    expect(
      ReloadResultSchema.safeParse({
        ok: false,
        reason: 'compile-error',
        message: 'x',
        source: 'external',
      }).success,
    ).toBe(true);
    expect(
      ReloadResultSchema.safeParse({ ok: true, kind: 'hot-reload', source: 'claude' }).success,
    ).toBe(false);
  });
});

describe('TaskSchema', () => {
  it('only accepts http(s) task links', () => {
    expect(TaskSchema.safeParse(fakeTask({ url: 'http://linear.test/ENG-1' })).success).toBe(true);
    expect(TaskSchema.safeParse(fakeTask({ url: 'javascript:alert(1)' })).success).toBe(false);
    expect(TaskSchema.safeParse(fakeTask({ url: 'data:text/html,hi' })).success).toBe(false);
  });
});

describe('API inputs', () => {
  it('db_query accepts scalar params only and caps the limit', () => {
    expect(
      DbQueryInput.safeParse({ db: 'app', sql: 'select 1', params: [1, 'a', null] }).success,
    ).toBe(true);
    expect(DbQueryInput.safeParse({ db: 'app', sql: 'select 1', params: [{}] }).success).toBe(
      false,
    );
    expect(DbQueryInput.safeParse({ db: 'app', sql: 'select 1', limit: 1e9 }).success).toBe(false);
    expect(DbQueryInput.safeParse({ db: '', sql: 'select 1' }).success).toBe(false);
  });

  it('task_set_status only accepts known status types', () => {
    expect(TaskSetStatusInput.safeParse({ key: 'ENG-1', statusType: 'started' }).success).toBe(
      true,
    );
    expect(TaskSetStatusInput.safeParse({ key: 'ENG-1', statusType: 'In Progress' }).success).toBe(
      false,
    );
  });

  it('hook events are discriminated by type', () => {
    expect(HookEventInput.parse({ type: 'claude.waiting', message: 'Approve?' })).toEqual({
      type: 'claude.waiting',
      message: 'Approve?',
    });
    expect(HookEventInput.safeParse({ type: 'rm -rf' }).success).toBe(false);
  });
});
