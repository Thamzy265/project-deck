import 'dart:developer' as developer;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

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
  }
}

void main() {
  runApp(const SampleApp());
}

class SampleApp extends StatelessWidget {
  const SampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'FlutterDeck sample',
      theme: ThemeData(colorSchemeSeed: Colors.indigo),
      home: Scaffold(
        appBar: AppBar(title: const Text('FlutterDeck sample')),
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
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
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                ),
                const SizedBox(height: 32),
                Semantics(
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
              ],
            ),
          ),
        ),
      ),
    );
  }
}
