import type { AdbRunner } from '@project-deck/android-adb';
import { nodeAdb } from '@project-deck/android-adb';
import type { DbInspector, DbInspectorFactory, Registry, RunningApp } from '@project-deck/core';
import { resolveAndroidSource } from './android.js';
import type { SnapshotEngine } from './engine.js';
import type { XcrunRunner } from './ios.js';
import { nodeXcrun, resolveIosSource } from './ios.js';
import { SqliteSnapshotInspector } from './inspector.js';

export interface SnapshotIds {
  /** `android.applicationId` from config.json. */
  androidApplicationId?: string | undefined;
  /** `ios.bundleId` from config.json. */
  iosBundleId?: string | undefined;
}

export interface SqliteSnapshotFactoryOptions {
  /** Defaults to the real adb from the Android SDK or the PATH. */
  adb?: AdbRunner;
  /** Defaults to /usr/bin/xcrun. */
  xcrun?: XcrunRunner;
  /** Read on each new app, so a config edit applies to the next attach. */
  ids?: () => SnapshotIds;
  platform?: NodeJS.Platform;
  simulatorRoot?: string;
  engine?: () => SnapshotEngine;
}

/**
 * Snapshot inspectors for apps on an Android device or emulator (any host), and on a
 * booted iOS simulator (macOS only; the option is hidden elsewhere). Nothing runs
 * until the inspector is first used.
 */
export class SqliteSnapshotFactory implements DbInspectorFactory {
  readonly id = 'sqlite-file';
  private adbRunner: AdbRunner | undefined;

  constructor(private readonly opts: SqliteSnapshotFactoryOptions = {}) {}

  create(app: RunningApp): Promise<DbInspector | undefined> {
    const ids = this.opts.ids?.() ?? {};
    const inspectorOpts = this.opts.engine === undefined ? {} : { engine: this.opts.engine };
    const platform = app.device?.platform;
    if (platform === 'android') {
      const adb = (this.adbRunner ??= this.opts.adb ?? nodeAdb());
      return Promise.resolve(
        new SqliteSnapshotInspector(
          () => resolveAndroidSource(adb, app, ids.androidApplicationId),
          inspectorOpts,
        ),
      );
    }
    const host = this.opts.platform ?? process.platform;
    if (platform === 'ios' && host === 'darwin') {
      const xcrun = this.opts.xcrun ?? nodeXcrun();
      const resolveOpts = {
        platform: host,
        ...(this.opts.simulatorRoot === undefined
          ? {}
          : { simulatorRoot: this.opts.simulatorRoot }),
      };
      return Promise.resolve(
        new SqliteSnapshotInspector(
          () => resolveIosSource(xcrun, app, ids.iosBundleId, resolveOpts),
          inspectorOpts,
        ),
      );
    }
    return Promise.resolve(undefined);
  }
}

/** Registers the snapshot backend. Returns an undo. */
export function registerSqliteSnapshots(
  registry: Registry,
  opts: SqliteSnapshotFactoryOptions = {},
): () => void {
  return registry.dbInspectors.register(new SqliteSnapshotFactory(opts));
}
