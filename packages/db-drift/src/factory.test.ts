import { Registry } from '@project-deck/core';
import { FakeAppSession, fakeApp } from '@project-deck/core/testing';
import { describe, expect, it } from 'vitest';
import { DriftInspectorFactory, registerDrift } from './factory.js';
import { FakeDriftApp } from './testing/fake-drift-app.js';

describe('DriftInspectorFactory', () => {
  it('makes an inspector only for sessions with app extensions', async () => {
    const factory = new DriftInspectorFactory();
    expect(await factory.create(fakeApp())).toBeUndefined();
    expect(await factory.create(fakeApp(), new FakeAppSession(fakeApp()))).toBeUndefined();
    const app = new FakeDriftApp();
    const session = new FakeAppSession(fakeApp(), { extensions: app.extensions });
    const db = await factory.create(fakeApp(), session);
    expect(db?.id).toBe('drift');
    expect(await db?.listDatabases()).toEqual([{ name: 'app', backend: 'live' }]);
  });

  it('reads the schema state again after a hot restart of the session', async () => {
    let truncated = false;
    const app = new FakeDriftApp().handle('schema', () => ({
      tables: [],
      sqlSchema: [],
      ...(truncated ? { sqlSchemaTruncated: true } : {}),
    }));
    const session = new FakeAppSession(fakeApp(), { extensions: app.extensions });
    const db = await new DriftInspectorFactory().create(fakeApp(), session);
    await db?.query('app', 'SELECT 1');
    truncated = true;
    await session.reload();
    // A hot reload keeps the isolate and its databases: no new schema read needed.
    await expect(db?.query('app', 'SELECT 1')).resolves.toBeDefined();
    await session.restart();
    await expect(db?.query('app', 'SELECT 1')).rejects.toMatchObject({ code: 'too-large' });
  });

  it('registers through the Registry and allows only its own extension prefix', () => {
    const registry = new Registry();
    const undo = registerDrift(registry);
    expect(registry.dbInspectors.get('drift')).toBeInstanceOf(DriftInspectorFactory);
    expect(registry.extensionPrefixes()).toContain('ext.flutterdeck.drift.v1.');
    undo();
    expect(registry.dbInspectors.get('drift')).toBeUndefined();
    expect(registry.extensionPrefixes()).not.toContain('ext.flutterdeck.drift.v1.');
  });
});
