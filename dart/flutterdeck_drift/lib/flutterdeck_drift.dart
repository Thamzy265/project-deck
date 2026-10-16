/// Lets FlutterDeck inspect a Drift database in a debug build of your app.
library;

import 'package:drift/drift.dart';

import 'src/register.dart';

/// Entry point of the package.
abstract final class FlutterDeckDrift {
  /// Makes [db] visible to FlutterDeck as [name].
  ///
  /// Call it once after you create the database, for example in `main()`:
  /// `FlutterDeckDrift.register(db, name: 'app');`
  ///
  /// It returns at once. In profile and release builds it does nothing at
  /// all. In debug builds it registers the `ext.flutterdeck.drift.v1.*`
  /// service extensions and posts an event when tables change. Reads use a
  /// separate read-only connection in a background isolate; FlutterDeck
  /// changes data only after you confirm an edit in its dashboard.
  ///
  /// Calling it again with the same database and name does nothing. Several
  /// databases can be registered under different names. [name] may hold
  /// letters, digits, `_`, `.` and `-` (at most 64).
  static void register(GeneratedDatabase db, {required String name}) {
    // A constant check, so profile and release builds drop the rest.
    if (!debugBuild) return;
    registerWith(db, name: name, enabled: true);
  }
}
