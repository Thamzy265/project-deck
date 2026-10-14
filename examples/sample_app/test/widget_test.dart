import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:flutterdeck_sample/main.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final nativeLogs = <Object?>[];

  setUp(() {
    taps.value = 0;
    nativeLogs.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(sampleChannel, (call) async {
          nativeLogs.add(call.arguments);
          return null;
        });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(sampleChannel, null);
  });

  testWidgets('shows the reload marker', (tester) async {
    await tester.pumpWidget(const SampleApp());

    expect(find.text(reloadMarker), findsOneWidget);
  });

  testWidgets('tapping the button runs the breakpoint line', (tester) async {
    await tester.pumpWidget(const SampleApp());
    expect(find.text('Taps: 0'), findsOneWidget);

    await tester.tap(find.text('Hit breakpoint'));
    await tester.pump();

    expect(taps.value, 1);
    expect(find.text('Taps: 1'), findsOneWidget);
    expect(nativeLogs, ['Tap 1']);
  });

  test('a missing native channel does not throw', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(sampleChannel, null);

    await expectLater(onHitBreakpoint(), completes);
    expect(taps.value, 1);
  });

  // The tap test above proves this line runs; edge_cases_test.dart checks
  // its position inside onHitBreakpoint().
  test('the breakpoint marker sits on the live counter line', () {
    final marked = File('lib/main.dart')
        .readAsLinesSync()
        .where((line) => line.contains('// FLUTTERDECK: put the breakpoint'))
        .toList();

    expect(marked, hasLength(1));
    expect(marked.single.split('//').first.trim(), 'taps.value += 1;');
  });
}
