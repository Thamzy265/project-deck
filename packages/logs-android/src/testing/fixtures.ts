/** The app process the fixtures were written for. */
export const FIXTURE_PID = 4242;
export const FIXTURE_PACKAGE = 'com.example.shop';
export const FIXTURE_SERIAL = 'emulator-5554';

/**
 * `adb logcat -v threadtime --pid=4242` output for a Flutter app on an emulator.
 * Multi-line messages (a Java stack trace) come out as one line per text line,
 * each with the same header: that is how logcat prints a single multi-line log call.
 */
export const THREADTIME_FIXTURE = `--------- beginning of main
10-13 14:02:31.004  4242  4242 V FlutterLoader: Initializing Flutter loader
10-13 14:02:31.118  4242  4242 D FlutterJNI: Beginning load of flutter...
10-13 14:02:31.119  4242  4242 D FlutterJNI: flutter (null) was loaded normally!
10-13 14:02:31.552  4242  4281 I flutter : The Dart VM service is listening on http://127.0.0.1:40229/AbC=/
10-13 14:02:31.553  4242  4281 I flutter : Shop app started
10-13 14:02:32.010  4242  4264 W ResourceType: For resource 0x0101053d, entry index(1341) is beyond type entryCount(1)
10-13 14:02:32.204  4242  4242 W libEGL  : EGLNativeWindowType 0x7a3c0010 disconnect failed
--------- beginning of system
10-13 14:02:33.870  4242  4300 E OkHttp  : Request to /api/cart failed
10-13 14:02:33.870  4242  4300 E OkHttp  : java.net.SocketTimeoutException: timeout
10-13 14:02:33.870  4242  4300 E OkHttp  : 	at okhttp3.internal.http2.Http2Stream$StreamTimeout.newTimeoutException(Http2Stream.kt:675)
10-13 14:02:33.870  4242  4300 E OkHttp  : 	at okhttp3.internal.http2.Http2Stream.takeHeaders(Http2Stream.kt:143)
10-13 14:02:33.870  4242  4300 E OkHttp  : 	... 12 more
10-13 14:02:34.001  4242  4242 I Choreographer: Skipped 31 frames!  The application may be doing too much work on its main thread.
--------- beginning of crash
10-13 14:02:35.442  4242  4242 E AndroidRuntime: FATAL EXCEPTION: main
10-13 14:02:35.442  4242  4242 E AndroidRuntime: Process: com.example.shop, PID: 4242
10-13 14:02:35.442  4242  4242 E AndroidRuntime: java.lang.RuntimeException: Unable to start activity ComponentInfo{com.example.shop/com.example.shop.MainActivity}: java.lang.IllegalStateException: boom
10-13 14:02:35.442  4242  4242 E AndroidRuntime: 	at android.app.ActivityThread.performLaunchActivity(ActivityThread.java:3782)
10-13 14:02:35.442  4242  4242 E AndroidRuntime: 	at android.app.ActivityThread.handleLaunchActivity(ActivityThread.java:3922)
10-13 14:02:35.442  4242  4242 E AndroidRuntime: Caused by: java.lang.IllegalStateException: boom
10-13 14:02:35.442  4242  4242 E AndroidRuntime: 	at com.example.shop.MainActivity.onCreate(MainActivity.kt:12)
10-13 14:02:35.442  4242  4242 E AndroidRuntime: 	... 11 more
10-13 14:02:35.460  4242  4242 F libc    : Fatal signal 6 (SIGABRT), code -1 (SI_QUEUE) in tid 4242 (example.shop), pid 4242 (example.shop)
`;

/**
 * `adb logcat -v threadtime -v epoch --pid=4242` (Android 7.0+): seconds since the epoch
 * instead of a local date, so there is no year or timezone to guess. logcat right-aligns
 * the seconds in a 19-character field; the first line shows the unpadded form too.
 */
export const EPOCH_FIXTURE = `--------- beginning of main
1697050000.123  4242  4242 I FlutterJNI: Beginning load of flutter...
         1697050000.456  4242  4281 I flutter : Shop app started
         1697050001.002  4242  4264 W ResourceType: For resource 0x0101053d, entry index(1341) is beyond type entryCount(1)
         1697050002.870  4242  4300 E OkHttp  : Request to /api/cart failed
         1697050002.870  4242  4300 E OkHttp  : java.net.SocketTimeoutException: timeout
         1697050002.870  4242  4300 E OkHttp  : 	at okhttp3.internal.http2.Http2Stream.takeHeaders(Http2Stream.kt:143)
         1697050003.460  4242  4242 F libc    : Fatal signal 6 (SIGABRT), code -1 (SI_QUEUE) in tid 4242 (example.shop), pid 4242 (example.shop)
`;

/** `adb devices` with an emulator, a USB phone, one unauthorized and one offline device. */
export const ADB_DEVICES_FIXTURE = `List of devices attached
emulator-5554\tdevice
R58M123ABC\tdevice
0123456789ABCDEF\tunauthorized
192.168.1.20:5555\toffline

`;
