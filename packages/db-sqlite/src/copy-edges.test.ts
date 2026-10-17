/**
 * Tester probes for the snapshot copy and the WAL merge (design review D4): writes that
 * race the copy, files that lie about themselves, and page sizes at both ends.
 * Tests marked `it.fails` (DB-n) are repros of open tester findings: they turn into
 * plain `it` tests when the fix lands.
 */
import { describe, expect, it } from 'vitest';
import { copyDatabase } from './copy.js';
import { FakeSnapshotSource } from './testing/fake-source.js';
import { plainDbFixture, walDbFixture, walFixture } from './testing/fixtures.js';
import { mergeWal, walChecksum } from './wal.js';

const MB = 1024 * 1024;
const NAME = 'app_flutter/app.sqlite';
const JOURNAL = `${NAME}-journal`;

function hotJournal(): Buffer {
  const j = Buffer.alloc(512);
  Buffer.from('d9d505f920a163d7', 'hex').copy(j);
  return j;
}

/** A header-only database image: magic, a page size, `pages` pages of zeros. */
function blankDb(pageSizeField: number, pageSize: number, pages = 1): Buffer {
  const db = Buffer.alloc(pageSize * pages);
  Buffer.from('SQLite format 3\0', 'latin1').copy(db);
  db.writeUInt16BE(pageSizeField, 16);
  db[18] = 1;
  db[19] = 1;
  db.writeUInt32BE(7, 24);
  db.writeUInt32BE(pages, 28);
  db.writeUInt32BE(7, 92);
  return db;
}

/**
 * A WAL (little-endian checksums, as the macOS fixture) with valid header and frame
 * checksums, one frame per entry. Built with the format at sqlite.org/fileformat2.html.
 */
function forgeWal(pageSize: number, frames: { pgno: number; commit: number }[]): Buffer {
  const header = Buffer.alloc(32);
  header.writeUInt32BE(0x377f0682, 0);
  header.writeUInt32BE(3007000, 4);
  header.writeUInt32BE(pageSize, 8);
  header.writeUInt32BE(1, 12);
  header.writeUInt32BE(0x11111111, 16);
  header.writeUInt32BE(0x22222222, 20);
  let sum = walChecksum(header.subarray(0, 24), [0, 0], false);
  header.writeUInt32BE(sum[0], 24);
  header.writeUInt32BE(sum[1], 28);
  const parts = [header];
  for (const f of frames) {
    const frame = Buffer.alloc(24 + pageSize);
    frame.writeUInt32BE(f.pgno, 0);
    frame.writeUInt32BE(f.commit, 4);
    frame.writeUInt32BE(0x11111111, 8);
    frame.writeUInt32BE(0x22222222, 12);
    sum = walChecksum(frame.subarray(0, 8), sum, false);
    sum = walChecksum(frame.subarray(24), sum, false);
    frame.writeUInt32BE(sum[0], 16);
    frame.writeUInt32BE(sum[1], 20);
    parts.push(frame);
  }
  return Buffer.concat(parts);
}

describe('copyDatabase: a rollback-journal write that races the copy', () => {
  it('DB-4: does not return a copy taken while a hot journal appeared mid-copy', async () => {
    // The app starts a commit right after the journal check: the journal becomes hot and
    // page 1 (with the new change counter) is written first, so `before`, the copy and
    // `after` all see the same counter while the other pages are still being written.
    const source = new FakeSnapshotSource({ [NAME]: plainDbFixture() });
    const torn = Buffer.from(plainDbFixture());
    torn.fill(0xee, torn.length - 512);
    let journalChecks = 0;
    const head = source.head.bind(source);
    source.head = (path, bytes) => {
      if (path === JOURNAL && journalChecks++ === 0) {
        // Journal checked: no write yet. The write starts now.
        const result = head(path, bytes);
        source.files[JOURNAL] = hotJournal();
        source.files[NAME] = torn;
        return result;
      }
      return head(path, bytes);
    };
    // The journal stays hot for the rest of the copy, so no attempt is consistent.
    const outcome = await copyDatabase(source, NAME, 50 * MB).then(
      () => 'returned a copy taken during a write',
      (err: unknown) => (err as { code?: string }).code,
    );
    expect(outcome).toBe('busy');
  });

  it('copies again when the journal was hot only during an earlier attempt', async () => {
    const source = new FakeSnapshotSource({
      [NAME]: plainDbFixture(),
      [JOURNAL]: hotJournal(),
    });
    let reads = 0;
    const head = source.head.bind(source);
    source.head = (path, bytes) => {
      if (path === JOURNAL && reads++ === 1) Reflect.deleteProperty(source.files, JOURNAL);
      return head(path, bytes);
    };
    const image = await copyDatabase(source, NAME, 50 * MB);
    expect(image.length).toBe(plainDbFixture().length);
  });
});

