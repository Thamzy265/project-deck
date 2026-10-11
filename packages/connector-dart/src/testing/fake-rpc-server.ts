import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

export type Handler = (params: Record<string, unknown> | undefined) => unknown;

export class RpcFault extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RecordedCall {
  method: string;
  params: Record<string, unknown> | undefined;
  /** Whether the request had a `params` member at all. */
  hadParams: boolean;
}

/**
 * Loopback JSON-RPC server standing in for DTD or a VM service in tests.
 * Handlers return a result, throw RpcFault for a JSON-RPC error, or return a promise.
 */
export class FakeRpcServer {
  readonly calls: RecordedCall[] = [];
  private readonly wss: WebSocketServer;
  private readonly handlers = new Map<string, Handler>();
  /** Called after a successful streamListen, e.g. to replay history like DDS does. */
  onStreamListen: (streamId: string, send: (params: unknown) => void) => void = () => undefined;

  private constructor(
    wss: WebSocketServer,
    readonly path: string,
  ) {
    this.wss = wss;
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        void this.onMessage(ws, data as Buffer);
      });
    });
  }

  static async start(path = '/auth-code'): Promise<FakeRpcServer> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    return new FakeRpcServer(wss, path);
  }

  get uri(): string {
    const { port } = this.wss.address() as AddressInfo;
    return `ws://127.0.0.1:${port}${this.path}`;
  }

  handle(method: string, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }

  /** Sends a `streamNotify` notification to every connected client. */
  notify(params: unknown): void {
    const message = JSON.stringify({ jsonrpc: '2.0', method: 'streamNotify', params });
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  }

  get clientCount(): number {
    return this.wss.clients.size;
  }

  /** Drops every client connection, as when the app or DTD exits. */
  disconnectAll(): void {
    for (const client of this.wss.clients) client.terminate();
  }

  close(): Promise<void> {
    this.disconnectAll();
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }

  private async onMessage(ws: WebSocket, data: Buffer): Promise<void> {
    const req = JSON.parse(data.toString('utf8')) as {
      id: number;
      method: string;
      params?: Record<string, unknown>;
    };
    this.calls.push({ method: req.method, params: req.params, hadParams: 'params' in req });
    const send = (body: object): void =>
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...body }));
    const handler = this.handlers.get(req.method);
    if (handler === undefined) {
      send({ error: { code: -32601, message: `Method not found: ${req.method}` } });
      return;
    }
    try {
      send({ result: await handler(req.params) });
      if (req.method === 'streamListen' && typeof req.params?.streamId === 'string') {
        this.onStreamListen(req.params.streamId, (params) => {
          ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'streamNotify', params }));
        });
      }
    } catch (err) {
      const fault = err instanceof RpcFault ? err : new RpcFault(-32603, String(err));
      send({ error: { code: fault.code, message: fault.message } });
    }
  }
}
