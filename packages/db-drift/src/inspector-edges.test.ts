/**
 * Tester probes for the live Drift backend: replies the app should never send, event
 * floods, a restart in the middle of a call, and the write token's shape.
 */
import { AppExtensionError } from '@project-deck/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DriftInspector } from './inspector.js';
import { FakeDriftApp, RECORDED_QUERY, RECORDED_SNAPSHOT } from './testing/fake-drift-app.js';

afterEach(() => {
  vi.useRealTimers();
});

const QUERY = 'ext.flutterdeck.drift.v1.query';

describe('DriftInspector replies (tester probes)', () => {
  it('drops fields the protocol does not name, so app extras never reach callers', async () => {
    const app = new FakeDriftApp().handle('query', () => ({
      ...RECORDED_QUERY,
      debugPath: '/data/user/0/com.example.shop/app_flutter/app.sqlite',
      sql: 'SELECT secret FROM users',
    }));
    const db = new DriftInspector(app.extensions);
    const result = await db.query('app', 'SELECT * FROM orders');
    expect(Object.keys(result).sort()).toEqual(['columns', 'durationMs', 'rows', 'truncated']);
  });

  it('refuses replies without a numeric protocol, or with another version', async () => {
    for (const [reply, code] of [
      [{ ...RECORDED_QUERY }, 'internal'],
      [{ protocol: '1', ...RECORDED_QUERY }, 'internal'],
      [{ protocol: 0, ...RECORDED_QUERY }, 'update-needed'],
      [{ protocol: 2, ...RECORDED_QUERY }, 'update-needed'],
      [{ protocol: 1.5, ...RECORDED_QUERY }, 'update-needed'],
      [null, 'internal'],
      ['{"protocol":1}', 'internal'],
    ] as const) {
      const app = new FakeDriftApp();
      app.extensions.handle(QUERY, () => reply);
      const db = new DriftInspector(app.extensions);
      await expect(db.query('app', 'SELECT 1'), JSON.stringify(reply)).rejects.toMatchObject({
        code,
      });
    }
  });

  it('never repeats app text for unknown error codes', async () => {
    const app = new FakeDriftApp().handle('query', () => ({
      error: { code: 'weird', message: 'row 7: alice@example.com' },
    }));
    const db = new DriftInspector(app.extensions);
    const err: unknown = await db.query('app', 'SELECT 1').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'internal' });
    expect((err as Error).message).not.toContain('alice');
  });

  it("strips control and bidi characters from SQLite's message and caps its length", async () => {
    const app = new FakeDriftApp().handle('query', () => ({
      error: {
        code: 'sql-error',
        message: `no such column: x\u001b[31m\u202eevil\n${'y'.repeat(2000)}`,
      },
    }));
    const db = new DriftInspector(app.extensions);
    const err = (await db.query('app', 'SELECT x').catch((e: unknown) => e)) as Error;
    expect(err).toMatchObject({ code: 'sql-error' });
    const unsafe = Array.from({ length: err.message.length }, (_, i) =>
      err.message.charCodeAt(i),
    ).filter((c) => c < 0x20 || c === 0x202e);
    expect(unsafe).toEqual([]);
    expect(err.message.length).toBeLessThanOrEqual(501);
  });

  it('refuses a snapshot reply with a malformed hash or key, instead of diffing it', async () => {
    for (const rows of [
      [[1, ['not-hex']]],
      [[{ nested: true }, ['529a2ddc8ff5355f']]],
      [[1, '529a2ddc8ff5355f']],
    ]) {
      const app = new FakeDriftApp().handle('snapshot', () => ({
        ...RECORDED_SNAPSHOT,
        tables: [{ name: 'orders', columns: ['id'], key: ['id'], rows }],
      }));
      const db = new DriftInspector(app.extensions);
      await expect(db.rowHashes('app'), JSON.stringify(rows)).rejects.toMatchObject({
        code: 'internal',
      });
    }
  });

  it("hides the connector's text when a restart or exit ends the call midway", async () => {
    const app = new FakeDriftApp();
    app.extensions.handle(QUERY, () => {
      throw new AppExtensionError('detached', 'isolate exited: /secret/path');
    });
    const db = new DriftInspector(app.extensions);
    // `failed` from the fake: the connector's own text never shows.
    const err = (await db.query('app', 'SELECT 1').catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain('/secret/path');
  });

  it('passes table names with quotes, NUL and unicode to the app as data, unchanged', async () => {
    const app = new FakeDriftApp();
    const db = new DriftInspector(app.extensions);
    const name = 'or"ders\u0000; DROP TABLE x;--é';
    await db.rowsByKey('app', name, [1]);
    const call = app.extensions.calls.find((c) => c.method.endsWith('.rows'));
    expect(call?.params.table).toBe(name);
  });
});

