#!/usr/bin/env bash
# Boots an Android emulator, runs a throwaway Flutter app on it, and tears both down again.
# Used by scripts/qa/check-android-logs.mjs (Android native logs) and
# scripts/qa/check-m1-acceptance.mjs (attach next to a debugger) end to end.
#
# Usage: scripts/qa/android-sample-app.sh up|down
#
# Environment (all optional):
#   QA_ANDROID_DIR  scratch folder for the app, logs and state (default: $TMPDIR/project-deck-qa-android)
#   QA_AVD          AVD to boot when no emulator is running (default: Pixel_9_Pro, needs API 24+)
#   QA_EMU_PORT     console port for the emulator we start; the serial is emulator-<port> (default: 5580)
#   ANDROID_HOME    Android SDK (default: ~/Library/Android/sdk on macOS, ~/Android/Sdk elsewhere)
#   FLUTTER         flutter executable (default: flutter on PATH)
#
# Only ever stops what `up` started: the flutter run process and an emulator it booted itself.
# It never kills the adb server, so Android Studio keeps working.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="${QA_ANDROID_DIR:-${TMPDIR:-/tmp}/project-deck-qa-android}"
DIR="${DIR%/}"
AVD="${QA_AVD:-Pixel_9_Pro}"
PORT="${QA_EMU_PORT:-5580}"
if [[ -z "${ANDROID_HOME:-}" ]]; then
  if [[ "$(uname)" == Darwin ]]; then ANDROID_HOME="$HOME/Library/Android/sdk"; else ANDROID_HOME="$HOME/Android/Sdk"; fi
fi
ADB="$ANDROID_HOME/platform-tools/adb"
EMULATOR="$ANDROID_HOME/emulator/emulator"
FLUTTER="${FLUTTER:-flutter}"
APP_NAME=qa_sample_app
APP="$DIR/$APP_NAME"
STATE="$DIR/state"

log() { printf '[qa-android] %s\n' "$*"; }
die() {
  printf '[qa-android] error: %s\n' "$*" >&2
  exit 1
}

