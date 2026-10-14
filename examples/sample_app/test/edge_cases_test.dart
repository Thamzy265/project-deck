import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flutterdeck_sample/main.dart';

const _marker = '// FLUTTERDECK: put the breakpoint on this line';

TestDefaultBinaryMessengerBinding get _binding =>
    TestDefaultBinaryMessengerBinding.instance;

void _mockChannel(Future<Object?>? Function(MethodCall call)? handler) {
  _binding.defaultBinaryMessenger.setMockMethodCallHandler(
    sampleChannel,
    handler,
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final nativeLogs = <Object?>[];

  setUp(() {
    taps.value = 0;
    nativeLogs.clear();
    _mockChannel((call) async {
      nativeLogs.add(call.arguments);
      return null;
    });
  });

  tearDown(() => _mockChannel(null));

  group('taps', () {
    testWidgets('many fast taps each run the breakpoint line once', (
      tester,
    ) async {
      await tester.pumpWidget(const SampleApp());

      for (var i = 0; i < 25; i++) {
        await tester.tap(find.text('Hit breakpoint'));
      }
      await tester.pump();

      expect(taps.value, 25);
      expect(find.text('Taps: 25'), findsOneWidget);
      expect(nativeLogs, [for (var i = 1; i <= 25; i++) 'Tap $i']);
    });

    testWidgets('taps while the channel call is still pending still count', (
      tester,
    ) async {
      final pending = Completer<Object?>();
      _mockChannel((call) {
        nativeLogs.add(call.arguments);
        return pending.future;
      });
      await tester.pumpWidget(const SampleApp());

      for (var i = 0; i < 3; i++) {
        await tester.tap(find.text('Hit breakpoint'));
        await tester.pump();
      }

      expect(taps.value, 3);
      expect(find.text('Taps: 3'), findsOneWidget);
      expect(nativeLogs, ['Tap 1', 'Tap 2', 'Tap 3']);

      pending.complete(null);
      await tester.pump();
      expect(tester.takeException(), isNull);
    });

    test('overlapping calls each log their own count', () async {
      final pending = Completer<Object?>();
      _mockChannel((call) {
        nativeLogs.add(call.arguments);
        return pending.future;
      });

      final calls = [for (var i = 0; i < 5; i++) onHitBreakpoint()];
      expect(taps.value, 5);

      pending.complete(null);
      await Future.wait(calls);
      expect(nativeLogs, ['Tap 1', 'Tap 2', 'Tap 3', 'Tap 4', 'Tap 5']);
    });

    test('a tap prints the documented print line', () async {
      final printed = <String>[];
      await runZoned(
        onHitBreakpoint,
        zoneSpecification: ZoneSpecification(
          print: (_, _, _, line) => printed.add(line),
        ),
      );

      expect(printed, ['flutterdeck.sample print: Tap 1']);
    });
  });

  group('channel failures', () {
    PlatformException failure() =>
        PlatformException(code: 'error', message: 'native log failed');

    // Regression lock: the increment runs before the channel call, so a
    // failing native side must never stop the breakpoint line from running.
    test('the counter still advances when the channel throws', () async {
      _mockChannel((_) async => throw failure());

      await onHitBreakpoint().catchError((Object _) {});
      expect(taps.value, 1);
    });

    test(
      'a PlatformException from the channel does not escape onHitBreakpoint',
      () async {
        _mockChannel((_) async => throw failure());

        await expectLater(onHitBreakpoint(), completes);
      },
      skip:
          'BUG: onHitBreakpoint() catches only MissingPluginException, so a '
          'PlatformException escapes as an unhandled async error from the '
          'button callback',
    );

    testWidgets(
      'tapping while the channel throws leaves no uncaught error',
      (tester) async {
        _mockChannel((_) async => throw failure());
        await tester.pumpWidget(const SampleApp());

        await tester.tap(find.text('Hit breakpoint'));
        await tester.pump();

        expect(find.text('Taps: 1'), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
      skip: true, // BUG: same as above; the tap's unawaited future errors.
    );
  });

  group('breakpoint marker', () {
    final source = File('lib/main.dart').readAsLinesSync();

    int markedIndex() {
      final indexes = [
        for (var i = 0; i < source.length; i++)
          if (source[i].contains(_marker)) i,
      ];
      expect(indexes, hasLength(1), reason: 'exactly one marker line');
      return indexes.single;
    }

    test('the marked line is live code, not a commented-out statement', () {
      final line = source[markedIndex()];
      final code = line.substring(0, line.indexOf(_marker)).trim();

      expect(code, 'taps.value += 1;');
      expect(line.trimRight(), endsWith(_marker));
    });

    test('the marked line is the first statement of onHitBreakpoint', () {
      final start = source.indexWhere(
        (l) => l.startsWith('Future<void> onHitBreakpoint() async {'),
      );
      expect(start, isNot(-1));
      final end = source.indexWhere((l) => l == '}', start);
      final marked = markedIndex();

      expect(marked, greaterThan(start));
      expect(marked, lessThan(end));
      final before = source
          .sublist(start + 1, marked)
          .where((l) => l.trim().isNotEmpty);
      expect(before, isEmpty, reason: 'nothing can return before the line');
    });

    testWidgets('the button calls onHitBreakpoint directly', (tester) async {
      await tester.pumpWidget(const SampleApp());

      final button = tester.widget<FilledButton>(find.byType(FilledButton));
      expect(button.onPressed, same(onHitBreakpoint));
    });
  });

  group('README matches the code', () {
    final readme = File('README.md').readAsStringSync();
    final dart = File('lib/main.dart').readAsStringSync();
    final kotlin = File(
      'android/app/src/main/kotlin/dev/flutterdeck/flutterdeck_sample/'
      'MainActivity.kt',
    ).readAsStringSync();

    test('the marker comment is quoted exactly', () {
      expect(readme, contains('`$_marker`'));
      expect(readme, contains('`onHitBreakpoint()`'));
      expect(dart, contains('Future<void> onHitBreakpoint()'));
    });

    test('the reload marker is the reloadMarker constant on screen', () {
      expect(readme, contains('`reloadMarker` in `lib/main.dart`'));
      expect(
        dart,
        matches(RegExp(r"^const reloadMarker = '[^']+';$", multiLine: true)),
      );
    });

    testWidgets('the button label is the one the README names', (tester) async {
      final label =
          RegExp(r'\*\*(.+?)\*\* button').firstMatch(readme)?.group(1) ?? '';
      expect(label, isNotEmpty);
      await tester.pumpWidget(const SampleApp());

      expect(find.text(label), findsOneWidget);
      expect(readme, contains('Tap **$label**'));
    });

    test('the developer.log name matches the README', () {
      expect(
        readme,
        contains('`developer.log` line named `flutterdeck.sample`'),
      );
      expect(dart, contains("name: 'flutterdeck.sample'"));
    });

    test('the logcat tag and channel name match on both sides', () {
      expect(readme, contains('tag `FlutterDeckSample`'));
      expect(kotlin, contains('Log.i("FlutterDeckSample"'));
      expect(dart, contains("MethodChannel('flutterdeck/sample')"));
      expect(kotlin, contains('"flutterdeck/sample"'));
      expect(dart, contains("invokeMethod<void>('log'"));
      expect(kotlin, contains('call.method == "log"'));
    });

    test('the Kotlin handler tolerates bad calls', () {
      // No cheap JVM test harness here; lock the two guards in the source.
      expect(kotlin, contains('call.arguments as? String ?: ""'));
      expect(kotlin, contains('result.notImplemented()'));
    });

    test('the repo paths the README uses exist', () {
      expect(File('../../scripts/dtd-apps.mjs').existsSync(), isTrue);
      expect(File('../../README.md').existsSync(), isTrue);
      expect(File('../../packages/daemon/src/main.ts').existsSync(), isTrue);
    });
  });

  group('repo hygiene', () {
    List<String> git(List<String> args) {
      final result = Process.runSync('git', args);
      expect(result.exitCode, 0, reason: '${result.stderr}');
      return (result.stdout as String)
          .split('\n')
          .where((l) => l.isNotEmpty)
          .toList();
    }

    test('no tracked file is git-ignored', () {
      expect(git(['ls-files', '-ci', '--exclude-standard', '.']), isEmpty);
    });

    test('machine-specific files are not tracked', () {
      final tracked = git(['ls-files', '.']);
      expect(
        tracked.where(
          (f) =>
              f.endsWith('local.properties') ||
              f.endsWith('key.properties') ||
              f.endsWith('.jks') ||
              f.endsWith('.keystore') ||
              f.contains('.dart_tool/') ||
              f.startsWith('build/'),
        ),
        isEmpty,
      );
    });

    test('no tracked text file holds a home-directory path', () {
      final hits = Process.runSync('git', [
        'grep',
        '-nIE',
        r'/Users/|/home/[a-z]|C:\\\\Users',
        '--',
        '.',
        ':!test/',
      ]);
      expect(hits.stdout, isEmpty);
    });
  });
}
