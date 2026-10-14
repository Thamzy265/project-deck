import type { ReactNode } from 'react';
import { Spinner } from './Spinner.js';

/** Whole-page messages shown before the dashboard can work (UI spec, "Whole page"). */
function Centered({ children, busy = false }: { children: ReactNode; busy?: boolean }) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <h1 className="sr-only">FlutterDeck</h1>
      <p role="status" className="flex max-w-prose items-center gap-2 text-center text-lg">
        {busy && <Spinner />}
        <span>{children}</span>
      </p>
    </main>
  );
}

const code = 'rounded-sm bg-surface px-1 font-mono';

export function LoadingPage() {
  return <Centered busy>Loading FlutterDeck…</Centered>;
}

export function ReauthPage() {
  return <Centered busy>Reconnecting to FlutterDeck…</Centered>;
}

export function DaemonDownPage() {
  return (
    <Centered>
      Can't reach FlutterDeck. Run <code className={code}>flutterdeck start</code> in your project,
      or start a Claude session with the plugin.
    </Centered>
  );
}

export function LoginNeededPage() {
  return (
    <Centered>
      Login needed. Run <code className={code}>flutterdeck open</code> in your project (or start a
      Claude session with the plugin), then reload this page.
    </Centered>
  );
}
