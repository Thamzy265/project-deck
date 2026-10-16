import WebSocket from 'ws';

export class JsonRpcError extends Error {
  constructor(
    /** Undefined when the peer sent no numeric code: that must not pass for a real -32603. */
    readonly code: number | undefined,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export class ConnectionClosedError extends Error {
  constructor() {
    super('Connection closed');
  }
}

export class CallTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`${method} timed out after ${timeoutMs} ms`);
  }
}

export interface JsonRpcClientOptions {
  /** Per-call timeout. Reloads can take a while on big apps. */
  timeoutMs?: number;
  /** How long to wait for the WebSocket handshake. */
  connectTimeoutMs?: number;
  /** Aborts a handshake still in progress (e.g. on shutdown). Ignored once connected. */
  signal?: AbortSignal;
  /** Told when a notification or close listener throws. The error never reaches the socket. */
  onListenerError?: (err: unknown) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

/** Only loopback endpoints are ever contacted, whatever a pid file or user says. */
export function isLoopbackWsUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    return (
      (url.protocol === 'ws:' || url.protocol === 'wss:') &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

/** Builds an error from whatever the peer sent: a well-formed error object or anything else. */
function toJsonRpcError(error: unknown): JsonRpcError {
  if (typeof error !== 'object' || error === null) {
    return new JsonRpcError(undefined, typeof error === 'string' ? error : 'Unknown error');
  }
  const e = error as { code?: unknown; message?: unknown; data?: unknown };
  return new JsonRpcError(
    typeof e.code === 'number' ? e.code : undefined,
    typeof e.message === 'string' ? e.message : 'Unknown error',
    e.data,
  );
}

/**
 * Minimal JSON-RPC 2.0 client over WebSocket, enough for DTD and the VM service.
 * We never register services, so incoming requests are answered with "method not found".
 */
export class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationListeners = new Map<string, Set<(params: unknown) => void>>();
  private readonly closeListeners = new Set<() => void>();
  private isClosed = false;

  private constructor(
    private readonly ws: WebSocket,
    private readonly timeoutMs: number,
    private readonly onListenerError: (err: unknown) => void,
  ) {
    ws.on('message', (data) => {
      this.onMessage(data as Buffer);
    });
    // A listener must exist or a socket error would crash the process.
    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
      this.handleClose();
    });
  }

  static connect(uri: string, opts: JsonRpcClientOptions = {}): Promise<JsonRpcClient> {
    if (!isLoopbackWsUri(uri)) {
      return Promise.reject(new Error('Refusing to connect to a non-loopback address'));
    }
    const { signal } = opts;
    if (signal?.aborted === true) return Promise.reject(new ConnectionClosedError());
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(uri, {
        handshakeTimeout: opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      });
      const onAbort = (): void => fail(new ConnectionClosedError());
      const fail = (err: Error): void => {
        signal?.removeEventListener('abort', onAbort);
        ws.removeAllListeners();
        ws.on('error', () => undefined);
        ws.terminate();
        reject(err);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      ws.once('error', fail);
      ws.once('unexpected-response', (_req, res) => {
        fail(new Error(`Handshake rejected with HTTP ${res.statusCode ?? 0}`));
      });
      ws.once('open', () => {
        signal?.removeEventListener('abort', onAbort);
        ws.removeAllListeners();
        resolve(
          new JsonRpcClient(
            ws,
            opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            opts.onListenerError ?? (() => undefined),
          ),
        );
      });
    });
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /**
   * Omit `params` for methods that take none: DTD rejects an empty object.
   * `opts.timeoutMs` replaces the client's timeout for this call.
   */
  call(
    method: string,
    params?: Record<string, unknown>,
    opts: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    // While CLOSING, ws drops sends silently and a dead peer may take long to finish the close.
    if (this.isClosed || this.ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new ConnectionClosedError());
    const id = this.nextId++;
    const message =
      params === undefined
        ? { jsonrpc: '2.0', id, method }
        : { jsonrpc: '2.0', id, method, params };
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CallTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(message), (err) => {
        // ws may pass null on success at runtime, whatever the types say.
        if (!(err instanceof Error) || !this.pending.has(id)) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new ConnectionClosedError());
      });
    });
  }

  onNotification(method: string, cb: (params: unknown) => void): () => void {
    let set = this.notificationListeners.get(method);
    if (set === undefined) {
      set = new Set();
      this.notificationListeners.set(method, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }

  onClose(cb: () => void): () => void {
    if (this.isClosed) {
      queueMicrotask(cb);
      return () => undefined;
    }
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  close(): void {
    this.ws.close();
    // Don't wait for the close handshake; a dead peer may never answer.
    this.handleClose();
  }

  private onMessage(data: Buffer): void {
    // close() returns before the handshake ends; frames still arriving meanwhile are dropped.
    if (this.isClosed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as {
      id?: unknown;
      method?: unknown;
      params?: unknown;
      result?: unknown;
      error?: unknown;
    };

    if (typeof m.method === 'string') {
      if (m.id === undefined) {
        for (const cb of [...(this.notificationListeners.get(m.method) ?? [])])
          this.runListener(() => cb(m.params));
      } else {
        this.ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: m.id,
            error: { code: -32601, message: 'Method not found' },
          }),
        );
      }
      return;
    }

    if (typeof m.id !== 'number') return;
    const pending = this.pending.get(m.id);
    if (pending === undefined) return;
    this.pending.delete(m.id);
    clearTimeout(pending.timer);
    // JSON-RPC 1.0 style peers send `"error": null` alongside a successful result.
    if (m.error === undefined || m.error === null) {
      pending.resolve(m.result);
    } else {
      pending.reject(toJsonRpcError(m.error));
    }
  }

  private handleClose(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new ConnectionClosedError());
    }
    this.pending.clear();
    for (const cb of [...this.closeListeners]) this.runListener(cb);
    this.closeListeners.clear();
  }

  /** Listeners run inside ws event handlers, where a throw would crash the process. */
  private runListener(cb: () => void): void {
    try {
      cb();
    } catch (err) {
      try {
        this.onListenerError(err);
      } catch {
        // A failing error reporter must not crash the process either.
      }
    }
  }
}