describe('copyDatabase: files that are not what they claim', () => {
  it('refuses a 0-byte database file as not SQLite, without retrying', async () => {
    const source = new FakeSnapshotSource({ [NAME]: Buffer.alloc(0) });
    await expect(copyDatabase(source, NAME, 50 * MB)).rejects.toMatchObject({
      code: 'unsupported',
    });
    expect(source.reads).toEqual([]);
  });

  it('refuses a file shorter than the 100-byte header', async () => {
    const source = new FakeSnapshotSource({
      [NAME]: Buffer.from('SQLite format 3\0', 'latin1'),
    });
    await expect(copyDatabase(source, NAME, 50 * MB)).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('refuses a text file named .sqlite, such as an error page', async () => {
    const source = new FakeSnapshotSource({
      [NAME]: Buffer.from(`run-as: package not debuggable\n${' '.repeat(200)}`),
    });
    await expect(copyDatabase(source, NAME, 50 * MB)).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('copies a database with no -wal and no -journal next to it', async () => {
    const source = new FakeSnapshotSource({ [NAME]: walDbFixture() });
    const image = await copyDatabase(source, NAME, 50 * MB);
    expect(image.length).toBe(walDbFixture().length);
    expect(source.reads).toEqual([NAME]);
  });

  it('refuses a WAL that alone is over the cap, before reading it', async () => {
    const source = new FakeSnapshotSource({
      [NAME]: walDbFixture(),
      [`${NAME}-wal`]: Buffer.concat([walFixture(), Buffer.alloc(2 * MB)]),
    });
    await expect(copyDatabase(source, NAME, MB)).rejects.toMatchObject({ code: 'too-large' });
    expect(source.reads).toEqual([NAME]);
  });
});

describe('mergeWal: page sizes and headers that lie', () => {
  it('accepts the smallest (512) and the largest (65,536, stored as 1) page size', () => {
    expect(mergeWal(blankDb(512, 512, 2), undefined, 1e9).length).toBe(1024);
    expect(mergeWal(blankDb(1, 65_536), undefined, 1e9).length).toBe(65_536);
  });

  it('refuses a page size that is not a power of two between 512 and 65,536', () => {
    for (const field of [0, 256, 3000, 0xffff]) {
      expect(() => mergeWal(blankDb(field, 4096), undefined, 1e9), `field ${field}`).toThrow(
        expect.objectContaining({ code: 'internal' }),
      );
    }
  });

  it('refuses a header that says 4,096-byte pages for a file of 1,024-byte pages', () => {
    // The fixture is two 1,024-byte pages (2,048 bytes): not a whole 4,096-byte page.
    const lying = Buffer.from(plainDbFixture());
    expect(lying.length).toBe(2048);
    lying.writeUInt16BE(4096, 16);
    expect(() => mergeWal(lying, undefined, 1e9)).toThrow(
      expect.objectContaining({ code: 'busy' }),
    );
  });

  it('refuses a crafted commit frame that declares a huge database, before allocating it', () => {
    const db = blankDb(1024, 1024, 1);
    const wal = forgeWal(1024, [{ pgno: 1, commit: 0xffff_ffff }]);
    expect(() => mergeWal(db, wal, 50 * MB)).toThrow(
      expect.objectContaining({ code: 'too-large' }),
    );
  });

  it('applies a 65,536-byte-page WAL frame (page size 1 in the database header)', () => {
    const db = blankDb(1, 65_536, 1);
    const wal = forgeWal(65_536, [{ pgno: 2, commit: 2 }]);
    const out = mergeWal(db, wal, 50 * MB);
    expect(out.length).toBe(2 * 65_536);
    expect(out.readUInt32BE(28)).toBe(2);
  });

  it('ignores frames after the last commit, even many of them', () => {
    const db = blankDb(1024, 1024, 1);
    const frames = [{ pgno: 1, commit: 1 }];
    for (let i = 0; i < 200; i++) frames.push({ pgno: 2 + i, commit: 0 });
    const out = mergeWal(db, forgeWal(1024, frames), 50 * MB);
    expect(out.length).toBe(1024);
  });
});
