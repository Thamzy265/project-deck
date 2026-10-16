// Records a real flutterdeck_drift session over the VM service, as JSON-RPC
// fixtures for the TypeScript side (db-drift, connector-dart).
//
//   cd dart/flutterdeck_drift
//   dart run --enable-vm-service=0 tool/record_fixtures.dart <out.json>
//
// The app here is this process: it opens a throwaway database with sample
// orders, registers it, then calls its own extensions through the VM service
// (via DDS, as the daemon does). Write tokens are masked; no paths or VM
// service URIs are recorded.
import 'dart:async';
import 'dart:convert';
import 'dart:developer' as developer;
import 'dart:io';

import 'package:flutterdeck_drift/flutterdeck_drift.dart';

import '../test/support.dart';

const _masked = '<masked>';

Future<void> main(List<String> args) async {
  if (args.length != 1) {
    stderr.writeln(
      'usage: dart run --enable-vm-service=0 '
      'tool/record_fixtures.dart <out.json>',
    );
    exit(64);
  }
  final info = await developer.Service.getInfo();
  final uri = info.serverWebSocketUri;
  if (uri == null) {
    stderr.writeln('Run with --enable-vm-service=0');
    exit(64);
  }

  final dir = Directory.systemTemp.createTempSync('flutterdeck_drift_rec');
  final db = openAppDb('${dir.path}/app.sqlite');
  await db.addOrder('Coffee');
  await db.addOrder('Tea');
  FlutterDeckDrift.register(db, name: 'app');

  final socket = await WebSocket.connect(uri.toString());
  final pending = <String, Completer<Map<String, Object?>>>{};
  final events = StreamController<Map<String, Object?>>.broadcast();
  final exchanges = <Map<String, Object?>>[];
  var nextId = 0;

  socket.listen((Object? frame) {
    final m = (jsonDecode(frame! as String) as Map).cast<String, Object?>();
    final id = m['id'];
    if (id is String && pending.containsKey(id)) {
      pending.remove(id)!.complete(m);
    } else if (m['method'] == 'streamNotify') {
      events.add(m);
    }
  });

  Future<Map<String, Object?>> rpc(String method, Map<String, Object?> params) {
    final id = '${nextId++}';
    final c = Completer<Map<String, Object?>>();
    pending[id] = c;
    socket.add(
      jsonEncode({
        'jsonrpc': '2.0',
        'id': id,
        'method': method,
        'params': params,
      }),
    );
    return c.future;
  }

  final vm = await rpc('getVM', const {});
  final isolates = ((vm['result']! as Map)['isolates']! as List)
      .cast<Map<String, Object?>>();
  final isolateId = isolates.first['id']! as String;
  await rpc('streamListen', {'streamId': 'Extension'});

  final isolate = await rpc('getIsolate', {'isolateId': isolateId});
  final announced = [
    for (final m
        in ((isolate['result']! as Map)['extensionRPCs'] as List? ?? const []))
      if ('$m'.startsWith('ext.flutterdeck.')) m,
  ];

  Future<void> call(
    String label,
    String method,
    Map<String, String> params, {
    Map<String, String> masked = const {},
  }) async {
    final request = {'isolateId': isolateId, ...params};
    final response = await rpc(method, request);
    exchanges.add({
      'label': label,
      'request': {
        'jsonrpc': '2.0',
        'method': method,
        'params': {...request, ...masked},
      },
      'response': {...response, 'id': '<id>'},
    });
  }

  const v1 = 'ext.flutterdeck.drift.v1.';
  await call('list', '${v1}list', const {});
  await call('schema', '${v1}schema', const {'db': 'app'});
  await call('query', '${v1}query', const {
    'db': 'app',
    'sql': "SELECT id, item, status FROM orders WHERE status = ?",
    'params': '["pending"]',
    'limit': '100',
  });
  await call('query refused (write)', '${v1}query', const {
    'db': 'app',
    'sql': 'DELETE FROM orders RETURNING *',
  });
  await call('query refused (ATTACH)', '${v1}query', const {
    'db': 'app',
    'sql': "ATTACH 'other.db' AS x",
  });
  await call('query unknown db', '${v1}query', const {
    'db': 'nope',
    'sql': 'SELECT 1',
  });
  await call('snapshot', '${v1}snapshot', const {'db': 'app'});

  final event = events.stream.first;
  await db.addOrder('Cake');
  final tablesEvent = await event.timeout(const Duration(seconds: 5));

  await call('rows', '${v1}rows', const {
    'db': 'app',
    'table': 'orders',
    'keys': '[3, 99]',
  });
  await call('execute without token', '${v1}execute', const {
    'db': 'app',
    'sql': "UPDATE orders SET status = 'shipped' WHERE id = 1",
  });
  await call(
    'execute with token',
    '${v1}execute',
    {
      'db': 'app',
      'sql': 'UPDATE orders SET status = ? WHERE id = ?',
      'params': '["shipped", 1]',
      'token': freshToken(),
    },
    masked: const {'token': _masked},
  );
  await call('query timeout', '${v1}query', const {
    'db': 'app',
    'sql':
        'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) '
        'SELECT count(*) FROM c, orders',
  });
  await call('unknown method', '${v1}nope', const {});

  final eventParams = (tablesEvent['params']! as Map)['event']! as Map;
  final out = {
    '_source':
        'Recorded with dart/flutterdeck_drift/tool/record_fixtures.dart: a '
        'Dart VM (dart run --enable-vm-service, DDS on) registers a Drift '
        'database with FlutterDeckDrift.register and calls its own '
        'ext.flutterdeck.drift.v1.* extensions over the VM service WebSocket. '
        'Write tokens are masked; request ids are replaced. Sample rows only.',
    'environment': {
      'dart': Platform.version.split(' ').first,
      'os': Platform.operatingSystem,
      'recordedAt': DateTime.now().toUtc().toIso8601String().substring(0, 10),
    },
    'announcedExtensions': announced,
    'tablesEvent': {
      'kind': eventParams['kind'],
      'extensionKind': eventParams['extensionKind'],
      'extensionData': eventParams['extensionData'],
    },
    'exchanges': exchanges,
  };
  File(
    args.single,
  ).writeAsStringSync('${const JsonEncoder.withIndent('  ').convert(out)}\n');

  await socket.close();
  await db.close();
  dir.deleteSync(recursive: true);
  exit(0);
}
