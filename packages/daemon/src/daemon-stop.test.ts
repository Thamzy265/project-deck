import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '@project-deck/core';
import { FakeAppConnector, fakeApp } from '@project-deck/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startDaemon } from './daemon.js';
import { runtimePath } from './runtime.js';

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'deck-stop-'));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

class FailingStopConnector extends FakeAppConnector {
  override async stop(): Promise<void> {
    await super.stop();
    throw new Error('connector stop failed');
  }
}

describe('daemon stop', () => {
  it('removes runtime.json and resolves closed even when a connector fails to stop', async () => {
    const registry = new Registry();
    registry.connectors.register(new FailingStopConnector('fake', [fakeApp()]));
    const d = await startDaemon({ projectDir, registry, port: 0, log: () => undefined });
    await access(runtimePath(projectDir));
    await d.stop().catch(() => undefined);
    await expect(access(runtimePath(projectDir))).rejects.toThrow();
    await expect(d.closed).resolves.toBeUndefined();
  });
});