describe('DriftInspector write token (tester probes)', () => {
  it('refuses tokens that are not exactly 43 base64url characters, before calling the app', async () => {
    const app = new FakeDriftApp();
    const db = new DriftInspector(app.extensions);
    for (const token of [
      '',
      'A'.repeat(42),
      'A'.repeat(44),
      `${'A'.repeat(42)}=`,
      `${'A'.repeat(42)}+`,
      `${'A'.repeat(42)}/`,
      `${'A'.repeat(42)}\n`,
      `${'A'.repeat(42)}é`,
    ]) {
      await expect(
        db.execute('app', 'DELETE FROM orders', [], { token }),
        JSON.stringify(token),
      ).rejects.toMatchObject({ code: 'bad-token' });
    }
    expect(app.extensions.calls.filter((c) => c.method.endsWith('.execute'))).toEqual([]);
  });
});

describe('DriftInspector events (tester probes)', () => {
  it('folds a flood of 10,000 events into one call now and one trailing call', () => {
    vi.useFakeTimers();
    const app = new FakeDriftApp();
    const db = new DriftInspector(app.extensions);
    const cb = vi.fn();
    db.watch('app', 'orders', cb);
    for (let i = 0; i < 10_000; i++) app.emitTables('app', [{ name: 'orders' }]);
    expect(cb).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(250);
    expect(cb).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(10_000);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer behind after close, even with trailing calls pending on many tables', async () => {
    vi.useFakeTimers();
    const app = new FakeDriftApp();
    const db = new DriftInspector(app.extensions);
    const tables = Array.from({ length: 50 }, (_, i) => ({ name: `t${i}` }));
    for (const t of tables) db.watch('app', t.name, () => undefined);
    app.emitTables('app', tables);
    app.emitTables('app', tables);
    expect(vi.getTimerCount()).toBe(50);
    await db.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps going when one watcher throws', () => {
    const app = new FakeDriftApp();
    const db = new DriftInspector(app.extensions);
    const good = vi.fn();
    db.watch('app', 'orders', () => {
      throw new Error('boom');
    });
    db.watch('app', 'orders', good);
    app.emitTables('app', [{ name: 'orders' }]);
    expect(good).toHaveBeenCalledOnce();
  });

  it('does not subscribe to app events for a watch made after close', async () => {
    const app = new FakeDriftApp();
    const db = new DriftInspector(app.extensions);
    await db.close();
    const cb = vi.fn();
    const off = db.watch('app', 'orders', cb);
    app.emitTables('app', [{ name: 'orders' }]);
    off();
    expect(cb).not.toHaveBeenCalled();
  });

  it('ignores an event with more than 10,000 tables or an over-long table name', () => {
    const app = new FakeDriftApp();
    const db = new DriftInspector(app.extensions);
    const cb = vi.fn();
    db.watch('app', 'orders', cb);
    app.emitTables('app', [
      ...Array.from({ length: 10_000 }, () => ({ name: 'x' })),
      { name: 'orders' },
    ]);
    app.emitTables('app', [{ name: 'orders', kind: 'k'.repeat(33) }]);
    expect(cb).not.toHaveBeenCalled();
  });
});
