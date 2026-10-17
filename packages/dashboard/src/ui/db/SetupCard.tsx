import type { DbSource, RunningApp } from '@project-deck/core';
import { useState } from 'react';
import { button } from '../styles.js';
import { VisibleText } from './VisibleText.js';

const SNIPPET = "FlutterDeckDrift.register(db, name: 'app');";

/**
 * No database to show (UI spec, database picker "Empty"): how to add flutterdeck_drift,
 * and on Android and the iOS simulator, a snapshot instead. Backend problems (for
 * example a release app Android won't copy from) are said as the daemon words them.
 */
export function SetupCard({
  app,
  sources,
  onSnapshot,
  busy,
}: {
  app: RunningApp;
  sources: DbSource[];
  onSnapshot: () => void;
  busy: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const platform = app.device?.platform;
  const canSnapshot =
    sources.some((s) => !s.live) && (platform === 'android' || platform === 'ios');
  const problems = sources.filter(
    (s) =>
      s.error !== undefined && s.error.code !== 'setup-needed' && s.error.code !== 'choose-device',
  );
  return (
    <section
      aria-labelledby="db-setup-title"
      className="m-2 flex flex-col gap-2 rounded-md border border-border p-3"
    >
      <h2 id="db-setup-title" className="font-medium">
        Add flutterdeck_drift to see your database live.
      </h2>
      <p>In your app's main(), after you create the database:</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 rounded-sm bg-surface px-2 py-1 font-mono text-sm wrap-anywhere">
          {SNIPPET}
        </code>
        <button
          type="button"
          className={button}
          onClick={() => {
            try {
              void navigator.clipboard.writeText(SNIPPET).then(
                () => setCopied(true),
                () => undefined,
              );
            } catch {
              // No clipboard here.
            }
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="text-sm text-muted">It does nothing in release builds.</p>
      {canSnapshot && (
        <div>
          <button
            type="button"
            className={button}
            aria-disabled={busy ? true : undefined}
            onClick={() => {
              if (!busy) onSnapshot();
            }}
          >
            {busy ? 'Taking snapshot…' : 'Take a snapshot'}
          </button>
        </div>
      )}
      {problems.map((s) => (
        <p key={s.id} role="alert" className="text-sm">
          <VisibleText text={s.error?.message ?? ''} />
        </p>
      ))}
    </section>
  );
}
