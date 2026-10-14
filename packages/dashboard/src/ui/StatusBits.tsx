import type { ConnectionState } from '../api/connection.js';
import { useDeck } from '../state/DeckProvider.js';

function bannerText(c: ConnectionState): string {
  if (c.kind === 'connecting') return 'Connecting…';
  if (c.kind === 'retrying') return `Lost connection to FlutterDeck — retrying (${c.attempt})…`;
  return '';
}

/** Stays mounted (empty when connected) so its changes are announced; never takes focus. */
export function ConnectionBanner() {
  const { state } = useDeck();
  const text = bannerText(state.connection);
  return (
    <div
      role="status"
      className={text === '' ? 'sr-only' : 'border-b border-warn bg-surface px-2 py-1 text-warn'}
    >
      {text}
    </div>
  );
}

export function Footer() {
  const { state } = useDeck();
  const c = state.connection.kind;
  const label =
    c === 'connected' ? 'Connected' : c === 'connecting' ? 'Connecting…' : 'Not connected';
  return (
    <footer className="border-t border-border px-2 py-1 text-sm text-muted">
      {label}
      {state.info === undefined ? '' : ` · v${state.info.version}`}
    </footer>
  );
}
