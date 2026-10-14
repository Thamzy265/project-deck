import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(path)));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

describe('package boundaries (CLAUDE.md: packages depend on core)', () => {
  it('imports no daemon code; the daemon package is only resolved to a file path', async () => {
    const offenders: string[] = [];
    for (const file of await sources(SRC)) {
      const text = await readFile(file, 'utf8');
      if (/from '@project-deck\/daemon[^']*'|import\('@project-deck\/daemon/.test(text)) {
        offenders.push(file.slice(SRC.length));
      }
    }
    expect(offenders).toEqual([]);
  });
});
