/// Wire protocol shared with FlutterDeck's daemon (design note M3, D5 and D6).
library;

/// Sent in every reply and event. The daemon refuses other versions.
const protocolVersion = 1;

/// Prefix of every service extension this package registers.
const extensionPrefix = 'ext.flutterdeck.drift.v1.';

/// Kind of the event posted when tables change.
const tablesEventKind = 'flutterdeck.drift.tables';

/// A read stops after this long (design note S2).
const readBudget = Duration(seconds: 5);

/// After an interrupt, how long the read isolate gets to answer.
const interruptGrace = Duration(seconds: 1);

/// Rows a query returns when the caller gives no limit.
const defaultRowLimit = 1000;

/// Most rows any reply holds.
const maxRowLimit = 5000;

/// Most bytes of JSON any reply holds.
const maxReplyBytes = 8 * 1024 * 1024;

/// Most rows per table in a diff snapshot (D6).
const maxSnapshotRowsPerTable = 10000;

/// Most keys one `rows` call may ask for.
const maxKeysPerCall = 1000;

/// Longest SQL text accepted.
const maxSqlLength = 100000;

/// Largest single value SQLite may build on the read connection.
const readLengthLimit = 16 * 1024 * 1024;

/// Bytes of a blob sent as base64; the size is always sent.
const blobPreviewBytes = 64 * 1024;

/// Error codes in `{protocol, error: {code, message}}` replies.
abstract final class ErrorCode {
  static const badRequest = 'bad-request';
  static const unknownDb = 'unknown-db';
  static const notReadOnly = 'not-read-only';
  static const notAllowed = 'not-allowed';
  static const timeout = 'timeout';
  static const busy = 'busy';
  static const tooLarge = 'too-large';
  static const unsupported = 'unsupported';
  static const badToken = 'bad-token';
  static const sqlError = 'sql-error';
  static const notFound = 'not-found';
  static const internal = 'internal';
}

/// A refusal or failure that goes back to the daemon as an error reply.
final class DriftDeckError implements Exception {
  const DriftDeckError(this.code, this.message);

  final String code;
  final String message;

  Map<String, Object?> toJson() => {'code': code, 'message': message};

  @override
  String toString() => 'DriftDeckError($code): $message';
}

/// A read changed or broke its connection; the read isolate starts over
/// with fresh connections, and the controller runs the read once more.
const connectionReset = DriftDeckError(
  ErrorCode.internal,
  'The read connection was reset',
);

Map<String, Object?> okReply(Map<String, Object?> body) => {
  'protocol': protocolVersion,
  ...body,
};

Map<String, Object?> errorReply(DriftDeckError error) => {
  'protocol': protocolVersion,
  'error': error.toJson(),
};
