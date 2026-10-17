/**
 * SQLite file formats the snapshot backend reads (https://sqlite.org/fileformat2.html):
 * the database header, the WAL and the rollback journal's header. A copied database
 * is untrusted input: every number read here is bounds-checked before it sizes or
 * indexes anything (design review D4).
 */
import { DbError } from '@project-deck/core';

const MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const WAL_MAGIC_LE = 0x377f0682;
const WAL_MAGIC_BE = 0x377f0683;
const WAL_VERSION = 3007000;
const WAL_HEADER = 32;
const FRAME_HEADER = 24;
const JOURNAL_MAGIC = Buffer.from('d9d505f920a163d7', 'hex');

/** Refuses anything that isn't a SQLite database file (encrypted files have no magic). */
export function checkHeader(db: Uint8Array): void {
  if (db.length < 100 || !MAGIC.equals(db.subarray(0, 16))) {
    throw new DbError(
      'unsupported',
      "This file isn't a SQLite database, or it is encrypted, so FlutterDeck can't read it.",
    );
  }
}

/** The page size from the header (bytes 16–17; 1 means 65,536), or undefined. */
function pageSize(db: Uint8Array): number | undefined {
  if (db.length < 100) return undefined;
  const raw = Buffer.from(db.buffer, db.byteOffset, db.byteLength).readUInt16BE(16);
  const size = raw === 1 ? 65_536 : raw;
  return size >= 512 && (size & (size - 1)) === 0 ? size : undefined;
}

/** The header's file change counter (offset 24), or undefined for a short file. */
export function changeCounter(header: Uint8Array | undefined): number | undefined {
  if (header === undefined || header.length < 28) return undefined;
  return Buffer.from(header.buffer, header.byteOffset, header.byteLength).readUInt32BE(24);
}

/** The WAL's two salts as hex ('' without a WAL): they change when the WAL restarts. */
export function walSalts(wal: Uint8Array | undefined): string {
  if (wal === undefined || wal.length < WAL_HEADER) return '';
  return Buffer.from(wal.subarray(16, 24)).toString('hex');
}

/** A rollback journal that starts with its magic belongs to a write in progress. */
export function isHotJournal(head: Uint8Array | undefined): boolean {
  return head !== undefined && head.length >= 8 && JOURNAL_MAGIC.equals(head.subarray(0, 8));
}

/**
 * SQLite's WAL checksum over `data` (a multiple of 8 bytes), continuing from `prev`.
 * Words are read in the byte order the WAL magic names.
 */
export function walChecksum(
  data: Uint8Array,
  prev: [number, number],
  bigEndian: boolean,
): [number, number] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let [s0, s1] = prev;
  for (let i = 0; i + 8 <= data.length; i += 8) {
    s0 = (s0 + view.getUint32(i, !bigEndian) + s1) >>> 0;
    s1 = (s1 + view.getUint32(i + 4, !bigEndian) + s0) >>> 0;
  }
  return [s0, s1];
}

interface Frame {
  pgno: number;
  /** Database size in pages after this commit; 0 for frames inside a transaction. */
  commit: number;
  page: Uint8Array;
}

/** The WAL's valid frames, in order, up to the first one that fails a check. */
function validFrames(wal: Buffer, size: number): Frame[] {
  if (wal.length < WAL_HEADER) return [];
  const magic = wal.readUInt32BE(0);
  if (magic !== WAL_MAGIC_LE && magic !== WAL_MAGIC_BE) return [];
  if (wal.readUInt32BE(4) !== WAL_VERSION) return [];
  if (wal.readUInt32BE(8) !== size) {
    throw new DbError('busy', 'The app is writing; try Refresh.');
  }
  const bigEndian = magic === WAL_MAGIC_BE;
  let sum = walChecksum(wal.subarray(0, 24), [0, 0], bigEndian);
  if (sum[0] !== wal.readUInt32BE(24) || sum[1] !== wal.readUInt32BE(28)) return [];
  const salt1 = wal.readUInt32BE(16);
  const salt2 = wal.readUInt32BE(20);
  const frames: Frame[] = [];
  for (let at = WAL_HEADER; at + FRAME_HEADER + size <= wal.length; at += FRAME_HEADER + size) {
    if (wal.readUInt32BE(at + 8) !== salt1 || wal.readUInt32BE(at + 12) !== salt2) break;
    sum = walChecksum(wal.subarray(at, at + 8), sum, bigEndian);
    sum = walChecksum(wal.subarray(at + FRAME_HEADER, at + FRAME_HEADER + size), sum, bigEndian);
    if (sum[0] !== wal.readUInt32BE(at + 16) || sum[1] !== wal.readUInt32BE(at + 20)) break;
    frames.push({
      pgno: wal.readUInt32BE(at),
      commit: wal.readUInt32BE(at + 4),
      page: wal.subarray(at + FRAME_HEADER, at + FRAME_HEADER + size),
    });
  }
  return frames;
}

/**
 * The database as of the WAL's last valid commit, as one file image the engine can
 * open without a WAL (design review D4): only frames up to the last commit frame,
 * salts and checksums checked, no page beyond the size its own commit declares, and
 * the result within `maxBytes`. Without a WAL the main file is returned as it is.
 */
export function mergeWal(db: Uint8Array, wal: Uint8Array | undefined, maxBytes: number): Buffer {
  checkHeader(db);
  const size = pageSize(db);
  if (size === undefined) throw new DbError('internal', 'The database header is damaged.');
  if (db.length % size !== 0) throw new DbError('busy', 'The app is writing; try Refresh.');
  const frames = wal === undefined ? [] : validFrames(Buffer.from(wal), size);
  let last = -1;
  frames.forEach((f, i) => {
    if (f.commit > 0) last = i;
  });
  const committed = frames.slice(0, last + 1);
  const pages = last === -1 ? db.length / size : (committed[last]?.commit ?? 0);
  if (pages * size > maxBytes) {
    throw new DbError('too-large', 'The database is over 50 MB, too large to copy.');
  }
  const out = Buffer.alloc(pages * size);
  Buffer.from(db.buffer, db.byteOffset, Math.min(db.byteLength, out.length)).copy(out);
  // Each frame belongs to the transaction its next commit frame ends.
  let bound = 0;
  for (let i = committed.length - 1; i >= 0; i--) {
    const f = committed[i];
    if (f === undefined) continue;
    if (f.commit > 0) bound = f.commit;
    if (f.pgno < 1 || f.pgno > bound) {
      throw new DbError('internal', "The WAL file is damaged, so FlutterDeck can't read it.");
    }
  }
  for (const f of committed) {
    if (f.pgno <= pages) Buffer.from(f.page).copy(out, (f.pgno - 1) * size);
  }
  // The image is opened without its WAL: say so in the header, and make the size in
  // the header (offset 28) valid by matching its version-valid-for (92) to offset 24.
  out[18] = 1;
  out[19] = 1;
  out.writeUInt32BE(pages, 28);
  out.writeUInt32BE(out.readUInt32BE(24), 92);
  return out;
}
