import type {
  AppSession,
  DbInspector,
  DbInspectorFactory,
  Registry,
  RunningApp,
} from '@project-deck/core';
import { DriftInspector } from './inspector.js';
import { EXTENSION_PREFIX } from './protocol.js';

/**
 * Makes a DriftInspector for any attached session that offers app extensions. The
 * app may register flutterdeck_drift later (or not at all); until it does, calls
 * answer `setup-needed`, which the dashboard shows as the setup help.
 */
export class DriftInspectorFactory implements DbInspectorFactory {
  readonly id = 'drift';

  create(_app: RunningApp, session?: AppSession): Promise<DbInspector | undefined> {
    const ext = session?.extensions;
    if (session === undefined || ext === undefined) return Promise.resolve(undefined);
    return Promise.resolve(
      new DriftInspector(ext, {
        onRestart: (cb) =>
          session.on('reloaded', (result) => {
            if (result.ok && result.kind === 'hot-restart') cb();
          }),
      }),
    );
  }
}

/** Registers the live Drift backend and allows its extension prefix. Returns an undo. */
export function registerDrift(registry: Registry): () => void {
  const release = registry.allowExtensionPrefix(EXTENSION_PREFIX);
  const unregister = registry.dbInspectors.register(new DriftInspectorFactory());
  return () => {
    unregister();
    release();
  };
}
