import type { RunningApp } from '@project-deck/core';
import { useDeck } from '../../state/DeckProvider.js';
import { Spinner } from '../Spinner.js';
import { appLabel } from '../format.js';
import { field, linkButton } from '../styles.js';

const NONE = '';

export function AppPicker() {
  const { state, actions } = useDeck();
  const offline = state.connection.kind !== 'connected';
  const attaching = state.attach.status === 'running';
  const apps: RunningApp[] = [...state.apps];
  // Offline, or just stopped: keep showing the last app, greyed out.
  const shown = state.attached ?? (offline ? state.lastApp : null);
  if (shown !== null && !apps.some((a) => a.id === shown.id)) apps.unshift(shown);

  if (apps.length === 0 && state.discovering) {
    return (
      <p role="status" className="flex min-w-0 flex-1 items-center gap-2">
        <Spinner />
        <span>Finding apps…</span>
      </p>
    );
  }
  if (apps.length === 0) {
    return (
      <div className="min-w-0 flex-1">
        <p className="font-medium">No app running</p>
        <p className="text-sm text-muted">
          Start your app from your IDE or <code className="font-mono">flutter run</code>;
          FlutterDeck finds it automatically
        </p>
      </div>
    );
  }

  const selected = shown?.id ?? (state.attach.status === 'idle' ? NONE : state.attach.appId);
  const selectedApp = apps.find((a) => a.id === selected);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <label htmlFor="app-picker" className="sr-only">
        App
      </label>
      <select
        id="app-picker"
        className={`${field} w-full min-w-0 truncate ${offline || state.attached === null ? 'text-muted' : ''}`}
        value={selected}
        disabled={offline || attaching}
        title={selectedApp === undefined ? undefined : appLabel(selectedApp)}
        onChange={(e) => {
          if (e.target.value !== NONE) actions.attach(e.target.value);
        }}
      >
        {selected === NONE && (
          <option value={NONE} disabled>
            Pick an app
          </option>
        )}
        {apps.map((app) => (
          <option key={app.id} value={app.id} title={appLabel(app)}>
            {appLabel(app)}
          </option>
        ))}
      </select>
      {attaching && <Spinner />}
    </div>
  );
}

/** Messages under the picker: attach errors and a stopped app. */
export function AppNotice() {
  const { state, actions } = useDeck();
  const attach = state.attach;
  if (attach.status === 'error') {
    const name = state.apps.find((a) => a.id === attach.appId)?.name ?? attach.appId;
    return (
      <p role="alert" className="text-sm text-error">
        Couldn't attach: {attach.error}.{' '}
        <button
          type="button"
          className={linkButton}
          aria-label={`Try attaching to ${name} again`}
          onClick={() => actions.attach(attach.appId)}
        >
          Try again
        </button>
      </p>
    );
  }
  return (
    <p role="status" className="text-sm text-muted empty:hidden">
      {state.stoppedApp !== null && state.attached === null
        ? `App stopped — ${state.stoppedApp.name}`
        : ''}
    </p>
  );
}
