/// Typed cell values for JSON, query parameters, and per-cell hashes.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'protocol.dart';

const _maxSafeInt = 9007199254740991;

/// A SQLite value as JSON the daemon can read without losing type or digits.
///
/// Ints outside JavaScript's safe range and non-finite doubles are tagged.
/// Blobs send their size and at most [blobPreviewBytes] as base64.
Object? encodeCell(Object? value) => _encode(value, wholeBlob: false);

/// Like [encodeCell], but blobs are sent whole, because a key must match
/// exactly when it comes back in a `rows` call.
Object? encodeKeyCell(Object? value) => _encode(value, wholeBlob: true);

Object? _encode(Object? value, {required bool wholeBlob}) {
  switch (value) {
    case null:
      return null;
    case int v:
      if (v > _maxSafeInt || v < -_maxSafeInt) {
        return {'type': 'int', 'value': v.toString()};
      }
      return v;
    case double v:
      if (v.isFinite) return v;
      return {'type': 'real', 'value': v.toString()};
    case String v:
      return v;
    case List<int> v:
      final cut = !wholeBlob && v.length > blobPreviewBytes;
      return {
        'type': 'blob',
        'bytes': v.length,
        'base64': base64Encode(cut ? v.sublist(0, blobPreviewBytes) : v),
        if (cut) 'truncated': true,
      };
    default:
      return value.toString();
  }
}

final _intText = RegExp(r'^-?\d{1,19}$');

/// Decodes a JSON array of parameters. Accepts null, numbers, text, booleans
/// (as 0 or 1), `{type: 'int', value}` and `{type: 'blob', base64}`.
List<Object?> decodeParams(String? json) => [
  for (final p in decodeParamsRaw(json)) decodeParam(p),
];

/// Parses a JSON array of at most 999 entries without decoding them.
List<Object?> decodeParamsRaw(String? json) {
  if (json == null || json.isEmpty) return const [];
  final Object? decoded;
  try {
    decoded = jsonDecode(json);
  } on FormatException {
    throw const DriftDeckError(ErrorCode.badRequest, 'Not JSON');
  }
  if (decoded is! List) {
    throw const DriftDeckError(ErrorCode.badRequest, 'Expected a JSON list');
  }
  if (decoded.length > 999) {
    throw const DriftDeckError(ErrorCode.badRequest, 'Too many values');
  }
  return decoded;
}

/// Decodes one parameter or key value; see [decodeParams].
Object? decodeParam(Object? p) {
  switch (p) {
    case null || num() || String():
      return p;
    case bool b:
      return b ? 1 : 0;
    case {'type': 'int', 'value': String text}:
      final v = _intText.hasMatch(text) ? int.tryParse(text) : null;
      if (v == null) {
        throw const DriftDeckError(ErrorCode.badRequest, 'bad int param');
      }
      return v;
    case {'type': 'blob', 'base64': String text}:
      try {
        return base64Decode(text);
      } on FormatException {
        throw const DriftDeckError(ErrorCode.badRequest, 'bad blob param');
      }
    default:
      throw const DriftDeckError(ErrorCode.badRequest, 'bad param');
  }
}

// FNV-1a, 64 bit. Native ints wrap at 64 bits, which is what FNV needs.
const _fnvOffset = 0xcbf29ce484222325;
const _fnvPrime = 0x100000001b3;

/// A 64-bit hash of a value together with its SQLite type, as 16 hex digits,
/// so `1`, `1.0`, `'1'` and `x'31'` all differ.
String cellHash(Object? value) {
  var h = _fnvOffset;
  void add(int byte) {
    h ^= byte & 0xff;
    h *= _fnvPrime;
  }

  void addBytes(List<int> bytes) {
    for (final b in bytes) {
      add(b);
    }
  }

  switch (value) {
    case null:
      add(5);
    case int v:
      add(1);
      addBytes((ByteData(8)..setInt64(0, v)).buffer.asUint8List());
    case double v:
      add(2);
      addBytes((ByteData(8)..setFloat64(0, v)).buffer.asUint8List());
    case String v:
      add(3);
      addBytes(utf8.encode(v));
    case List<int> v:
      add(4);
      addBytes(v);
    default:
      add(6);
      addBytes(utf8.encode(value.toString()));
  }
  String half(int x) => (x & 0xffffffff).toRadixString(16).padLeft(8, '0');
  return half(h >> 32) + half(h);
}

/// Bytes of [value] as UTF-8 JSON.
int jsonSize(Object? value) {
  final text = jsonEncode(value);
  var bytes = 0;
  for (var i = 0; i < text.length; i++) {
    final c = text.codeUnitAt(i);
    if (c < 0x80) {
      bytes += 1;
    } else if (c < 0x800) {
      bytes += 2;
    } else if (c >= 0xd800 && c <= 0xdfff) {
      // Each half of a surrogate pair counts 2 of the pair's 4 bytes.
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
