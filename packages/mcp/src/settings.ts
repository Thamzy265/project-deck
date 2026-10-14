/**
 * Masking settings from `.flutterdeck/config.json`, read on every call so a change
 * (masking switched back on, say) counts at once, without restarting Claude.
 */
import { ConfigError, readConfig } from '@project-deck/core/node';
import type { MaskSettings } from './mask/masker.js';

export interface LoadedSettings {
  mask: MaskSettings;
  warnings: string[];
}

export async function readMaskSettings(projectDir: string): Promise<LoadedSettings> {
  try {
    const config = await readConfig(projectDir);
    return { mask: { redact: config.logs.redact, rules: config.logs.rules }, warnings: [] };
  } catch (err) {
    // A broken file never switches masking off: keep the built-in patterns.
    const reason = err instanceof ConfigError ? err.message : '.flutterdeck/config.json failed';
    return {
      mask: { redact: true, rules: [] },
      warnings: [`${reason}. Masking uses the built-in patterns only until it is fixed.`],
    };
  }
}
