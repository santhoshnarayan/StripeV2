import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

const rawUrl = (process.env.DATABASE_URL || process.env.PLANETSCALE_URL)!;
// PlanetScale doesn't support sslrootcert param
const connectionString = rawUrl.replace(/&sslrootcert=[^&]*/g, "");

const client = postgres(connectionString, { ssl: "require" });

export const db = drizzle(client, { schema });

export type Database = typeof db;

export * from "./schema/index.js";
