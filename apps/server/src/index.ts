import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { createYoga } from "graphql-yoga";
import { schema } from "./graphql/schema.js";
import { auth } from "./auth.js";
import { startCronJobs } from "./cron/index.js";
import { startWorker } from "./tasks/queue.js";

const app = new Hono();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  })
);

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// Better Auth
app.on(["POST", "GET"], "/api/auth/**", (c) => {
  return auth.handler(c.req.raw);
});

// GraphQL Yoga
const yoga = createYoga({ schema });
app.on(["GET", "POST"], "/graphql", async (c) => {
  const response = await yoga.handle(c.req.raw);
  return response;
});

// Start background services
startCronJobs();

if (process.env.REDIS_URL) {
  startWorker();
}

const port = parseInt(process.env.PORT || "4000", 10);

serve({ fetch: app.fetch, port }, () => {
  console.log(`Server running on http://localhost:${port}`);
});
