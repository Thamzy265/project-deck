// Run by build_mode_test.dart with different -D flags. Prints "registered"
// when FlutterDeckDrift.register registered its extensions, else "none".
import 'dart:developer' as developer;

import 'package:drift/native.dart';
import 'package:flutterdeck_drift/flutterdeck_drift.dart';

import '../support.dart';

Future<void> main() async {
  final db = AppDb(NativeDatabase.memory());
  FlutterDeckDrift.register(db, name: 'probe');
  var registered = false;
  try {
    // Registering a name twice throws, so this tells whether it exists.
    developer.registerExtension(
      'ext.flutterdeck.drift.v1.list',
      (_, _) async => developer.ServiceExtensionResponse.result('{}'),
    );
  } on ArgumentError {
    registered = true;
  }
  print(registered ? 'registered' : 'none');
  await db.close();
}
