import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

const rawUrl = (process.env.DATABASE_URL || process.env.PLANETSCALE_URL)!;
// PlanetScale doesn't support sslrootcert param
const connectionString = rawUrl.replace(/&sslrootcert=[^&]*/g, "");

// Pool sized small + short idle timeout so rolling Railway deploys don't
// temporarily double our connection footprint past PlanetScale's cap.
// Default postgres-js max is 10; at 2 containers that's 20 conns competing
// for PlanetScale's ~22-conn limit, which tips into
// "remaining connection slots are reserved for SUPERUSER" during rollouts.
const client = postgres(connectionString, {
  ssl: "require",
  max: 5,
  idle_timeout: 20,
});

export const db = drizzle(client, { schema });
export const dbClient = client;

export async function closeDb() {
  await client.end();
}

export type Database = typeof db;

export * from "./schema/index.js";
