import { defineConfig } from "drizzle-kit";

const url = (process.env.DATABASE_URL || process.env.PLANETSCALE_URL)!;
// PlanetScale doesn't support sslrootcert param
const cleanUrl = url.replace(/&sslrootcert=[^&]*/g, "").replace("'", "").replace("'", "");

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: cleanUrl,
  },
});
