import type { ReactNode } from 'react';
import { createContext, use } from 'react';
import type { DbClient } from '../api/db-client.js';

const DbContext = createContext<DbClient | undefined>(undefined);

/** Gives the Database tab its `/api/db` client (a fake one in tests). */
export function DbProvider({ client, children }: { client: DbClient; children: ReactNode }) {
  return <DbContext value={client}>{children}</DbContext>;
}

export function useDbClient(): DbClient {
  const client = use(DbContext);
  if (client === undefined) throw new Error('useDbClient needs a DbProvider');
  return client;
}
