import { describe, expect, it } from 'vitest';
import { parseAppName } from './app-name.js';

/**
 * The format flutter_tools gives DDS as the app name (Flutter 3.44.6:
 * lib/src/resident_runner.dart and lib/src/commands/daemon.dart):
 *   'Kind: Flutter - Device: ${device.displayName} - Package: ${manifest.appName}'
 * The first string is from QA's recorded sessions (docs/qa/M1.md, docs/qa/M2.md B2-1).
 */
describe('parseAppName (QA B2-1)', () => {
  it('splits the Flutter tool name into package and device', () => {
    expect(
      parseAppName('Kind: Flutter - Device: sdk gphone64 arm64 - Package: qa_sample_app'),
    ).toEqual({ name: 'qa_sample_app', device: { id: 'unknown', name: 'sdk gphone64 arm64' } });
  });

  it('keeps " - " inside a device name', () => {
    expect(parseAppName('Kind: Flutter - Device: Pixel 9 - API 36 - Package: shop')).toEqual({
      name: 'shop',
      device: { id: 'unknown', name: 'Pixel 9 - API 36' },
    });
  });

  it('keeps the whole name when the tool knew no package', () => {
    expect(parseAppName('Kind: Flutter - Device: iPhone 16e - Package: Unknown')).toEqual({
      name: 'Kind: Flutter - Device: iPhone 16e - Package: Unknown',
      device: { id: 'unknown', name: 'iPhone 16e' },
    });
  });

  it('leaves other names alone', () => {
    expect(parseAppName('shop')).toEqual({ name: 'shop' });
    expect(parseAppName('Kind: Flutter - Package: x')).toEqual({
      name: 'Kind: Flutter - Package: x',
    });
    expect(parseAppName(undefined)).toEqual({ name: 'Dart app' });
  });
});
