import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index.js';

export type Db = PostgresJsDatabase<typeof schema>;

export function createDb(connectionString: string): { db: Db; close: () => Promise<void> } {
  const client = postgres(connectionString, { max: 10 });
  const db = drizzle(client, { schema });
  return { db, close: () => client.end() };
}

export * as schema from './schema/index.js';
