import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { createServer as createNetServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HEALTH_PROBE_TIMEOUT_MS, PortBusyError, identifyPortHolder } from './port-busy.js';

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** A local HTTP server that answers every request with `handler`. */
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
  port: number;
  requests: string[];
}> {
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    requests.push(`${req.method ?? ''} ${req.url ?? ''}`);
    handler(req, res);
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => {
    for (const s of sockets) s.destroy();
    return new Promise((r) => server.close(r));
  });
  return { port: (server.address() as AddressInfo).port, requests };
}

function json(body: unknown, status = 200) {
  return (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

async function timed(port: number): Promise<{ err: PortBusyError; ms: number }> {
  const started = performance.now();
  const err = await identifyPortHolder(port);
  return { err, ms: performance.now() - started };
}

const SLOW = HEALTH_PROBE_TIMEOUT_MS + 3000;

describe('identifyPortHolder', () => {
  it('asks only GET /api/health on 127.0.0.1', async () => {
    const { port, requests } = await serve(json({ ok: true, name: 'project-deck' }));
    await identifyPortHolder(port);
    expect(requests).toEqual(['GET /api/health']);
  });

  it(
    'gives up on a server that accepts and never answers, within the probe timeout',
    async () => {
      const { port } = await serve(() => undefined);
      const { err, ms } = await timed(port);
      expect(err.holder).toEqual({ kind: 'other' });
      expect(ms).toBeLessThan(HEALTH_PROBE_TIMEOUT_MS + 1500);
    },
    SLOW + 2000,
  );

  it(
    'gives up on a server that sends headers and then never finishes the body',
    async () => {
      const { port } = await serve((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"ok":true,"name":"project-deck"');
      });
      const { err, ms } = await timed(port);
      expect(err.holder).toEqual({ kind: 'other' });
      expect(ms).toBeLessThan(HEALTH_PROBE_TIMEOUT_MS + 1500);
    },
    SLOW + 2000,
  );

  it(
    'gives up on a raw TCP program that never speaks HTTP',
    async () => {
      const sockets = new Set<Socket>();
      const server = createNetServer((s) => {
        sockets.add(s);
        s.on('error', () => undefined);
        s.write('SSH-2.0-OpenSSH_9.0\r\n');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      cleanups.push(() => {
        for (const s of sockets) s.destroy();
        return new Promise((r) => server.close(r));
      });
      const { err } = await timed((server.address() as AddressInfo).port);
      expect(err.holder).toEqual({ kind: 'other' });
    },
    SLOW + 2000,
  );

  it('calls a server that drops the connection another program', async () => {
    const { port } = await serve((req) => req.socket.destroy());
    expect((await identifyPortHolder(port)).holder).toEqual({ kind: 'other' });
  });

  it('calls a port with nothing listening another program', async () => {
    const { port } = await serve(() => undefined);
    await cleanups.pop()?.();
    expect((await identifyPortHolder(port)).holder).toEqual({ kind: 'other' });
  });

  it.each([
    ['HTML', (_req: IncomingMessage, res: ServerResponse) => res.end('<html>dev server</html>')],
    ['empty 200', (_req: IncomingMessage, res: ServerResponse) => res.end()],
    ['a JSON string', json('project-deck')],
    ['JSON null', json(null)],
    ['another name', json({ ok: true, name: 'vite' })],
    ['the right body on a 500', json({ ok: true, name: 'project-deck' }, 500)],
    ['the right body on a 401', json({ ok: true, name: 'project-deck' }, 401)],
    [
      'a redirect to a FlutterDeck',
      (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(302, { location: 'http://127.0.0.1:1/api/health' });
        res.end();
      },
    ],
  ])('calls a server that returns %s another program', async (_name, handler) => {
    const { port } = await serve(handler);
    const err = await identifyPortHolder(port);
    expect(err).toBeInstanceOf(PortBusyError);
    expect(err.holder).toEqual({ kind: 'other' });
    expect(err.message).toBe(
      `Another program uses port ${port}. Stop it, or pick another port: run \`flutterdeck init\`, or change "port" in .flutterdeck/config.json and the url in .claude/launch.json.`,
    );
  });

  it('never follows a redirect', async () => {
    const target = await serve(json({ ok: true, name: 'project-deck', projectId: 'abcdefabcdef' }));
    const { port } = await serve((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${target.port}/api/health` });
      res.end();
    });
    await identifyPortHolder(port);
    expect(target.requests).toEqual([]);
  });

  it('recognises an older FlutterDeck without a project id', async () => {
    const { port } = await serve(json({ ok: true, name: 'project-deck', version: '0.0.0' }));
    const err = await identifyPortHolder(port);
    expect(err.holder).toEqual({ kind: 'flutterdeck', projectId: undefined });
    expect(err.message).toContain('Another FlutterDeck (project unknown)');
    expect(err.message).toContain('flutterdeck stop');
  });

  it.each([
    ['upper case', 'ABCDEFABCDEF'],
    ['too long', 'abcdefabcdef0'],
    ['a path', '/Users/someone/secret-client'],
    ['terminal escapes', '\u001b[2J\u001b[31mpwned'],
    ['a number', 123456789012],
  ])('never echoes a project id that is %s', async (_name, projectId) => {
    const { port } = await serve(json({ ok: true, name: 'project-deck', projectId }));
    const err = await identifyPortHolder(port);
    expect(err.message).not.toContain(String(projectId));
    expect(err.message).not.toContain('\u001b');
  });

  it('echoes a well-formed project id', async () => {
    const { port } = await serve(
      json({ ok: true, name: 'project-deck', projectId: '0123456789ab' }),
    );
    const err = await identifyPortHolder(port);
    expect(err.holder).toEqual({ kind: 'flutterdeck', projectId: '0123456789ab' });
    expect(err.message).toContain(`Another FlutterDeck (project 0123456789ab) uses port ${port}`);
  });

  it('copes with a large JSON answer', async () => {
    const { port } = await serve(
      json({ ok: true, name: 'project-deck', projectId: '0123456789ab', pad: 'x'.repeat(5e6) }),
    );
    expect((await identifyPortHolder(port)).holder.kind).toBe('flutterdeck');
  });
});
