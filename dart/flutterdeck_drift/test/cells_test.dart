import 'dart:convert';
import 'dart:typed_data';

import 'package:flutterdeck_drift/src/cells.dart';
import 'package:flutterdeck_drift/src/protocol.dart';
import 'package:test/test.dart';

void main() {
  group('encodeCell', () {
    test('keeps null, safe ints, finite doubles and text as they are', () {
      expect(encodeCell(null), isNull);
      expect(encodeCell(42), 42);
      expect(encodeCell(-9007199254740991), -9007199254740991);
      expect(encodeCell(1.5), 1.5);
      expect(encodeCell('héllo'), 'héllo');
    });

    test('tags ints outside the JSON-safe range as decimal text', () {
      expect(encodeCell(9007199254740992), {
        'type': 'int',
        'value': '9007199254740992',
      });
      expect(encodeCell(-9223372036854775808), {
        'type': 'int',
        'value': '-9223372036854775808',
      });
    });

    test('tags non-finite doubles, which JSON cannot hold', () {
      expect(encodeCell(double.infinity), {
        'type': 'real',
        'value': 'Infinity',
      });
      expect(encodeCell(double.negativeInfinity), {
        'type': 'real',
        'value': '-Infinity',
      });
    });

    test('sends blobs as size plus base64', () {
      expect(encodeCell(Uint8List.fromList([1, 2, 3])), {
        'type': 'blob',
        'bytes': 3,
        'base64': 'AQID',
      });
    });

    test('sends only the start of a large blob and says so', () {
      final big = Uint8List(blobPreviewBytes + 10);
      final cell = encodeCell(big)! as Map<String, Object?>;
      expect(cell['bytes'], blobPreviewBytes + 10);
      expect(cell['truncated'], isTrue);
      expect(
        base64Decode(cell['base64']! as String),
        hasLength(blobPreviewBytes),
      );
    });

    test('a key keeps the whole blob', () {
      final big = Uint8List(blobPreviewBytes + 10);
      final cell = encodeKeyCell(big)! as Map<String, Object?>;
      expect(cell.containsKey('truncated'), isFalse);
      expect(
        base64Decode(cell['base64']! as String),
        hasLength(blobPreviewBytes + 10),
      );
    });
  });

  group('decodeParams', () {
    test('null or empty text means no parameters', () {
      expect(decodeParams(null), isEmpty);
      expect(decodeParams(''), isEmpty);
    });

    test('decodes scalars, tagged ints and tagged blobs', () {
      expect(
        decodeParams(
          jsonEncode([
            null,
            1,
            2.5,
            'x',
            true,
            {'type': 'int', 'value': '9223372036854775807'},
            {'type': 'blob', 'base64': 'AQID'},
          ]),
        ),
        [
          null,
          1,
          2.5,
          'x',
          1,
          9223372036854775807,
          Uint8List.fromList([1, 2, 3]),
        ],
      );
    });

    for (final bad in [
      'not json',
      '{"a":1}',
      '[[1]]',
      '[{"type":"int","value":"1.5"}]',
      '[{"type":"int","value":"99999999999999999999"}]',
      '[{"type":"blob","base64":"!!"}]',
      '[{"type":"x"}]',
    ]) {
      test('refuses $bad', () {
        expect(
          () => decodeParams(bad),
          throwsA(
            isA<DriftDeckError>().having(
              (e) => e.code,
              'code',
              ErrorCode.badRequest,
            ),
          ),
        );
      });
    }

    test('decodes tagged non-finite reals, as encodeCell sends them', () {
      final back = decodeParams(
        jsonEncode([
          encodeCell(double.infinity),
          encodeCell(double.negativeInfinity),
          {'type': 'real', 'value': 'NaN'},
        ]),
      );
      expect(back[0], double.infinity);
      expect(back[1], double.negativeInfinity);
      expect((back[2]! as double).isNaN, isTrue);
      for (final bad in ['inf', '1.5', '', 'infinity']) {
        expect(
          () => decodeParam({'type': 'real', 'value': bad}),
          throwsA(isA<DriftDeckError>()),
          reason: bad,
        );
      }
    });

    test('refuses more than 999 parameters', () {
      expect(
        () => decodeParams(jsonEncode(List.filled(1000, 1))),
        throwsA(isA<DriftDeckError>()),
      );
    });
  });

  group('cellHash', () {
    test('is 16 hex digits and stable', () {
      expect(cellHash('abc'), matches(RegExp(r'^[0-9a-f]{16}$')));
      expect(cellHash('abc'), cellHash('abc'));
    });

    test('differs by SQLite type even when the text looks the same', () {
      final values = <Object?>[
        null,
        1,
        1.0,
        '1',
        Uint8List.fromList([0x31]),
        '',
        Uint8List(0),
        0,
      ];
      final hashes = values.map(cellHash).toSet();
      expect(hashes, hasLength(values.length));
    });

    test('differs for different values', () {
      expect(cellHash('pending'), isNot(cellHash('shipped')));
      expect(cellHash(1), isNot(cellHash(2)));
    });
  });

  group('jsonSize', () {
    test('counts UTF-8 bytes', () {
      expect(jsonSize(['é']), utf8.encode(jsonEncode(['é'])).length);
      expect(jsonSize(['😀']), utf8.encode(jsonEncode(['😀'])).length);
    });
  });
}
