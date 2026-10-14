import type { WsMessage } from '@project-deck/core';
import { WsMessageSchema } from '@project-deck/core';
import type { SessionGuard } from '../state/storage.js';

/** The daemon sends a heartbeat every 15 s; two missed ones mean the socket is dead. */
export const IDLE_TIMEOUT_MS = 30_000;
const BACKOFF_MS = [500, 1000, 2000, 5000] as const;

export type ConnectionState =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'retrying'; attempt: number }
  /** The login cookie is old; the page is reloading to get a new one. */
  | { kind: 'reauth' }
  | { kind: 'login-refused' };

/** What `GET /api/status` says after the socket failed (design note, "Session expiry"). */
export type StatusCheck = 'ok' | 'unauthorized' | 'unreachable';

/** The part of the browser WebSocket this uses. */
export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export interface ConnectionDeps {
  openSocket(): SocketLike;
  checkStatus(): Promise<StatusCheck>;
  guard: SessionGuard;
  reloadPage(): void;
  onState(state: ConnectionState): void;
  /** `reconnect` is true after the first successful open, so the caller can fill the gap. */
  onOpen(reconnect: boolean): void;
  onMessage(message: WsMessage): void;
  random?: () => number;
}

/** Equal jitter: between half and all of 0.5 s, 1 s, 2 s, then 5 s. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1] ?? 5000;
  return base / 2 + random() * (base / 2);
}

/**
 * Keeps the dashboard's WebSocket open. A browser can't see why a handshake was refused,
 * so after any failure it asks `/api/status`: 401 means the cookie is old (reload the page
 * once), anything else means retry with backoff.
 */
export class Connection {
  private socket: SocketLike | undefined;
  private attempt = 0;
  private opened = false;
  private stopped = false;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: ConnectionDeps) {}

  start(): void {
    this.deps.onState({ kind: 'connecting' });
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.abandon();
  }

  private connect(): void {
    if (this.stopped) return;
    const socket = this.deps.openSocket();
    this.socket = socket;
    socket.onopen = () => {
      if (socket !== this.socket) return;
      this.attempt = 0;
      this.deps.guard.clear();
      this.deps.onState({ kind: 'connected' });
      this.armIdle();
      this.deps.onOpen(this.opened);
      this.opened = true;
    };
    socket.onmessage = (event) => {
      if (socket !== this.socket) return;
      this.armIdle();
      const message = parse(event.data);
      if (message !== undefined) this.deps.onMessage(message);
    };
    // 'close' always follows 'error'; recovery starts there.
    socket.onerror = () => undefined;
    socket.onclose = () => {
      if (socket !== this.socket) return;
      this.abandon();
      void this.recover();
    };
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      // A dead connection may take minutes to report 'close', so don't wait for it.
      this.abandon();
      void this.recover();
    }, IDLE_TIMEOUT_MS);
  }

  /** Forgets the current socket so its late events are ignored. */
  private abandon(): void {
    clearTimeout(this.idleTimer);
    const socket = this.socket;
    this.socket = undefined;
    if (socket === undefined) return;
    socket.onopen = socket.onmessage = socket.onclose = null;
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  }

  private isStopped(): boolean {
    return this.stopped;
  }

  private async recover(): Promise<void> {
    if (this.stopped) return;
    const status = await this.deps.checkStatus().catch((): StatusCheck => 'unreachable');
    // stop() may have run while the check was in flight.
    if (this.isStopped()) return;
    if (status === 'unauthorized') {
      if (this.deps.guard.tryReload()) {
        this.deps.onState({ kind: 'reauth' });
        this.deps.reloadPage();
      } else {
        this.deps.onState({ kind: 'login-refused' });
      }
      return;
    }
    if (status === 'ok') this.deps.guard.clear();
    this.attempt++;
    this.deps.onState({ kind: 'retrying', attempt: this.attempt });
    this.retryTimer = setTimeout(
      () => this.connect(),
      backoffDelay(this.attempt, this.deps.random),
    );
  }
}

function parse(data: unknown): WsMessage | undefined {
  if (typeof data !== 'string') return undefined;
  try {
    const result = WsMessageSchema.safeParse(JSON.parse(data));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
