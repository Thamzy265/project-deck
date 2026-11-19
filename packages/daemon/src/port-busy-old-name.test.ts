/**
 * The port holder is an older checkout's daemon that still says `project-deck` on
 * /api/health (M5 batch 3). It is "another program": the message must not call it a
 * Pitdeck (that would suggest `pitdeck stop`, which can't reach it) or echo its project id.
 */
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { identifyPortHolder } from './port-busy.js';

let server: Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

describe('identifyPortHolder with a pre-release daemon', () => {
  it('treats name project-deck as another program and never echoes its project id', async () => {
    const local = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          name: 'project-deck',
          version: '0.0.0',
          projectId: 'abcdefabcdef',
        }),
      );
    });
    server = local;
    local.on('error', () => undefined);
    await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
    const { port } = local.address() as AddressInfo;
    const err = await identifyPortHolder(port);
    expect(err.holder).toEqual({ kind: 'other' });
    expect(err.message).toContain(`Another program uses port ${port}`);
    expect(err.message).not.toContain('abcdefabcdef');
    expect(err.message).not.toContain('Another Pitdeck');
  });
});
