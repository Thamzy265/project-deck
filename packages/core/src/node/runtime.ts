import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { retryWhileBusy } from './fs-retry.js';
import { STATE_DIR, readRegularFile } from './safe-file.js';

/** Per-project state folder. Name still open (see the plan's naming decision). */
export { STATE_DIR };
export const RUNTIME_FILE = 'runtime.json';

export const RuntimeInfoSchema = z.object({
  // pid 0 and negative pids name process groups, which always look alive.
  pid: z.number().int().positive(),
  port: z.number().int(),
  token: z.string().min(32),
  startedAt: z.number(),
});
export type RuntimeInfo = z.infer<typeof RuntimeInfoSchema>;

export function runtimePath(projectDir: string): string {
  return join(projectDir, STATE_DIR, RUNTIME_FILE);
}

/**
 * Writes the file readable by the current user only. The token goes into a fresh
 * 0600 temp file that is renamed into place, so it is never readable through an
 * older file with wider permissions.
 */
export interface WriteRuntimeOptions {
  /** Test seam: the rename that puts the file in place. */
  rename?: (from: string, to: string) => Promise<void>;
}

export async function writeRuntime(
  projectDir: string,
  info: RuntimeInfo,
  opts: WriteRuntimeOptions = {},
): Promise<void> {
  const move = opts.rename ?? rename;
  const path = runtimePath(projectDir);
  await mkdir(join(projectDir, STATE_DIR), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(info, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    // Windows refuses while a client is reading the old file; that takes a moment only.
    await retryWhileBusy(() => move(tmp, path));
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export async function readRuntime(projectDir: string): Promise<RuntimeInfo | undefined> {
  try {
    // Never through a link: a cloned repo could commit one pointing anywhere.
    const text = await readRegularFile(runtimePath(projectDir), { maxBytes: 65_536 });
    const raw: unknown = JSON.parse(text);
    const parsed = RuntimeInfoSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Removes the file only if it still belongs to this daemon. */
export async function removeRuntime(projectDir: string, token: string): Promise<void> {
  const current = await readRuntime(projectDir);
  if (current?.token === token)
    await retryWhileBusy(() => rm(runtimePath(projectDir), { force: true }));
}
