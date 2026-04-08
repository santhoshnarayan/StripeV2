import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@repo/db";
import * as schema from "@repo/db/schema";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  emailAndPassword: {
    enabled: true,
  },
  trustedOrigins: [process.env.FRONTEND_URL || "http://localhost:3000"],
});

export type Auth = typeof auth;
