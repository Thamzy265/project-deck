import 'dart:io';

import 'package:test/test.dart';

/// Runs the probe in a fresh VM with [defines] and returns what it printed.
Future<String> probe(List<String> defines) async {
  final result = await Process.run(Platform.resolvedExecutable, [
    'run',
    ...defines,
    'test/probe/build_mode_probe.dart',
  ]);
  expect(result.exitCode, 0, reason: '${result.stderr}');
  return (result.stdout as String).trim().split('\n').last;
}

void main() {
  test(
    'debug: register adds the extensions',
    () async {
      expect(await probe(const []), 'registered');
    },
    timeout: const Timeout(Duration(minutes: 2)),
  );

  test('release: register does nothing', () async {
    expect(await probe(const ['-Ddart.vm.product=true']), 'none');
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('profile: register does nothing', () async {
    expect(await probe(const ['-Ddart.vm.profile=true']), 'none');
  }, timeout: const Timeout(Duration(minutes: 2)));
}
