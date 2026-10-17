import 'dart:io';

import 'package:drift/drift.dart' show driftRuntimeOptions;
import 'package:flutterdeck_drift/src/protocol.dart';
import 'package:flutterdeck_drift/src/register.dart';
import 'package:test/test.dart';

import 'support.dart';

void main() {
  setUpAll(() => driftRuntimeOptions.dontWarnAboutMultipleDatabases = true);

  late Directory dir;
  late AppDb app;
  late List<String> calls;
  late Map<String, Future<Map<String, Object?>> Function(Map<String, String>)>
  handlers;

  void registrar(
    String method,
    Future<Map<String, Object?>> Function(Map<String, String>) handler,
  ) {
    calls.add('register $method');
    handlers[method] = handler;
  }

  void poster(String kind, Map<String, Object?> data) =>
      calls.add('event $kind');

  setUp(() async {
    dir = Directory.systemTemp.createTempSync('flutterdeck_drift_register');
    app = openAppDb('${dir.path}/app.sqlite');
    calls = [];
    handlers = {};
  });

  tearDown(() async {
    await resetForTesting();
    await app.close();
    dir.deleteSync(recursive: true);
  });

  test('the build-mode flag is on in this (debug) test run', () {
    expect(debugBuild, isTrue);
  });

  test('nothing registers when not a debug build', () async {
    registerWith(
      app,
      name: 'app',
      enabled: false,
      registrar: registrar,
      poster: poster,
    );
    await app.addOrder('Tea');
    await Future<void>.delayed(const Duration(milliseconds: 250));
    expect(calls, isEmpty);
    expect(currentService, isNull);
  });

  test('registers every extension once, before any event', () async {
    registerWith(
      app,
      name: 'app',
      enabled: true,
      registrar: registrar,
      poster: poster,
    );
    final other = openAppDb('${dir.path}/other.sqlite');
    addTearDown(other.close);
    registerWith(
      other,
      name: 'other',
      enabled: true,
      registrar: registrar,
      poster: poster,
    );
    await app.addOrder('Tea');
    await Future<void>.delayed(const Duration(milliseconds: 250));

    expect(calls, [
      for (final n in extensionNames) 'register $extensionPrefix$n',
      'event $tablesEventKind',
    ]);
    final list = await handlers['${extensionPrefix}list']!(const {});
    expect(list['databases'], [
      {'name': 'app'},
      {'name': 'other'},
    ]);
  });

  test('the same database and name again is a no-op', () async {
    for (var i = 0; i < 3; i++) {
      registerWith(
        app,
        name: 'app',
        enabled: true,
        registrar: registrar,
        poster: poster,
      );
    }
    await app.addOrder('Tea');
    await Future<void>.delayed(const Duration(milliseconds: 250));
    expect(calls.where((c) => c.startsWith('register')), hasLength(6));
    expect(calls.where((c) => c.startsWith('event')), hasLength(1));
  });

  for (final name in ['', ' app', 'a/b', 'a' * 65, '../x', 'ü']) {
    test('refuses the name "$name"', () {
      expect(
        () => registerWith(
          app,
          name: name,
          enabled: true,
          registrar: registrar,
          poster: poster,
        ),
        throwsArgumentError,
      );
      expect(calls, isEmpty);
    });
  }
}
