import WebSocket from 'ws';

export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
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

export interface JsonRpcClientOptions {
  /** Per-call timeout. Reloads can take a while on big apps. */
  timeoutMs?: number;
  /** How long to wait for the WebSocket handshake. */
  connectTimeoutMs?: number;
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
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(uri, {
        handshakeTimeout: opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      });
      const fail = (err: Error): void => {
        ws.removeAllListeners();
        ws.on('error', () => undefined);
        ws.terminate();
        reject(err);
      };
      ws.once('error', fail);
      ws.once('unexpected-response', (_req, res) => {
        fail(new Error(`Handshake rejected with HTTP ${res.statusCode ?? 0}`));
      });
      ws.once('open', () => {
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

  /** Omit `params` for methods that take none: DTD rejects an empty object. */
  call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    // While CLOSING, ws drops sends silently and a dead peer may take long to finish the close.
    if (this.isClosed || this.ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new ConnectionClosedError());
    const id = this.nextId++;
    const message =
      params === undefined
        ? { jsonrpc: '2.0', id, method }
        : { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
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
    if (m.error !== undefined) {
      const e = m.error as { code?: unknown; message?: unknown; data?: unknown };
      pending.reject(
        new JsonRpcError(
          typeof e.code === 'number' ? e.code : -32603,
          typeof e.message === 'string' ? e.message : 'Unknown error',
          e.data,
        ),
      );
    } else {
      pending.resolve(m.result);
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
