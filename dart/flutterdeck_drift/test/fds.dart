import 'dart:io';

/// How many file descriptors this process has open on [path]. Uses
/// /proc/self/fd on Linux and lsof elsewhere (macOS).
int openDescriptors(String path) {
  final real = File(path).resolveSymbolicLinksSync();
  final proc = Directory('/proc/self/fd');
  if (proc.existsSync()) {
    var n = 0;
    for (final fd in proc.listSync(followLinks: false)) {
      try {
        if (Link(fd.path).targetSync() == real) n++;
      } on FileSystemException {
        // Closed while listing.
      }
    }
    return n;
  }
  final out = Process.runSync('lsof', ['-n', '-P', '-p', '$pid', '-Fn']);
  return (out.stdout as String)
      .split('\n')
      .where((line) => line == 'n$real')
      .length;
}

/// Makes garbage until [done] holds or [timeout] passes, so the VM runs
/// garbage collection (and native finalizers) on the way.
Future<bool> collectUntil(
  bool Function() done, {
  Duration timeout = const Duration(seconds: 20),
}) async {
  final watch = Stopwatch()..start();
  while (watch.elapsed < timeout) {
    if (done()) return true;
    // Short-lived garbage, enough to fill the young and old generations.
    var keep = 0;
    for (var i = 0; i < 200; i++) {
      keep += List<int>.filled(100000, i).length;
    }
    if (keep < 0) return false;
    await Future<void>.delayed(const Duration(milliseconds: 50));
  }
  return done();
}
