import 'package:drift/drift.dart';
import 'package:drift_flutter/drift_flutter.dart';

part 'database.g.dart';

/// The statuses an order moves through, in the order a tap cycles them.
const orderStatuses = ['pending', 'shipped', 'cancelled'];

/// Items the "Add order" button picks from, in turn.
const sampleItems = ['Coffee', 'Tea', 'Cake', 'Bagel', 'Juice'];

class Orders extends Table {
  IntColumn get id => integer().autoIncrement()();
  TextColumn get item => text()();
  TextColumn get status => text()
      .withDefault(const Constant('pending'))
      // drift_dev reads this getter at build time; the check names the
      // column itself, which the lint takes for recursion.
      // ignore: recursive_getters
      .check(status.isIn(orderStatuses))();
  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();
}

@DriftDatabase(tables: [Orders])
class AppDatabase extends _$AppDatabase {
  /// Opens `sample.sqlite` in the app's documents folder, or [executor] in
  /// tests.
  AppDatabase([QueryExecutor? executor])
    : super(executor ?? driftDatabase(name: 'sample'));

  @override
  int get schemaVersion => 1;

  /// Newest first.
  Stream<List<Order>> watchOrders() =>
      (select(orders)..orderBy([(o) => OrderingTerm.desc(o.id)])).watch();

  /// Adds the next sample item, as pending.
  Future<int> addOrder() async {
    final count = await orders.count().getSingle();
    final item = sampleItems[count % sampleItems.length];
    return into(orders).insert(OrdersCompanion.insert(item: item));
  }

  /// Moves an order to the next status: pending, shipped, cancelled, pending.
  Future<void> nextStatus(Order order) {
    final next =
        orderStatuses[(orderStatuses.indexOf(order.status) + 1) %
            orderStatuses.length];
    return (update(orders)..where((o) => o.id.equals(order.id))).write(
      OrdersCompanion(status: Value(next)),
    );
  }
}
