/** The app process the fixtures were written for. */
export const FIXTURE_PID = 4242;
export const FIXTURE_PACKAGE = 'com.example.shop';
export const FIXTURE_SERIAL = 'emulator-5554';

/** `adb devices` with an emulator, a USB phone, one unauthorized and one offline device. */
export const ADB_DEVICES_FIXTURE = `List of devices attached
emulator-5554\tdevice
R58M123ABC\tdevice
0123456789ABCDEF\tunauthorized
192.168.1.20:5555\toffline

`;

/**
 * What `run-as` prints (on stderr) for an app that isn't debuggable, as Android 14
 * (API 34) words it. Older releases say "Package 'x' is not debuggable".
 */
export const RUN_AS_NOT_DEBUGGABLE = 'run-as: package not debuggable: com.example.shop\n';
/** `run-as` for a package that isn't installed (API 34). */
export const RUN_AS_UNKNOWN_PACKAGE = 'run-as: unknown package: com.example.shop\n';
