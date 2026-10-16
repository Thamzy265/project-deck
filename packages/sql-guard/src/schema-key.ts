import { createHash } from 'node:crypto';

/** The cache key of a schema: the guard and its worker name a loaded schema by it. */
export function schemaKey(schemaSql: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(schemaSql)).digest('hex');
}
