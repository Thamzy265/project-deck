import type { DeviceInfo } from '@project-deck/core';

/**
 * flutter_tools names each app it starts for DDS (and so in DTD) as
 * 'Kind: Flutter - Device: <device display name> - Package: <pubspec name>'
 * (Flutter 3.44.6, lib/src/resident_runner.dart and lib/src/commands/daemon.dart).
 * The device name may itself hold " - ", so the package is taken from the last part.
 */
const TOOL_NAME = /^Kind: [^-]+ - Device: (.+) - Package: ([^ ]+)$/;

/** The tool writes this when it couldn't read the project's pubspec. */
const UNKNOWN_PACKAGE = 'Unknown';

export function parseAppName(raw: string | undefined): {
  name: string;
  device?: Omit<DeviceInfo, 'platform'>;
} {
  if (raw === undefined) return { name: 'Dart app' };
  const match = TOOL_NAME.exec(raw);
  const deviceName = match?.[1];
  const pkg = match?.[2];
  if (deviceName === undefined || pkg === undefined) return { name: raw };
  // The serial isn't in the name; the platform comes from the VM once attached.
  const device = { id: 'unknown', name: deviceName };
  return { name: pkg === UNKNOWN_PACKAGE ? raw : pkg, device };
}
