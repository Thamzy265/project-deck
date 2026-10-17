/// Wires the service to `dart:developer`, in debug builds only.
library;

import 'dart:convert';
import 'dart:developer' as developer;

import 'package:drift/drift.dart';

import 'protocol.dart';
import 'service.dart';

/// True in debug builds, false in profile and release, defined exactly like
/// Flutter's `kDebugMode` so this package needs no Flutter dependency.
const bool debugBuild =
    !bool.fromEnvironment('dart.vm.product') &&
    !bool.fromEnvironment('dart.vm.profile');

/// Registers one service extension.
typedef ExtensionRegistrar =
    void Function(
      String method,
      Future<Map<String, Object?>> Function(Map<String, String> params) handler,
    );

/// The extensions, in the order they are registered.
const extensionNames = [
  'list',
  'schema',
  'query',
  'snapshot',
  'rows',
  'execute',
];

void _developerRegistrar(
  String method,
  Future<Map<String, Object?>> Function(Map<String, String> params) handler,
) {
  developer.registerExtension(method, (_, params) async {
    return developer.ServiceExtensionResponse.result(
      jsonEncode(await handler(params)),
    );
  });
}

void _developerPoster(String kind, Map<String, Object?> data) =>
    developer.postEvent(kind, data);

DriftDeckService? _service;

/// The service, once something registered. For tests.
DriftDeckService? get currentService => _service;

/// Forgets the service so a test can register again. For tests.
Future<void> resetForTesting() async {
  await _service?.dispose();
  _service = null;
}

/// Does what `FlutterDeckDrift.register` does, with the build mode and the
/// `dart:developer` calls injectable for tests.
void registerWith(
  GeneratedDatabase db, {
  required String name,
  required bool enabled,
  ExtensionRegistrar registrar = _developerRegistrar,
  EventPoster poster = _developerPoster,
}) {
  if (!enabled) return;
  if (!isValidDbName(name)) {
    throw ArgumentError.value(
      name,
      'name',
      'Use 1 to 64 letters, digits, _, . or -',
    );
  }
  var service = _service;
  if (service == null) {
    service = DriftDeckService(post: poster);
    _service = service;
    // Extensions go first: the daemon drops events from an isolate that has
    // not announced them yet (DDS replays old events on connect).
    for (final action in extensionNames) {
      final method = '$extensionPrefix$action';
      registrar(method, (params) => service!.handle(method, params));
    }
  }
  service.add(db, name);
}
