import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/** Per-project state folder. Name still open (see the plan's naming decision). */
export const STATE_DIR = '.flutterdeck';
export const RUNTIME_FILE = 'runtime.json';

export const RuntimeInfoSchema = z.object({
  pid: z.number().int(),
  port: z.number().int(),
  token: z.string().min(32),
  startedAt: z.number(),
});
export type RuntimeInfo = z.infer<typeof RuntimeInfoSchema>;

export function runtimePath(projectDir: string): string {
  return join(projectDir, STATE_DIR, RUNTIME_FILE);
}

/** Writes the file readable by the current user only. */
export async function writeRuntime(projectDir: string, info: RuntimeInfo): Promise<void> {
  const path = runtimePath(projectDir);
  await mkdir(join(projectDir, STATE_DIR), { recursive: true });
  await writeFile(path, JSON.stringify(info, null, 2) + '\n', { mode: 0o600 });
  // writeFile only applies `mode` when it creates the file.
  await chmod(path, 0o600);
}

export async function readRuntime(projectDir: string): Promise<RuntimeInfo | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(runtimePath(projectDir), 'utf8'));
    const parsed = RuntimeInfoSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Removes the file only if it still belongs to this daemon. */
export async function removeRuntime(projectDir: string, token: string): Promise<void> {
  const current = await readRuntime(projectDir);
  if (current?.token === token) await rm(runtimePath(projectDir), { force: true });
}
