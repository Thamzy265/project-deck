/**
 * `.flutterdeck/config.json` as `init` writes it: a new file gets the version, the port
 * and the app ids init found; an existing one only gains what it lacks (the port, an app
 * id), every other setting and its layout kept.
 */
import { CONFIG_VERSION } from '@project-deck/core';
import type { JSONPath } from 'jsonc-parser';
import { setJsonValue } from './text-format.js';

/** App ids init read from the project, already checked against config's patterns. */
export interface AppIds {
  applicationId?: string | undefined;
  bundleId?: string | undefined;
}

export function newConfigText(port: number, ids: AppIds = {}): string {
  const config = {
    version: CONFIG_VERSION,
    port,
    ...(ids.applicationId === undefined ? {} : { android: { applicationId: ids.applicationId } }),
    ...(ids.bundleId === undefined ? {} : { ios: { bundleId: ids.bundleId } }),
  };
  return JSON.stringify(config, null, 2) + '\n';
}

/** `text` must already be a valid config (readConfig accepted it). */
export function withPort(text: string, port: number): string {
  return withValues(text, [[['port'], port]]);
}

/** Sets each value in turn; `text` must already be a valid config. */
export function withValues(
  text: string,
  values: readonly (readonly [JSONPath, unknown])[],
): string {
  // readConfig accepts a byte order mark; keep it where it was.
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  let body = text.slice(bom.length);
  for (const [path, value] of values) body = setJsonValue(body, path, value);
  return bom + body;
}