booted() { [[ "$("$ADB" -s "$1" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; }

running_emulators() { "$ADB" devices | awk '/^emulator-[0-9]+[[:space:]]+device$/ { print $1 }'; }

alive() { [[ -n "${1:-}" ]] && kill -0 "$1" 2>/dev/null; }

write_app() {
  mkdir -p "$DIR"
  if [[ ! -f "$APP/pubspec.yaml" ]]; then
    log "creating $APP_NAME in $DIR"
    (cd "$DIR" && "$FLUTTER" create --platforms android --org com.example --project-name "$APP_NAME" "$APP_NAME" >"$DIR/create.log" 2>&1) ||
      die "flutter create failed, see $DIR/create.log"
  fi
  # Prints and dart:developer logs reach the daemon through the VM service; the native ticks
  # come from Kotlin so logcat has fresh lines for the app's pid that aren't tagged `flutter`.
  # qaTick is top level so a hot reload swaps its body (check-m1-acceptance.mjs edits its print),
  # and qaCheckpoint runs every 5 s so a debugger has a line to break on (the `qa-breakpoint` marker).
  cat >"$APP/lib/main.dart" <<'DART'
import 'dart:async';
import 'dart:developer' as developer;

import 'package:flutter/material.dart';

final qaLast = ValueNotifier<String>('waiting for the first tick');

void main() {
  var n = 0;
  Timer.periodic(const Duration(seconds: 1), (_) {
    n++;
    qaTick(n);
  });
  runApp(MaterialApp(
    home: Scaffold(
      body: Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Text('project-deck QA sample'),
          ValueListenableBuilder<String>(
            valueListenable: qaLast,
            builder: (_, text, _) => Text(text),
          ),
        ]),
      ),
    ),
  ));
}

void qaTick(int n) {
  final text = 'qa-sample print tick $n';
  qaLast.value = text;
  // ignore: avoid_print
  print(text);
  developer.log('qa-sample developer.log tick $n', name: 'qa_sample');
  if (n % 5 == 0) qaCheckpoint(n);
}

void qaCheckpoint(int n) {
  developer.log('qa-sample checkpoint $n', name: 'qa_sample'); // qa-breakpoint
}
DART
  local kt
  kt="$(find "$APP/android/app/src/main" -name MainActivity.kt | head -n 1)"
  [[ -n "$kt" ]] || die "MainActivity.kt not found in $APP"
  cat >"$kt" <<'KOTLIN'
package com.example.qa_sample_app

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity() {
    private val handler = Handler(Looper.getMainLooper())
    private var n = 0
    private val tick = object : Runnable {
        override fun run() {
            n++
            Log.i("QaSampleNative", "native tick $n")
            handler.postDelayed(this, 2000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handler.post(tick)
    }

    override fun onDestroy() {
        handler.removeCallbacks(tick)
        super.onDestroy()
    }
}
KOTLIN
}

up() {
  [[ -x "$ADB" ]] || die "adb not found at $ADB (set ANDROID_HOME)"
  command -v "$FLUTTER" >/dev/null || die "flutter not found (set FLUTTER)"
  mkdir -p "$DIR" "$STATE"
  if alive "$(cat "$STATE/flutter.pid" 2>/dev/null)"; then die "already up; run 'down' first"; fi

  local serial=""
  for s in $(running_emulators); do
    if booted "$s"; then
      serial="$s"
      break
    fi
  done
  if [[ -n "$serial" ]]; then
    log "reusing booted emulator $serial (it will be left running)"
    rm -f "$STATE/emulator.serial"
  else
    [[ -x "$EMULATOR" ]] || die "emulator not found at $EMULATOR"
    serial="emulator-$PORT"
    log "booting $AVD headless as $serial"
    nohup "$EMULATOR" -avd "$AVD" -port "$PORT" -no-window -no-audio -no-boot-anim -no-snapshot-save \
      >"$DIR/emulator.log" 2>&1 </dev/null &
    echo "$!" >"$STATE/emulator.pid"
    echo "$serial" >"$STATE/emulator.serial"
    local deadline=$((SECONDS + 300))
    until booted "$serial"; do
      alive "$(cat "$STATE/emulator.pid")" || die "emulator exited, see $DIR/emulator.log"
      ((SECONDS < deadline)) || die "emulator did not boot within 300 s"
      sleep 2
    done
  fi
  local sdk
  sdk="$("$ADB" -s "$serial" shell getprop ro.build.version.sdk | tr -d '\r')"
  ((sdk >= 24)) || die "$serial runs API $sdk; Android native logs need API 24+"
  log "$serial booted (API $sdk)"

  write_app
  log "flutter run -d $serial (first build can take a few minutes)"
  (cd "$APP" && nohup "$FLUTTER" run -d "$serial" >"$DIR/flutter-run.log" 2>&1 </dev/null &
    echo "$!" >"$STATE/flutter.pid")
  local deadline=$((SECONDS + 900))
  until node "$ROOT/scripts/dtd-apps.mjs" 2>/dev/null | grep -q "Package: $APP_NAME"; do
    alive "$(cat "$STATE/flutter.pid")" || die "flutter run exited, see $DIR/flutter-run.log"
    ((SECONDS < deadline)) || die "app not visible through DTD within 900 s, see $DIR/flutter-run.log"
    sleep 3
  done
  log "up: $APP_NAME is running on $serial and visible through DTD"
}

stop_pid() {
  local pid="$1" signal="$2" wait_s="$3"
  alive "$pid" || return 0
  kill "-$signal" "$pid" 2>/dev/null || true
  local deadline=$((SECONDS + wait_s))
  while alive "$pid" && ((SECONDS < deadline)); do sleep 1; done
  alive "$pid" && kill -KILL "$pid" 2>/dev/null || true
}

down() {
  local pid serial
  pid="$(cat "$STATE/flutter.pid" 2>/dev/null || true)"
  if alive "$pid"; then
    log "stopping flutter run (pid $pid)"
    # The flutter script runs the tool as a child; stop the whole tree.
    pkill -TERM -P "$pid" 2>/dev/null || true
    stop_pid "$pid" TERM 15
  fi
  serial="$(cat "$STATE/emulator.serial" 2>/dev/null || true)"
  if [[ -n "$serial" ]]; then
    log "killing the emulator we started ($serial)"
    "$ADB" -s "$serial" emu kill >/dev/null 2>&1 || true
    stop_pid "$(cat "$STATE/emulator.pid" 2>/dev/null || true)" TERM 30
  fi
  # Only what up created. Logs stay in $DIR for a post-mortem.
  if [[ -f "$APP/pubspec.yaml" ]]; then
    log "removing $APP"
    rm -rf "$APP"
  fi
  rm -rf "$STATE"
  log "down (logs kept in $DIR)"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) die "usage: $0 up|down" ;;
esac
