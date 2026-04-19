import cron, { type ScheduledTask } from "node-cron";
import { db, cronJob } from "@repo/db";
import { eq, sql } from "drizzle-orm";
import { BUILTIN_JOBS, getHandler, type CronDefinition } from "./registry.js";
import { runScoreboardSync } from "./jobs/nba-live.js";

// Active node-cron tasks keyed by job id. Used so pause/resume/update can
// stop and replace a scheduled task without restarting the process.
const active = new Map<string, ScheduledTask>();

async function seedBuiltinJobs(): Promise<void> {
  // Insert rows for any builtin that isn't in the DB yet. Existing rows are
  // left alone so admin edits to schedule/enabled persist across deploys.
  for (const def of BUILTIN_JOBS) {
    await db
      .insert(cronJob)
      .values({
        id: def.id,
        name: def.name,
        description: def.description,
        schedule: def.schedule,
        enabled: true,
      })
      .onConflictDoNothing({ target: cronJob.id });
  }
}

function scheduleJob(row: { id: string; schedule: string }): void {
  const handler = getHandler(row.id);
  if (!handler) {
    console.warn(`[cron] no handler registered for job "${row.id}" — skipping`);
    return;
  }
  if (!cron.validate(row.schedule)) {
    console.warn(
      `[cron] invalid schedule "${row.schedule}" for job "${row.id}" — skipping`,
    );
    return;
  }
  const task = cron.schedule(row.schedule, () => {
    void runJob(row.id);
  });
  active.set(row.id, task);
}

export async function runJob(id: string): Promise<void> {
  const handler = getHandler(id);
  if (!handler) return;
  const startedAt = new Date();
  await db
    .update(cronJob)
    .set({ lastStatus: "running", updatedAt: new Date() })
    .where(eq(cronJob.id, id));
  try {
    await handler();
    const durationMs = Date.now() - startedAt.getTime();
    await db
      .update(cronJob)
      .set({
        lastStatus: "success",
        lastRunAt: startedAt,
        lastDurationMs: durationMs,
        lastError: null,
        runCount: sql`${cronJob.runCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(cronJob.id, id));
  } catch (err) {
    const durationMs = Date.now() - startedAt.getTime();
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[cron] job "${id}" failed:`, message);
    await db
      .update(cronJob)
      .set({
        lastStatus: "failure",
        lastRunAt: startedAt,
        lastDurationMs: durationMs,
        lastError: message.slice(0, 2000),
        runCount: sql`${cronJob.runCount} + 1`,
        failureCount: sql`${cronJob.failureCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(cronJob.id, id));
  }
}

// Stop any currently-active node-cron task for this id. Safe to call even if
// no task is active.
export function stopJob(id: string): void {
  const task = active.get(id);
  if (task) {
    task.stop();
    active.delete(id);
  }
}

// Re-read this job's row and (re)schedule it. Call after mutating schedule
// or enabled flag so the change takes effect without a server restart.
export async function rescheduleJob(id: string): Promise<void> {
  stopJob(id);
  const rows = await db.select().from(cronJob).where(eq(cronJob.id, id));
  const row = rows[0];
  if (!row) return;
  if (!row.enabled) return;
  scheduleJob(row);
}

export async function startCronJobs(): Promise<void> {
  await seedBuiltinJobs();
  const rows = await db.select().from(cronJob);
  for (const row of rows) {
    if (!row.enabled) continue;
    scheduleJob(row);
  }
  // Kick off an initial scoreboard sync on boot so we have data immediately.
  // This is intentionally outside the registry — we always want it on boot.
  void runScoreboardSync();
  console.log(
    `[cron] started ${active.size} of ${rows.length} jobs (rest disabled)`,
  );
}

export type CronJobRow = typeof cronJob.$inferSelect;
export { BUILTIN_JOBS };
export type { CronDefinition };
