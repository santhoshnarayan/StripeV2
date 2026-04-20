import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { createYoga } from "graphql-yoga";
import { schema } from "./graphql/schema.js";
import { auth } from "./auth.js";
import { appRouter } from "./routes/app.js";
import { adminRouter } from "./routes/admin.js";
import { startCronJobs } from "./cron/index.js";
import { startWorker } from "./tasks/queue.js";
import { recoverAuctions } from "./lib/auction-queue.js";
import { recoverSnakeDrafts } from "./lib/snake-queue.js";
import { recoverProjectionJobs } from "./lib/projections/rebuild.js";

const app = new Hono();

const isProduction = process.env.NODE_ENV === "production";

const trustedOrigins = [
  process.env.FRONTEND_URL,
  "https://nba-player-pool.vercel.app",
  ...(isProduction
    ? []
    : [
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:3002",
        "http://localhost:3003",
      ]),
].filter((origin): origin is string => typeof origin === "string" && origin.length > 0);

// Match Vercel preview/branch deploys for this project only. Format:
// https://stripev2-<slug>-santhoshnarayans-projects.vercel.app
// Scoping to the project prefix + team slug prevents any random *.vercel.app
// deploy from being accepted.
const VERCEL_PREVIEW_RE = /^https:\/\/stripev2-[a-z0-9-]+-santhoshnarayans-projects\.vercel\.app$/;

export function isAllowedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  if (trustedOrigins.includes(origin)) return true;
  return VERCEL_PREVIEW_RE.test(origin);
}

const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;

if (isProduction && !INTERNAL_API_TOKEN) {
  console.warn(
    "[server] INTERNAL_API_TOKEN is not set — backend is publicly reachable. Set it on the host and on the Next.js frontend to restrict access to the proxy.",
  );
}

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: (origin) => (isAllowedOrigin(origin) ? origin! : trustedOrigins[0]),
    credentials: true,
  })
);

// Internal token gate — only applied when INTERNAL_API_TOKEN is configured.
// /health is always allowed so Railway healthchecks keep working.
// When unset (e.g. local dev), all requests pass through so nothing breaks.
app.use("*", async (c, next) => {
  if (c.req.path === "/health") {
    return next();
  }
  if (!INTERNAL_API_TOKEN) {
    return next();
  }
  const provided = c.req.header("x-internal-api-token");
  if (provided !== INTERNAL_API_TOKEN) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
});

// Health check — must remain open for Railway healthchecks
app.get("/health", (c) => c.json({ status: "ok" }));

// Better Auth
app.all("/api/auth/*", (c) => {
  return auth.handler(c.req.raw);
});

// App API
app.route("/api/app", appRouter);

// Admin API (DB inspection + Railway log proxy). Gated by better-auth session
// and a hard-coded admin email allowlist inside the router.
app.route("/api/admin", adminRouter);

// GraphQL Yoga
const yoga = createYoga({ schema });
app.on(["GET", "POST"], "/graphql", async (c) => {
  const response = await yoga.handle(c.req.raw);
  return response;
});

// Start background services
startCronJobs();
recoverAuctions().catch((err) => console.error("[auction] Recovery failed:", err));
recoverSnakeDrafts().catch((err) => console.error("[snake] Recovery failed:", err));
recoverProjectionJobs()
  .then((n) => {
    if (n > 0) console.log(`[projections] marked ${n} zombie job(s) as failed`);
  })
  .catch((err) => console.error("[projections] Recovery failed:", err));

if (process.env.REDIS_URL) {
  startWorker();
}

const port = parseInt(process.env.PORT || "4000", 10);

serve({ fetch: app.fetch, port }, () => {
  console.log(`Server running on http://localhost:${port}`);
});
