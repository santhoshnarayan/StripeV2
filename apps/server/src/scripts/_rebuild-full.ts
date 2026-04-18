// Full projection rebuild — re-runs Monte Carlo (2000 sims × N events).
// Run locally so we're not blocked by Railway's single worker.
//
//   cd apps/server
//   railway run pnpm exec tsx src/scripts/_rebuild-full.ts founders-league
import { enqueueProjectionRebuild } from "../lib/projections/rebuild.js";
import { db, nbaProjectionJob } from "@repo/db";
import { eq } from "drizzle-orm";

async function main() {
  const leagueId = process.argv[2];
  if (!leagueId) {
    console.error("usage: _rebuild-full.ts <leagueId>");
    process.exit(1);
  }
  console.log(`[rebuild-full] starting for leagueId=${leagueId}`);
  const start = Date.now();
  const jobId = await enqueueProjectionRebuild({
    leagueId,
    requestedByUserId: null,
    mode: "full",
  });
  console.log(`[rebuild-full] jobId=${jobId}`);

  let lastProcessed = -1;
  while (true) {
    await new Promise((r) => setTimeout(r, 2000));
    const rows = await db
      .select()
      .from(nbaProjectionJob)
      .where(eq(nbaProjectionJob.id, jobId))
      .limit(1);
    const job = rows[0];
    if (!job) continue;
    const secs = ((Date.now() - start) / 1000).toFixed(1);
    if (job.processedEvents !== lastProcessed || job.status !== "running") {
      console.log(
        `[${secs}s] status=${job.status} processed=${job.processedEvents}/${job.totalEvents ?? "?"}`,
      );
      lastProcessed = job.processedEvents;
    }
    if (job.status === "completed" || job.status === "failed") {
      if (job.status === "failed") console.error("lastError:", job.lastError);
      process.exit(job.status === "failed" ? 1 : 0);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
