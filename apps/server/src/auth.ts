import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { Resend } from "resend";
import { db } from "@repo/db";
import * as schema from "@repo/db/schema";

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const fromEmail = process.env.RESEND_FROM_EMAIL || "noreply@resend.dev";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 5,
    sendResetPassword: async ({ user, url }) => {
      if (resend) {
        await resend.emails.send({
          from: fromEmail,
          to: user.email,
          subject: "Reset your password",
          html: `<p>Click <a href="${url}">here</a> to reset your password.</p>`,
        });
      } else {
        console.log(`[auth] Password reset link for ${user.email}: ${url}`);
      }
    },
  },
  trustedOrigins: [
    process.env.FRONTEND_URL || "http://localhost:3000",
    "https://nba-player-pool.vercel.app",
    ...(process.env.NODE_ENV === "production"
      ? []
      : [
          "http://localhost:3000",
          "http://localhost:3001",
          "http://localhost:3002",
          "http://localhost:3003",
        ]),
  ],
});

export type Auth = typeof auth;
