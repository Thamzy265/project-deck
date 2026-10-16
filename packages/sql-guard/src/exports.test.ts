import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// Resolved by package name from the built package, the way other packages import it.
async function importByName(specifier: string): Promise<string> {
  const script = `const m = await import(${JSON.stringify(specifier)}); console.log(Object.keys(m).sort().join(','));`;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', script],
    { cwd: fileURLToPath(new URL('..', import.meta.url)) },
  );
  return stdout.trim();
}

describe('package exports', () => {
  it('serves the gate at the package root', async () => {
    expect((await importByName('@project-deck/sql-guard')).split(',')).toContain('createSqlGuard');
  });

  it('serves FakeSqlGuard at @project-deck/sql-guard/testing', async () => {
    expect((await importByName('@project-deck/sql-guard/testing')).split(',')).toContain(
      'FakeSqlGuard',
    );
  });
});
