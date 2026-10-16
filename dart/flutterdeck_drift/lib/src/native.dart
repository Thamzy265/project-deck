/// Two SQLite C functions package:sqlite3 does not wrap, looked up in the
/// same native library it bundles (its code asset).
library;

import 'dart:ffi';

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
