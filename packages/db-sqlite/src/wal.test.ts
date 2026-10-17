import { describe, expect, it } from 'vitest';
import { loadSqlite } from './sqlite.js';
import { plainDbFixture, walDbFixture, walFixture } from './testing/fixtures.js';
import {
  checkHeader,
  changeCounter,
  isHotJournal,
  mergeWal,
  walChecksum,
  walSalts,
} from './wal.js';

const PAGE = 1024;
const FRAME = 24 + PAGE;

/** Rows of `orders` in a database image, read with the real engine. */
async function orders(image: Uint8Array): Promise<unknown[][]> {
  const sqlite = await loadSqlite();
  const db = new sqlite.oo1.DB();
  try {
    const p = sqlite.wasm.allocFromTypedArray(new Uint8Array(image));
    const { capi } = sqlite;
    const rc = capi.sqlite3_deserialize(
      db.pointer ?? 0,
      'main',
      p,
      image.length,
      image.length,
      capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_READONLY,
    );
    expect(rc).toBe(0);
    return db.exec({
      sql: 'SELECT id, item, status FROM orders ORDER BY id',
      returnValue: 'resultRows',
    });
  } finally {
    db.close();
  }
}

/** Rewrites frame `i`'s page number and fixes up every checksum from there on. */
function forgePage(wal: Buffer, i: number, pgno: number): Buffer {
  const out = Buffer.from(wal);
  const bigEndian = (out.readUInt32BE(0) & 1) === 1;
  out.writeUInt32BE(pgno, 32 + i * FRAME);
  let sum: [number, number] = [out.readUInt32BE(24), out.readUInt32BE(28)];
  for (let f = 0; 32 + (f + 1) * FRAME <= out.length; f++) {
    const at = 32 + f * FRAME;
    sum = walChecksum(out.subarray(at, at + 8), sum, bigEndian);
    sum = walChecksum(out.subarray(at + 24, at + FRAME), sum, bigEndian);
    out.writeUInt32BE(sum[0], at + 16);
    out.writeUInt32BE(sum[1], at + 20);
  }
  return out;
}

describe('checkHeader', () => {
  it('accepts a SQLite file and refuses anything else, encrypted files included', () => {
    expect(() => checkHeader(plainDbFixture())).not.toThrow();
    for (const bad of [Buffer.from('nope'), Buffer.alloc(100), Buffer.from('SQLite format 2\0')]) {
      expect(() => checkHeader(bad)).toThrow(expect.objectContaining({ code: 'unsupported' }));
    }
  });
});

describe('mergeWal', () => {
  it('applies the committed WAL frames, so the copy shows the latest commit', async () => {
    const merged = mergeWal(walDbFixture(), walFixture(), 50 * 1024 * 1024);
    expect(await orders(merged)).toEqual([
      [1, 'Coffee', 'shipped'],
      [2, 'Tea', 'pending'],
      [3, 'Cake', 'pending'],
    ]);
    // Marked as a rollback-journal file, so the engine never looks for a WAL.
    expect([merged[18], merged[19]]).toEqual([1, 1]);
  });

  it('opens the main file alone (no WAL) at the last checkpoint', async () => {
    expect(await orders(mergeWal(walDbFixture(), undefined, 1e9))).toEqual([
      [1, 'Coffee', 'pending'],
      [2, 'Tea', 'pending'],
    ]);
    expect(await orders(mergeWal(plainDbFixture(), undefined, 1e9))).toEqual([
      [1, 'Coffee', 'pending'],
      [2, 'Tea', 'pending'],
    ]);
  });

  it('ignores frames after the last commit and a frame cut off by the copy', async () => {
    const wal = walFixture();
    // Without the last frame the final commit (ship order 1) is incomplete.
    const cut = wal.subarray(0, wal.length - FRAME / 2);
    expect(await orders(mergeWal(walDbFixture(), cut, 1e9))).toEqual([
      [1, 'Coffee', 'pending'],
      [2, 'Tea', 'pending'],
      [3, 'Cake', 'pending'],
    ]);
  });

  it('stops at a frame with a bad checksum or another salt (an older WAL generation)', async () => {
    const badSum = Buffer.from(walFixture());
    badSum[32 + 24 + 100] = (badSum[32 + 24 + 100] ?? 0) ^ 0xff;
    expect(await orders(mergeWal(walDbFixture(), badSum, 1e9))).toHaveLength(2);
    const badSalt = Buffer.from(walFixture());
    badSalt.writeUInt32BE((badSalt.readUInt32BE(32 + 8) ^ 1) >>> 0, 32 + 8);
    expect(await orders(mergeWal(walDbFixture(), badSalt, 1e9))).toHaveLength(2);
  });

  it('ignores a WAL whose header checksum is wrong', async () => {
    const wal = Buffer.from(walFixture());
    wal.writeUInt32BE((wal.readUInt32BE(24) ^ 1) >>> 0, 24);
    expect(await orders(mergeWal(walDbFixture(), wal, 1e9))).toHaveLength(2);
  });

  it('refuses a WAL frame for a page beyond the committed size (crafted WAL)', () => {
    const forged = forgePage(walFixture(), 0, 1_000_000);
    expect(() => mergeWal(walDbFixture(), forged, 1e9)).toThrow(
      expect.objectContaining({ code: 'internal' }),
    );
    expect(() => mergeWal(walDbFixture(), forgePage(walFixture(), 0, 0), 1e9)).toThrow(
      expect.objectContaining({ code: 'internal' }),
    );
  });

  it('counts the merged size in the cap, and refuses a page size mismatch', () => {
    expect(() => mergeWal(walDbFixture(), walFixture(), 4096)).toThrow(
      expect.objectContaining({ code: 'too-large' }),
    );
    const wal = Buffer.from(walFixture());
    wal.writeUInt32BE(4096, 8);
    expect(() => mergeWal(walDbFixture(), wal, 1e9)).toThrow(
      expect.objectContaining({ code: 'busy' }),
    );
  });

  it('refuses a main file cut mid-page (copied while it grew)', () => {
    expect(() => mergeWal(walDbFixture().subarray(0, PAGE * 2 + 10), undefined, 1e9)).toThrow(
      expect.objectContaining({ code: 'busy' }),
    );
  });
});

describe('consistency markers', () => {
  it('reads the header change counter, the WAL salts and a hot journal', () => {
    expect(changeCounter(plainDbFixture())).toBeGreaterThan(0);
    expect(changeCounter(Buffer.alloc(10))).toBeUndefined();
    expect(walSalts(walFixture())).toBe(walFixture().subarray(16, 24).toString('hex'));
    expect(walSalts(undefined)).toBe('');
    const hot = Buffer.alloc(28);
    Buffer.from('d9d505f920a163d7', 'hex').copy(hot);
    expect(isHotJournal(hot)).toBe(true);
    expect(isHotJournal(Buffer.alloc(28))).toBe(false);
    expect(isHotJournal(undefined)).toBe(false);
  });
});
