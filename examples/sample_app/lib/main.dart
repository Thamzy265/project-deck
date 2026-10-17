import 'dart:developer' as developer;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutterdeck_drift/flutterdeck_drift.dart';

import 'database.dart';

/// Edit this text, save, and hot reload to see the screen change.
const reloadMarker = 'Edit me, then hot reload: v1';

/// Sends a line to Android logcat with a non-`flutter` tag (see MainActivity.kt).
const sampleChannel = MethodChannel('flutterdeck/sample');

final taps = ValueNotifier<int>(0);

Future<void> onHitBreakpoint() async {
  taps.value += 1; // FLUTTERDECK: put the breakpoint on this line
  final message = 'Tap ${taps.value}';

  // ignore: avoid_print
  print('flutterdeck.sample print: $message');
  developer.log(message, name: 'flutterdeck.sample', level: 800);

  try {
    await sampleChannel.invokeMethod<void>('log', message);
  } on MissingPluginException {
    // Only Android registers the channel. iOS and tests skip the native log.
  } on PlatformException {
    // The native log is best-effort; the counter has already advanced.
  }
}

void main() {
  final db = AppDatabase();
  // Lets FlutterDeck show the database live. Does nothing in release builds.
  FlutterDeckDrift.register(db, name: 'sample');
  runApp(SampleApp(database: db));
}

class SampleApp extends StatelessWidget {
  const SampleApp({super.key, this.database});

  /// The orders database; the orders section is hidden without one.
  final AppDatabase? database;

  @override
  Widget build(BuildContext context) {
    final db = database;
    return MaterialApp(
      title: 'FlutterDeck sample',
      theme: ThemeData(colorSchemeSeed: Colors.indigo),
      home: Scaffold(
        appBar: AppBar(title: const Text('FlutterDeck sample')),
        // Slivers, so a long orders list builds only the rows on screen.
        body: CustomScrollView(
          slivers: [
            SliverPadding(
              padding: const EdgeInsets.all(24),
              sliver: SliverList.list(
                children: [
                  Text(
                    reloadMarker,
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.headlineMedium,
                  ),
                  const SizedBox(height: 32),
                  ValueListenableBuilder<int>(
                    valueListenable: taps,
                    builder: (context, count, _) => Text(
                      'Taps: $count',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                  ),
                  const SizedBox(height: 32),
                  Center(
                    child: Semantics(
                      identifier: 'hit-breakpoint',
                      child: FilledButton(
                        style: FilledButton.styleFrom(
                          minimumSize: const Size(240, 72),
                          textStyle: const TextStyle(fontSize: 22),
                        ),
                        onPressed: onHitBreakpoint,
                        child: const Text('Hit breakpoint'),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            if (db != null) OrdersSection(database: db),
          ],
        ),
      ),
    );
  }
}

/// An "Add order" button and the orders, newest first. Tapping an order's
/// status moves it to the next one.
class OrdersSection extends StatefulWidget {
  const OrdersSection({super.key, required this.database});

  final AppDatabase database;

  @override
  State<OrdersSection> createState() => _OrdersSectionState();
}

class _OrdersSectionState extends State<OrdersSection> {
  // Held here so a rebuild keeps one query instead of starting another.
  late Stream<List<Order>> _orders = widget.database.watchOrders();

  @override
  void didUpdateWidget(OrdersSection old) {
    super.didUpdateWidget(old);
    if (!identical(old.database, widget.database)) {
      _orders = widget.database.watchOrders();
    }
  }

  @override
  Widget build(BuildContext context) {
    final database = widget.database;
    return SliverMainAxisGroup(
      slivers: [
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Center(
              child: Semantics(
                identifier: 'add-order',
                child: OutlinedButton(
                  style: OutlinedButton.styleFrom(
                    minimumSize: const Size(240, 56),
                  ),
                  onPressed: database.addOrder,
                  child: const Text('Add order'),
                ),
              ),
            ),
          ),
        ),
        StreamBuilder<List<Order>>(
          stream: _orders,
          builder: (context, snapshot) {
            final orders = snapshot.data ?? const <Order>[];
            return SliverList.builder(
              itemCount: orders.length,
              itemBuilder: (context, i) {
                final order = orders[i];
                return ListTile(
                  title: Text(order.item),
                  subtitle: Text('Order ${order.id}'),
                  trailing: Semantics(
                    identifier: 'order-status-${order.id}',
                    child: TextButton(
                      onPressed: () => database.nextStatus(order),
                      child: Text(
                        order.status,
                        semanticsLabel:
                            'Order ${order.id} status: ${order.status}',
                      ),
                    ),
                  ),
                );
              },
            );
          },
        ),
      ],
    );
  }
}
