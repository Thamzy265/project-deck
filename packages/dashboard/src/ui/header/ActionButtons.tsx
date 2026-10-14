import type { ActionKind } from '../../state/deck.js';
import { useDeck } from '../../state/DeckProvider.js';
import { Spinner } from '../Spinner.js';
import { headerButton } from '../styles.js';

const LABEL: Record<
  ActionKind,
  { idle: string; busy: string; icon: string; key: string; aria: string }
> = {
  reload: { idle: 'Reload', busy: 'Reloading…', icon: '⟳', key: 'r', aria: 'r' },
  restart: { idle: 'Restart', busy: 'Restarting…', icon: '↻', key: 'R', aria: 'Shift+R' },
};

/** Why a button can't be used right now, or undefined when it can. */
function blocked(offline: boolean, attached: boolean, running: boolean): string | undefined {
  if (offline) return 'Not connected';
  if (!attached) return 'No app attached';
  if (running) return 'A reload is running';
  return undefined;
}

export function ActionButtons({ shortcuts }: { shortcuts: boolean }) {
  const { state, actions } = useDeck();
  const attached = state.attached;
  if (attached !== null && state.unsupported.includes(attached.id)) {
    return <p className="text-sm text-muted">Reload not available for this app</p>;
  }
  const reason = blocked(
    state.connection.kind !== 'connected',
    attached !== null,
    state.running !== null,
  );
  return (
    <div className="flex gap-2">
      {(['reload', 'restart'] as const).map((kind) => {
        const label = LABEL[kind];
        const busy = state.running?.kind === kind;
        return (
          <button
            key={kind}
            type="button"
            className={headerButton}
            aria-disabled={reason === undefined ? undefined : true}
            aria-keyshortcuts={shortcuts ? label.aria : undefined}
            title={reason}
            onClick={() => {
              if (reason === undefined) actions.run(kind);
            }}
          >
            {busy ? <Spinner /> : <span aria-hidden="true">{label.icon}</span>}
            <span>{busy ? label.busy : label.idle}</span>
            {shortcuts && (
              <kbd aria-hidden="true" className="hidden font-mono text-sm text-muted pane:inline">
                {label.key}
              </kbd>
            )}
          </button>
        );
      })}
    </div>
  );
}
