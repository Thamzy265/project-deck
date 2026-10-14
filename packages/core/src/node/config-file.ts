import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeckConfig } from '../config.js';
import { CONFIG_VERSION, DEFAULT_CONFIG, DeckConfigSchema } from '../config.js';
import { STATE_DIR } from './runtime.js';

export const CONFIG_FILE = 'config.json';

export function configPath(projectDir: string): string {
  return join(projectDir, STATE_DIR, CONFIG_FILE);
}

/** A config file that exists but can't be used. The daemon refuses to start with it. */
export class ConfigError extends Error {}

/** Reads `.flutterdeck/config.json`; a missing file means the defaults. Never writes the file. */
export async function readConfig(projectDir: string): Promise<DeckConfig> {
  const shown = join(STATE_DIR, CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(configPath(projectDir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_CONFIG;
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
    throw new ConfigError(`${shown} can't be read (${code})`);
  }
  let raw: unknown;
  try {
    // Some Windows editors save UTF-8 with a byte order mark, which JSON.parse refuses.
    raw = JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text);
  } catch (err) {
    throw new ConfigError(`${shown} is not valid JSON: ${(err as Error).message}`);
  }
  const version =
    typeof raw === 'object' && raw !== null ? (raw as { version?: unknown }).version : undefined;
  if (version !== undefined && version !== CONFIG_VERSION) {
    throw new ConfigError(
      `${shown} has version ${JSON.stringify(version)}, but this FlutterDeck reads version ${CONFIG_VERSION}. The file was left unchanged.`,
    );
  }
  const parsed = DeckConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const keys = 'keys' in issue && Array.isArray(issue.keys) ? issue.keys.join(', ') : '';
      const path = [...issue.path.map(String), ...(keys === '' ? [] : [keys])].join('.');
      return `${path === '' ? '(top level)' : path}: ${issue.message}`;
    });
    throw new ConfigError(`${shown} is invalid: ${problems.join('; ')}`);
  }
  return parsed.data;
}
