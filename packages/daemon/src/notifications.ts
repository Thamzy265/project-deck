/**
 * OS notifications for the three events in PM decision D3: app crashed, reload failed and
 * Claude waiting. "Claude finished" stays with Claude Desktop's own notification. They are
 * built from Activity entries, so the crash rule and the reload merge live in one place,
 * and they never hold log content: only the app's name or Claude Code's waiting message.
 */
import type { ActivityEntry, DeckConfig, EventBus } from '@project-deck/core';
import { visibleText } from './notify-command.js';
import type { Notifier } from './notify-run.js';

export const NOTIFY_RATE_WINDOW_MS = 30_000;
const TITLE = 'FlutterDeck';
/** From the UI spec: "Claude is waiting — <first 100 chars of the message>". */
const WAITING_CHARS = 100;

type Kind = keyof DeckConfig['notifications'];

export interface NotificationsOptions {
  settings: DeckConfig['notifications'];
  notify: Notifier;
}

/** What to say for an entry, split so a "(3 times)" count goes after the first part. */
function message(entry: ActivityEntry): { kind: Kind; head: string; tail?: string } | undefined {
  switch (entry.kind) {
    case 'app.crashed':
      return { kind: 'appCrashed', head: 'App crashed', tail: entry.appName };
    case 'app.reloaded':
      // Not-attached and unsupported mean nothing was reloaded, so nothing failed.
      if (entry.result.ok || entry.result.reason === 'not-attached') return undefined;
      if (entry.result.reason === 'unsupported') return undefined;
      return { kind: 'reloadFailed', head: 'Reload failed', tail: entry.appName };
    case 'claude.reload':
      // No app attached: nothing in the dashboard failed, so Activity only (C2).
      if (entry.ok || entry.appName === undefined) return undefined;
      return { kind: 'reloadFailed', head: 'Reload failed', tail: entry.appName };
    case 'claude.waiting': {
      // Control and invisible characters don't count: a message of only those is empty.
      const text = Array.from(visibleText(entry.message ?? ''))
        .slice(0, WAITING_CHARS)
        .join('');
      return {
        kind: 'claudeWaiting',
        head: 'Claude is waiting',
        ...(text === '' ? {} : { tail: text }),
      };
    }
    default:
      return undefined;
  }
}

/** Subscribes to Activity entries. Returns a function that unsubscribes. */
export function startNotifications(bus: EventBus, opts: NotificationsOptions): () => void {
  const sent = new Map<Kind, { at: number; held: number }>();
  const off = bus.on('activity', (entry) => {
    const msg = message(entry);
    if (msg === undefined || !opts.settings[msg.kind]) return;
    // The feed's time for the event, not the time this microtask runs.
    const t = entry.ts;
    const last = sent.get(msg.kind);
    if (last !== undefined && t - last.at < NOTIFY_RATE_WINDOW_MS) {
      last.held++;
      return;
    }
    // Held events count in the next one, unless that comes much later: then they are old
    // news, and "(5 times)" would describe a burst long past (C6).
    const stale = last === undefined || t - last.at > 2 * NOTIFY_RATE_WINDOW_MS;
    const times = (stale ? 0 : last.held) + 1;
    sent.set(msg.kind, { at: t, held: 0 });
    const head = times > 1 ? `${msg.head} (${times} times)` : msg.head;
    try {
      opts.notify(TITLE, msg.tail === undefined ? head : `${head} — ${msg.tail}`);
    } catch {
      // A notifier must never break the daemon; the system one logs its own failures.
    }
  });
  return () => {
    off();
    opts.notify.close?.();
  };
}
