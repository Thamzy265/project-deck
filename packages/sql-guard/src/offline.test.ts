import { describe, expect, it, vi } from 'vitest';
import { GuardEngine, loadSqlite } from './engine.js';

describe('offline loading', () => {
  it('loads the bundled wasm from disk with no network', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('no network in this test')));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const engine = new GuardEngine(await loadSqlite());
      expect(engine.check('SELECT 1', { schemaSql: [], mode: 'read' })).toMatchObject({ ok: true });
      expect(fetchSpy).not.toHaveBeenCalled();
      engine.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
