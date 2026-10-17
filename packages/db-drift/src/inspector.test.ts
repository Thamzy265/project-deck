import { readFileSync } from 'node:fs';
import { AppExtensionError, DbError } from '@project-deck/core';
import { FakeAppExtensions } from '@project-deck/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DriftInspector } from './inspector.js';
import { FakeDriftApp, RECORDED_QUERY } from './testing/fake-drift-app.js';

interface Exchange {
  label: string;
  request: { method: string; params: Record<string, string> };
  response: { result?: Record<string, unknown> };
}
const recorded = JSON.parse(
  readFileSync(
    new URL(
      '../../connector-dart/src/testing/fixtures/flutterdeck-drift-v1.recorded.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { exchanges: Exchange[]; tablesEvent: { extensionData: unknown } };

/** An app that answers every call with the recorded reply for the same method and params. */
function recordedApp(): FakeAppExtensions {
  const ext = new FakeAppExtensions();
  const byMethod = new Map<string, Exchange[]>();
  for (const x of recorded.exchanges) {
    byMethod.set(x.request.method, [...(byMethod.get(x.request.method) ?? []), x]);
  }
  for (const [method, exchanges] of byMethod) {
    ext.handle(method, (params) => {
      // JSON-valued parameters match by value: the recorder spaced them differently.
      const same = (k: string, v: string): boolean =>
        k === 'params' || k === 'keys'
          ? JSON.stringify(JSON.parse(v)) === JSON.stringify(JSON.parse(params[k] ?? 'null'))
          : params[k] === v;
      // The connector adds isolateId; recorded tokens are masked.
      const match = exchanges.find((x) =>
        Object.entries(x.request.params)
          .filter(([k]) => k !== 'isolateId' && k !== 'token')
          .every(([k, v]) => same(k, v)),
      );
      if (match?.response.result !== undefined) return match.response.result;
      // As the app answers any call for a database it doesn't have (recorded for query).
      if (params.db !== undefined && params.db !== 'app') {
        return { protocol: 1, error: { code: 'unknown-db', message: 'No database named x' } };
      }
      throw new Error(`No recording for ${method}`);
    });
  }
  return ext;
}

const TOKEN = 'A'.repeat(43);

afterEach(() => {
  vi.useRealTimers();
});

describe('DriftInspector over the recorded flutterdeck_drift session', () => {
  it('lists databases, reads the schema and the schema SQL', async () => {
    const db = new DriftInspector(recordedApp());
    expect(db.live).toBe(true);
    expect(await db.listDatabases()).toEqual([{ name: 'app', backend: 'live' }]);
    const tables = await db.schema('app');
    expect(tables.map((t) => t.name)).toEqual(['lines', 'orders', 'raw']);
    expect(tables[1]?.columns[2]).toMatchObject({ name: 'status', default: "'pending'" });
    expect(await db.schemaSql('app')).toContain('CREATE TABLE sqlite_sequence(name,seq)');
  });

  it('runs a query with JSON parameters and a limit', async () => {
    const db = new DriftInspector(recordedApp());
    const result = await db.query(
      'app',
      'SELECT id, item, status FROM orders WHERE status = ?',
      ['pending'],
      { limit: 100 },
    );
    expect(result).toMatchObject({ columns: ['id', 'item', 'status'], truncated: false });
    expect(result.rows).toEqual([
      [1, 'Coffee', 'pending'],
      [2, 'Tea', 'pending'],
    ]);
  });

  it("maps the app's refusals and errors to DbError codes with plain words", async () => {
    const db = new DriftInspector(recordedApp());
    await expect(db.query('app', 'DELETE FROM orders RETURNING *')).rejects.toMatchObject({
      code: 'refused',
    });
    await expect(db.query('nope', 'SELECT 1')).rejects.toMatchObject({ code: 'not-found' });
    await expect(
      db.query(
        'app',
        'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c, orders',
      ),
    ).rejects.toMatchObject({
      code: 'timeout',
      message: 'That query took too long and was stopped.',
    });
  });

  it('reads diff hashes and rows by key', async () => {
    const db = new DriftInspector(recordedApp());
    const hashes = await db.rowHashes('app');
    expect(hashes.takenAt).toBe(1792176214286);
    expect(hashes.tables.find((t) => t.name === 'lines')).toMatchObject({ rowid: true });
    expect(await db.rowsByKey('app', 'orders', [3, 99])).toEqual({
      columns: ['id', 'item', 'status'],
      key: ['id'],
      rows: [[3, [3, 'Cake', 'pending']]],
      missing: [99],
      truncated: false,
    });
  });

  it('sends edits only with a token, and maps a refused token', async () => {
    const db = new DriftInspector(recordedApp());
    await expect(
      db.execute('app', 'UPDATE orders SET status = ? WHERE id = ?', ['shipped', 1], {
        token: TOKEN,
      }),
    ).resolves.toEqual({ changes: 1 });
    await expect(
      db.execute('app', 'UPDATE orders SET status = ? WHERE id = ?', ['shipped', 1]),
    ).rejects.toMatchObject({ code: 'bad-token' });
  });
});

describe('DriftInspector failure paths', () => {
  it('asks for setup when the app has no flutterdeck_drift', async () => {
    const db = new DriftInspector(new FakeAppExtensions());
    await expect(db.listDatabases()).rejects.toMatchObject({
      code: 'setup-needed',
      message: expect.stringContaining('flutterdeck_drift') as unknown,
    });
  });

  it('asks for an update when the app speaks another protocol version', async () => {
    const app = new FakeDriftApp();
    app.extensions.handle('ext.flutterdeck.drift.v1.list', () => ({ protocol: 2, databases: [] }));
    await expect(new DriftInspector(app.extensions).listDatabases()).rejects.toMatchObject({
      code: 'update-needed',
    });
  });

  it('refuses a malformed reply instead of passing it on', async () => {
    const app = new FakeDriftApp().handle('query', () => ({ columns: ['a'], rows: [[{ x: 1 }]] }));
    await expect(new DriftInspector(app.extensions).query('app', 'SELECT 1')).rejects.toMatchObject(
      {
        code: 'internal',
      },
    );
  });

  it('says the app stopped, or did not answer (breakpoint), without app text', async () => {
    const ext = new FakeAppExtensions();
    ext.handle('ext.flutterdeck.drift.v1.list', () => {
      throw new AppExtensionError('timeout', 'raw text');
    });
    const db = new DriftInspector(ext);
    await expect(db.listDatabases()).rejects.toMatchObject({ code: 'timeout' });
    ext.detached = true;
    await expect(db.listDatabases()).rejects.toMatchObject({ code: 'app-gone' });
  });

  it('answers unsupported for queries in a Linux app, and keeps other calls working', async () => {
    const app = new FakeDriftApp().handle('query', () => ({
      error: { code: 'unsupported', message: 'whatever the app says' },
    }));
    const db = new DriftInspector(app.extensions);
    const err: unknown = await db.query('app', 'SELECT 1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbError);
    expect(err).toMatchObject({ code: 'unsupported' });
    expect((err as DbError).message).toMatch(/can't stop a slow query/);
    expect((err as DbError).message).not.toContain('whatever');
    expect((await db.schema('app')).length).toBe(2);
  });

  it('reports a busy edit (waiting behind a long read) as busy', async () => {
    const app = new FakeDriftApp().handle('execute', () => ({
      error: { code: 'busy', message: 'x' },
    }));
    await expect(
      new DriftInspector(app.extensions).execute('app', 'DELETE FROM orders', [], { token: TOKEN }),
    ).rejects.toMatchObject({ code: 'busy' });
  });

  it('says an edit that timed out may still have run', async () => {
    const ext = new FakeAppExtensions();
    ext.handle('ext.flutterdeck.drift.v1.execute', () => {
      throw new AppExtensionError('timeout', 'x');
    });
    await expect(
      new DriftInspector(ext).execute('app', 'DELETE FROM orders', [], { token: TOKEN }),
    ).rejects.toMatchObject({
      code: 'timeout',
      message: expect.stringMatching(/may still/) as unknown,
    });
  });

  it('gives queries and edits long enough for the app to finish first', async () => {
    const app = new FakeDriftApp();
    const call = vi.spyOn(app.extensions, 'call');
    const db = new DriftInspector(app.extensions);
    await db.query('app', 'SELECT 1');
    await db.execute('app', 'DELETE FROM orders', [], { token: TOKEN });
    const timeouts = call.mock.calls.map(([method, , opts]) => [method, opts?.timeoutMs]);
    // The app stops a read at 5 s and waits up to 1 s more; an edit can wait 5 s behind it.
    expect(timeouts).toContainEqual(['ext.flutterdeck.drift.v1.query', 8000]);
    expect(timeouts).toContainEqual(['ext.flutterdeck.drift.v1.execute', 15_000]);
  });

  it('never sends a malformed token or too many keys', async () => {
    const app = new FakeDriftApp();
    const db = new DriftInspector(app.extensions);
    await expect(
      db.execute('app', 'DELETE FROM orders', [], { token: 'short' }),
    ).rejects.toMatchObject({ code: 'bad-token' });
    await expect(
      db.rowsByKey(
        'app',
        'orders',
        Array.from({ length: 1001 }, (_, i) => i),
      ),
    ).rejects.toMatchObject({ code: 'too-large' });
    expect(app.extensions.calls.filter((c) => c.method.endsWith('.execute'))).toHaveLength(0);
  });
});

describe('the schema SQL for the gate', () => {
  it('fails closed when the app cut the schema SQL (sqlSchemaTruncated)', async () => {
    const app = new FakeDriftApp().handle('schema', () => ({
      tables: [],
      sqlSchema: ['CREATE TABLE a(x)'],
      sqlSchemaTruncated: true,
    }));
    const db = new DriftInspector(app.extensions);
    await expect(db.schemaSql('app')).rejects.toMatchObject({ code: 'too-large' });
    // The schema itself still shows; queries never run.
    expect(await db.schema('app')).toEqual([]);
    await expect(db.query('app', 'SELECT 1')).rejects.toMatchObject({ code: 'too-large' });
    expect(app.extensions.calls.some((c) => c.method.endsWith('.query'))).toBe(false);
  });

  it('checks the schema before the first query, and again after a hot restart', async () => {
    let truncated = false;
    const app = new FakeDriftApp().handle('schema', () => ({
      tables: [],
      sqlSchema: [],
      ...(truncated ? { sqlSchemaTruncated: true } : {}),
    }));
    let restart: () => void = () => undefined;
    const db = new DriftInspector(app.extensions, {
      onRestart: (cb) => {
        restart = cb;
        return () => undefined;
      },
    });
    expect((await db.query('app', 'SELECT 1')).rows).toEqual(RECORDED_QUERY.rows);
    truncated = true;
    restart();
    await expect(db.query('app', 'SELECT 1')).rejects.toMatchObject({ code: 'too-large' });
  });

  it('carries a per-table error from the schema reply', async () => {
    const app = new FakeDriftApp().handle('schema', () => ({
      tables: [
        {
          name: 'coffee',
          kind: 'view',
          columns: [],
          foreignKeys: [],
          indexes: [],
          error: { code: 'unsupported', message: "FlutterDeck can't read coffee" },
        },
      ],
      sqlSchema: [],
    }));
    const [view] = await new DriftInspector(app.extensions).schema('app');
    expect(view?.error).toEqual({ code: 'unsupported', message: "FlutterDeck can't read coffee" });
  });
});

describe('watch', () => {
  it('passes on the recorded table event', () => {
    const app = new FakeDriftApp();
    const db = new DriftInspector(app.extensions);
    const cb = vi.fn();
    db.watch('app', 'orders', cb);
    app.extensions.emit('flutterdeck.drift.tables', recorded.tablesEvent.extensionData);
    expect(cb).toHaveBeenCalledOnce();
  });

  it('coalesces to at most one call per table per 250 ms, with a trailing call', () => {
    vi.useFakeTimers();
    const app = new FakeDriftApp();
    const db = new DriftInspector(app.extensions);
    const orders = vi.fn();
    const lines = vi.fn();
    db.watch('app', 'orders', orders);
    db.watch('app', 'lines', lines);
    app.emitTables('app', [{ name: 'orders' }]);
    app.emitTables('app', [{ name: 'orders' }, { name: 'lines' }]);
    app.emitTables('app', [{ name: 'orders' }]);
    expect(orders).toHaveBeenCalledTimes(1);
    expect(lines).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(249);
    expect(orders).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(orders).toHaveBeenCalledTimes(2);
    expect(lines).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(orders).toHaveBeenCalledTimes(2);
  });

  it('ignores malformed events, other databases and unwatched tables, and stops on unsubscribe', () => {
    const app = new FakeDriftApp();
    const db = new DriftInspector(app.extensions);
    const cb = vi.fn();
    const off = db.watch('app', 'orders', cb);
    for (const bad of [
      null,
      'orders',
      { protocol: 2, db: 'app', tables: [{ name: 'orders', kind: 'insert' }] },
      { protocol: 1, db: 'app', tables: 'orders' },
      { protocol: 1, db: 'app', tables: [{ name: 7 }] },
    ]) {
      app.extensions.emit('flutterdeck.drift.tables', bad);
    }
    app.emitTables('other', [{ name: 'orders' }]);
    app.emitTables('app', [{ name: 'lines' }]);
    expect(cb).not.toHaveBeenCalled();
    off();
    app.emitTables('app', [{ name: 'orders' }]);
    expect(cb).not.toHaveBeenCalled();
  });

  it('close() stops events and pending trailing calls', async () => {
    vi.useFakeTimers();
    const app = new FakeDriftApp();
    const db = new DriftInspector(app.extensions);
    const cb = vi.fn();
    db.watch('app', 'orders', cb);
    app.emitTables('app', [{ name: 'orders' }]);
    app.emitTables('app', [{ name: 'orders' }]);
    await db.close();
    vi.advanceTimersByTime(1000);
    app.emitTables('app', [{ name: 'orders' }]);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('stops listening to the app when the last watcher leaves, and listens again on the next', () => {
    const app = new FakeDriftApp();
    const unsubscribed = vi.fn();
    const onEvent = app.extensions.onEvent.bind(app.extensions);
    const subscribe = vi.spyOn(app.extensions, 'onEvent').mockImplementation((kind, cb) => {
      const off = onEvent(kind, cb);
      return () => {
        unsubscribed();
        off();
      };
    });
    const db = new DriftInspector(app.extensions);
    const offA = db.watch('app', 'orders', vi.fn());
    const offB = db.watch('app', 'lines', vi.fn());
    expect(subscribe).toHaveBeenCalledTimes(1);
    offA();
    expect(unsubscribed).not.toHaveBeenCalled();
    offB();
    expect(unsubscribed).toHaveBeenCalledOnce();
    const cb = vi.fn();
    db.watch('app', 'orders', cb);
    expect(subscribe).toHaveBeenCalledTimes(2);
    app.emitTables('app', [{ name: 'orders' }]);
    expect(cb).toHaveBeenCalledOnce();
  });
});
