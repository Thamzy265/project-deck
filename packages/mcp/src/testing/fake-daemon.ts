/**
 * A stand-in for the daemon's HTTP API on a real local socket, for tests of the MCP
 * server. Routes answer with canned JSON; every request is recorded.
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Health, LogsResult, Status } from '@project-deck/core';
import { writeRuntime } from '@project-deck/core/node';

export interface FakeRequest {
  method: string;
  path: string;
  /** Lower-case header names, as Node gives them. */
  headers: Record<string, string | string[] | undefined>;
}

export interface FakeAnswer {
  status: number;
  body: unknown;
}

/** Returns an answer, or `'hang'` to never answer (for timeout tests). */
export type FakeRoute = (req: FakeRequest) => FakeAnswer | 'hang';

/** The project id the fake daemon reports; tests give their clients the same one. */
export const FAKE_PROJECT_ID = 'aaaaaaaaaaaa';

export const FAKE_STATUS: Status = {
  version: '0.0.0',
  dashboardUrl: 'http://127.0.0.1:9147/',
  projectName: 'shop_app',
  discovering: false,
  apps: [],
  attached: null,
};

export class FakeDaemon {
  readonly requests: FakeRequest[] = [];
  readonly routes = new Map<string, FakeRoute>();
  health: Health = { ok: true, name: 'project-deck', version: '0.0.0', projectId: FAKE_PROJECT_ID };
  status: Status = FAKE_STATUS;
  logs: LogsResult = { entries: [], truncated: false };

  private constructor(
    private readonly server: Server,
    readonly port: number,
    readonly token: string,
  ) {}

  /** Listens on a free 127.0.0.1 port and writes runtime.json for `projectDir`. */
  static async start(projectDir: string): Promise<FakeDaemon> {
    // The server exists before the fake that answers its requests.
    const holder: { fake?: FakeDaemon } = {};
    const server = createServer((req, res) => holder.fake?.handle(req, res));
    server.on('error', () => undefined);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const token = randomBytes(32).toString('base64url');
    const fake = new FakeDaemon(server, port, token);
    holder.fake = fake;
    await writeRuntime(projectDir, { pid: process.pid, port, token, startedAt: Date.now() });
    return fake;
  }

  route(method: string, path: string, answer: FakeRoute): this {
    this.routes.set(`${method} ${path}`, answer);
    return this;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const request: FakeRequest = {
      method: req.method ?? 'GET',
      path: url.pathname + url.search,
      headers: req.headers,
    };
    this.requests.push(request);
    const answer = this.answer(request, url.pathname);
    if (answer === 'hang') return;
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer.body));
  }

  private answer(req: FakeRequest, pathname: string): FakeAnswer | 'hang' {
    const custom = this.routes.get(`${req.method} ${pathname}`);
    if (custom !== undefined) return custom(req);
    if (pathname === '/api/health') return { status: 200, body: this.health };
    if (req.headers['x-deck-token'] !== this.token) {
      return { status: 401, body: { error: 'Missing or invalid token' } };
    }
    if (req.method === 'GET' && pathname === '/api/status')
      return { status: 200, body: this.status };
    if (req.method === 'GET' && pathname === '/api/logs') return { status: 200, body: this.logs };
    if (req.method === 'POST' && pathname === '/api/login-window') {
      return { status: 200, body: { ok: true, until: Date.now() + 120_000 } };
    }
    return { status: 404, body: { error: 'Not found' } };
  }
}
