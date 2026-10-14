/** Protocol pings find dead clients; browsers can't see pings, so a message goes too. */
export const PING_INTERVAL_MS = 15_000;
export const PONG_TIMEOUT_MS = 10_000;
export const HEARTBEAT_MESSAGE = JSON.stringify({ type: 'heartbeat' });

/** The part of a `ws` WebSocket the heartbeat uses. */
export interface HeartbeatSocket {
  ping(): void;
  send(data: string): void;
  terminate(): void;
  on(event: 'pong' | 'close', cb: () => void): unknown;
  off(event: 'pong' | 'close', cb: () => void): unknown;
}

export interface HeartbeatOptions {
  intervalMs?: number;
  pongTimeoutMs?: number;
}

/**
 * Every interval: send the heartbeat message and a ping; terminate if no pong follows
 * within the timeout. Timers are unref'd (they never keep the process alive) and
 * cleared on close. Returns a function that stops it.
 */
export function startHeartbeat(socket: HeartbeatSocket, opts: HeartbeatOptions = {}): () => void {
  const intervalMs = opts.intervalMs ?? PING_INTERVAL_MS;
  const pongTimeoutMs = opts.pongTimeoutMs ?? PONG_TIMEOUT_MS;
  let pongTimer: NodeJS.Timeout | undefined;

  const clearPong = (): void => {
    if (pongTimer !== undefined) clearTimeout(pongTimer);
    pongTimer = undefined;
  };
  const stop = (): void => {
    clearInterval(interval);
    clearPong();
    socket.off('pong', clearPong);
    socket.off('close', stop);
  };
  const kill = (): void => {
    stop();
    socket.terminate();
  };

  const interval = setInterval(() => {
    try {
      socket.send(HEARTBEAT_MESSAGE);
      socket.ping();
    } catch {
      kill();
      return;
    }
    // One outstanding ping at a time: a slow pong mustn't stack timers.
    if (pongTimer === undefined) {
      pongTimer = setTimeout(kill, pongTimeoutMs);
      pongTimer.unref();
    }
  }, intervalMs);
  interval.unref();

  socket.on('pong', clearPong);
  socket.on('close', stop);
  return stop;
}
