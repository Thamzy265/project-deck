import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo, Server } from 'node:net';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Registry } from '@project-deck/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startDaemon } from './daemon.js';

// The entrypoint runs top-level code, so it is exercised as a process. CI builds first.
const MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'deck-main-'));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

/**
 * Runs main.js. If `until` appears on stdout the process is sent SIGTERM; if it is
 * still running after `timeoutMs` it is killed and `code` is null.
 */
function runMain(args: string[], until?: string, timeoutMs = 5000): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, '--fake', ...args]);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (until !== undefined && stdout.includes(until)) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, stdout, stderr });
    });
  });
}

function listenFree(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

describe('main.js startup failures', () => {
  it('prints the refusal as one line and exits 1 when a daemon already runs', async () => {
    const d = await startDaemon({ projectDir, registry: new Registry(), port: 0 });
    try {
      const run = await runMain(['--project', projectDir, '--port', '0']);
      expect(run.code).toBe(1);
      expect(run.stdout).toBe('');
      expect(run.stderr).toBe(
        `A project-deck daemon is already running for this project on port ${d.port}\n`,
      );
    } finally {
      await d.stop();
    }
  });

  it('prints a single line without a stack and exits 1 when startup throws', async () => {
    const notADir = join(projectDir, 'file');
    await writeFile(notADir, '');
    const run = await runMain(['--project', notADir, '--port', '0']);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    const lines = run.stderr.split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^project-deck daemon could not start: /);
    expect(run.stderr).not.toMatch(/\n\s+at /);
  });

  it('reports the port fallback on stderr and the chosen URL on stdout', async () => {
    const busy = await listenFree();
    try {
      const port = (busy.address() as AddressInfo).port;
      const run = await runMain(['--project', projectDir, '--port', String(port)], 'Token in');
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(run.stdout);
      const chosen = Number(match?.[1]);
      expect(chosen).not.toBe(port);
      expect(chosen).toBeGreaterThan(0);
      expect(run.stderr).toContain(`Port ${port} is in use; using ${chosen}`);
      expect(run.stdout).not.toContain('in use');
    } finally {
      await new Promise((resolve) => busy.close(resolve));
    }
  });

  it.each(['', 'abc', '0x10', ' 9147', '9147abc', '1e3', '70000'])(
    'rejects --port %j with one line and exit code 2',
    async (bad) => {
      const run = await runMain(['--project', projectDir, '--port', bad], 'Token in');
      expect(run.code).toBe(2);
      expect(run.stdout).toBe('');
      expect(run.stderr).toBe(`Invalid --port: '${bad}' (expected a number from 0 to 65535)\n`);
    },
  );
});
