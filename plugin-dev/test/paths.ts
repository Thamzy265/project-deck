import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This folder: the plugin's tests, eval cases and dev config, never installed by users. */
export const DEV = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The shipped plugin: the only folder the public marketplace entry installs. */
export const PLUGIN = resolve(DEV, '..', 'plugin');
export const REPO = resolve(DEV, '..');
