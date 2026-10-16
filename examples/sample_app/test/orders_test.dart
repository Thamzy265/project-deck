import 'dart:io';

import 'package:drift/drift.dart' show driftRuntimeOptions;
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flutterdeck_sample/database.dart';
import 'package:flutterdeck_sample/main.dart';

void main() {
  setUpAll(() => driftRuntimeOptions.dontWarnAboutMultipleDatabases = true);

  group('AppDatabase', () {
    late AppDatabase db;

    setUp(() => db = AppDatabase(NativeDatabase.memory()));
    tearDown(() => db.close());

    test('adds pending orders, cycling the sample items', () async {
      for (var i = 0; i < 6; i++) {
        await db.addOrder();
      }
      final orders = await db.watchOrders().first;
      expect(orders.map((o) => o.item), [
        'Coffee',
        'Juice',
        'Bagel',
        'Cake',
        'Tea',
        'Coffee',
      ]);
      expect(orders.map((o) => o.status).toSet(), {'pending'});
      expect(orders.first.createdAt, isA<DateTime>());
    });

    test('nextStatus cycles pending, shipped, cancelled', () async {
      await db.addOrder();
      final seen = <String>[];
      for (var i = 0; i < 4; i++) {
        final order = (await db.watchOrders().first).single;
        seen.add(order.status);
        await db.nextStatus(order);
      }
      expect(seen, ['pending', 'shipped', 'cancelled', 'pending']);
    });

    test('the table refuses an unknown status', () async {
      await db.addOrder();
      await expectLater(
        db.customStatement("UPDATE orders SET status = 'lost'"),
        throwsA(anything),
      );
    });
  });

  group('screen', () {
    testWidgets('without a database the orders section is hidden', (
      tester,
    ) async {
      await tester.pumpWidget(const SampleApp());
      expect(find.text('Add order'), findsNothing);
      expect(find.text('Hit breakpoint'), findsOneWidget);
    });

    testWidgets('Add order shows a new pending row; a tap moves its status', (
      tester,
    ) async {
      final db = AppDatabase(NativeDatabase.memory());
      await tester.pumpWidget(SampleApp(database: db));

      await tester.runAsync(() async {
        await tester.tap(find.text('Add order'));
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await tester.pumpAndSettle();
      expect(find.text('Coffee'), findsOneWidget);
      expect(find.bySemanticsIdentifier('order-status-1'), findsOneWidget);
      expect(find.text('pending'), findsOneWidget);

      await tester.runAsync(() async {
        await tester.tap(find.text('pending'));
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await tester.pumpAndSettle();
      expect(find.text('shipped'), findsOneWidget);

      // Close inside runAsync so drift's stream timers finish.
      await tester.runAsync(db.close);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a rebuild keeps the one orders stream', (tester) async {
      final db = _CountingDatabase();
      await tester.pumpWidget(SampleApp(database: db));
      await tester.pumpWidget(SampleApp(database: db));
      await tester.pump();
      expect(db.watches, 1);
      await tester.runAsync(db.close);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the add button keeps its test hook', (tester) async {
      final db = AppDatabase(NativeDatabase.memory());
      await tester.pumpWidget(SampleApp(database: db));
      expect(find.bySemanticsIdentifier('add-order'), findsOneWidget);
      await tester.runAsync(db.close);
      await tester.pumpWidget(const SizedBox());
    });
  });

  test('main registers the database with FlutterDeck as "sample"', () {
    final dart = File('lib/main.dart').readAsStringSync();
    expect(dart, contains("FlutterDeckDrift.register(db, name: 'sample');"));
    final database = File('lib/database.dart').readAsStringSync();
    expect(database, contains("driftDatabase(name: 'sample')"));
  });
}

/// Counts how often the screen asks for the orders stream.
class _CountingDatabase extends AppDatabase {
  _CountingDatabase() : super(NativeDatabase.memory());

  int watches = 0;

  @override
  Stream<List<Order>> watchOrders() {
    watches++;
    return super.watchOrders();
  }
}
