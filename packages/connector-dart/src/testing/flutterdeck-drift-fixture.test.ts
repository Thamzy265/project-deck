/**
 * Hygiene of the recorded flutterdeck_drift session (fixtures/flutterdeck-drift-v1.recorded.json):
 * CLAUDE.md says recorded traffic must not hold tokens, auth codes, VM service URIs, local paths
 * or personal data. Re-recording with tool/record_fixtures.dart must keep it that way.
 */
import { readFileSync } from 'node:fs';
import { CellSchema, QueryResultSchema, TableInfoSchema } from '@project-deck/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const text = readFileSync(
  new URL('./fixtures/flutterdeck-drift-v1.recorded.json', import.meta.url),
  'utf8',
);
const fixture = JSON.parse(text) as {
  _source?: unknown;
  tablesEvent: { extensionData: unknown };
  exchanges: { label: string; request: { params?: Record<string, unknown> }; response: unknown }[];
};

/** The `result` of the exchange with this label. */
function result(label: string): unknown {
  const exchange = fixture.exchanges.find((e) => e.label === label);
  expect(exchange, label).toBeDefined();
  return (exchange?.response as { result?: unknown }).result;
}

const ProtocolError = z.object({
  protocol: z.literal(1),
  error: z.object({ code: z.string(), message: z.string() }),
});
/** A row key: one cell, or a JSON array of cells for a composite key. */
const Key = z.union([CellSchema, z.array(CellSchema)]);

/** Every string value in the fixture, with the path to it. */
function strings(value: unknown, path = '$'): [string, string][] {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${i}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => strings(v, `${path}.${k}`));
  }
  return [];
}

describe('flutterdeck_drift recorded fixture', () => {
  const all = strings(fixture);

  it('names its source', () => {
    expect(typeof fixture._source).toBe('string');
    expect(fixture.exchanges.length).toBeGreaterThan(0);
  });

  it('holds no VM service or DTD URI, and no URL at all', () => {
    for (const [path, s] of all) {
      expect(s, path).not.toMatch(/\b(?:wss?|https?):\/\//i);
    }
  });

  it('holds no local file path', () => {
    for (const [path, s] of all) {
      expect(s, path).not.toMatch(
        /(?:\/Users\/|\/home\/|\/var\/folders\/|\/private\/|\/tmp\/|[A-Za-z]:\\)/,
      );
    }
  });

  it('masks every write token and holds nothing token-shaped', () => {
    const tokens = fixture.exchanges
      .map((e) => e.request.params?.['token'])
      .filter((t) => t !== undefined);
    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) expect(t).toBe('<masked>');
    for (const [path, s] of all) {
      // A write token is 43 base64url characters; auth codes are similar.
      expect(s, path).not.toMatch(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/);
    }
  });

  it('holds no email address or phone-like number', () => {
    // Isolate ids are VM numbers, not personal data.
    for (const [path, s] of all.filter(([p]) => !p.endsWith('.isolateId'))) {
      expect(s, path).not.toMatch(/[^\s@]+@[^\s@]+\.[a-z]{2,}/i);
      expect(s, path).not.toMatch(/\+?\d(?: ?\d){9,}/);
    }
  });

  // The TypeScript side will validate replies with core's schemas (D-3), so the Dart package
  // must answer in exactly those shapes.
  describe("matches core's db schemas", () => {
    it('schema: every table entry is a TableInfo', () => {
      const r = z
        .object({ protocol: z.literal(1), tables: z.array(z.unknown()) })
        .parse(result('schema'));
      expect(r.tables.length).toBeGreaterThan(0);
      for (const t of r.tables) {
        const parsed = TableInfoSchema.strict().safeParse(t);
        expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      }
    });

    it('schema: sqlSchema holds every CREATE statement for the gate (schemaSql)', () => {
      const r = z
        .object({
          protocol: z.literal(1),
          tables: z.array(z.unknown()),
          sqlSchema: z.array(z.string().min(1)),
          sqlSchemaTruncated: z.literal(true).optional(),
        })
        .strict()
        .parse(result('schema'));
      expect(r.sqlSchemaTruncated).toBeUndefined();
      expect(r.sqlSchema.every((s) => /^CREATE /i.test(s))).toBe(true);
      // Every table and view has its CREATE text in sqlSchema too.
      const tableSql = (r.tables as { sql?: string }[]).flatMap((t) => (t.sql ? [t.sql] : []));
      for (const sql of tableSql) expect(r.sqlSchema).toContain(sql);
    });

    it('query: the reply is a QueryResult', () => {
      const parsed = QueryResultSchema.extend({ protocol: z.literal(1) })
        .strict()
        .safeParse(result('query'));
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    });

    it('snapshot: keys are cells and hashes are 16 hex digits', () => {
      const Table = z.union([
        z
          .object({
            name: z.string(),
            columns: z.array(z.string()),
            key: z.array(z.string()).min(1),
            rowid: z.literal(true).optional(),
            rows: z.array(z.tuple([Key, z.array(z.string().regex(/^[0-9a-f]{16}$/))])),
          })
          .strict(),
        z
          .object({ name: z.string(), error: z.object({ code: z.string(), message: z.string() }) })
          .strict(),
      ]);
      const parsed = z
        .object({ protocol: z.literal(1), takenAt: z.number().int(), tables: z.array(Table) })
        .strict()
        .safeParse(result('snapshot'));
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    });

    it('rows: every key and value is a cell', () => {
      const parsed = z
        .object({
          protocol: z.literal(1),
          columns: z.array(z.string()),
          key: z.array(z.string()),
          rowid: z.literal(true).optional(),
          rows: z.array(z.tuple([Key, z.array(CellSchema)])),
          missing: z.array(Key),
          truncated: z.boolean(),
        })
        .strict()
        .safeParse(result('rows'));
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    });

    it('errors are {protocol, error: {code, message}}', () => {
      for (const label of [
        'query refused (write)',
        'query refused (ATTACH)',
        'query unknown db',
        'execute without token',
        'query timeout',
      ]) {
        expect(ProtocolError.safeParse(result(label)).success, label).toBe(true);
      }
    });

    it('the tables event names tables with a kind', () => {
      const parsed = z
        .object({
          protocol: z.literal(1),
          db: z.string(),
          tables: z.array(
            z.object({ name: z.string(), kind: z.enum(['insert', 'update', 'delete', 'unknown']) }),
          ),
        })
        .strict()
        .safeParse(fixture.tablesEvent.extensionData);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    });
  });
});
