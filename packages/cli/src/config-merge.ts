/**
 * `.flutterdeck/config.json` as `init` writes it: a new file gets the version and port;
 * an existing one only gains a missing port, every other setting and its layout kept.
 */
import { CONFIG_VERSION } from '@project-deck/core';
import { setJsonValue } from './text-format.js';

export function newConfigText(port: number): string {
  return JSON.stringify({ version: CONFIG_VERSION, port }, null, 2) + '\n';
}

/** `text` must already be a valid config (readConfig accepted it). */
export function withPort(text: string, port: number): string {
  // readConfig accepts a byte order mark; keep it where it was.
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  return bom + setJsonValue(text.slice(bom.length), ['port'], port);
}
