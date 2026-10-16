/// SQLite C functions package:sqlite3 does not wrap (or wraps only as an
/// async stream), looked up in the same native library it bundles (its code
/// asset).
library;

import 'dart:ffi';

import 'package:ffi/ffi.dart';

const _asset = 'package:sqlite3/src/ffi/libsqlite3.g.dart';

@Native<Void Function(Pointer<Void>)>(
  symbol: 'sqlite3_interrupt',
  assetId: _asset,
)
external void _sqlite3Interrupt(Pointer<Void> db);

@Native<Int Function(Pointer<Void>, Int, Int)>(
  symbol: 'sqlite3_limit',
  assetId: _asset,
)
external int _sqlite3Limit(Pointer<Void> db, int id, int value);

const _limitLength = 0; // SQLITE_LIMIT_LENGTH

/// Whether the bundled SQLite library exports `sqlite3_interrupt`. It does
/// unless package:sqlite3 compiled SQLite from source on Linux, where its
/// linker script hides symbols it doesn't use itself.
bool interruptAvailable() {
  try {
    Native.addressOf<NativeFunction<Void Function(Pointer<Void>)>>(
      _sqlite3Interrupt,
    );
    return true;
  } on ArgumentError {
    return false;
  }
}

/// Asks SQLite to stop whatever runs on the connection at [address].
///
/// `sqlite3_interrupt` is safe to call from another thread while a statement
/// runs (https://sqlite.org/c3ref/interrupt.html), so the controlling isolate
/// can call it while the read isolate is blocked in a step. Returns false
/// when the symbol is missing from the bundled library.
bool interruptConnection(int address) {
  try {
    _sqlite3Interrupt(Pointer<Void>.fromAddress(address));
    return true;
  } on ArgumentError {
    return false;
  }
}

/// Caps the size of any string or blob SQLite builds on [db]. Returns false
/// when the symbol is missing.
bool limitLength(Pointer<void> db, int bytes) {
  try {
    _sqlite3Limit(db.cast(), _limitLength, bytes);
    return true;
  } on ArgumentError {
    return false;
  }
}

@Native<
  Pointer<Void> Function(
    Pointer<Void>,
    Pointer<Utf8>,
    Pointer<Void>,
    Pointer<Utf8>,
  )
>(symbol: 'sqlite3_backup_init', assetId: _asset)
external Pointer<Void> _backupInit(
  Pointer<Void> dest,
  Pointer<Utf8> destName,
  Pointer<Void> source,
  Pointer<Utf8> sourceName,
);

@Native<Int Function(Pointer<Void>, Int)>(
  symbol: 'sqlite3_backup_step',
  assetId: _asset,
)
external int _backupStep(Pointer<Void> backup, int pages);

@Native<Int Function(Pointer<Void>)>(
  symbol: 'sqlite3_backup_finish',
  assetId: _asset,
)
external int _backupFinish(Pointer<Void> backup);

@Native<Int Function(Pointer<Void>)>(
  symbol: 'sqlite3_backup_pagecount',
  assetId: _asset,
)
external int _backupPageCount(Pointer<Void> backup);

/// "main", the schema name of both ends of a copy. Allocated once and kept.
final Pointer<Utf8> _main = 'main'.toNativeUtf8();

/// One in-progress copy of a database's main schema into another
/// connection's main schema, run in steps (https://sqlite.org/backup.html).
final class NativeBackup {
  NativeBackup._(this._handle);

  /// Starts a copy, or returns null if SQLite refused to start one.
  static NativeBackup? start(Pointer<void> dest, Pointer<void> source) {
    final handle = _backupInit(dest.cast(), _main, source.cast(), _main);
    return handle.address == 0 ? null : NativeBackup._(handle);
  }

  final Pointer<Void> _handle;

  /// Copies up to [pages] pages. Holds a shared lock on the source only
  /// while it runs. Returns SQLite's result code (SQLITE_DONE when finished).
  int step(int pages) => _backupStep(_handle, pages);

  /// Pages in the source database as of the last step.
  int get pageCount => _backupPageCount(_handle);

  /// Ends the copy and frees it; returns SQLite's result code.
  int finish() => _backupFinish(_handle);
}
