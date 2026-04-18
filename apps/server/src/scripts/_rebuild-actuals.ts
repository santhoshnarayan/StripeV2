// Fast actuals-only projection rebuild — runs locally against whatever DB
// $DATABASE_URL points to. Use `railway run` to hit prod.
//
//   cd apps/server
//   railway run pnpm exec tsx src/scripts/_rebuild-actuals.ts founders-league
import { enqueueProjectionRebuild } from "../lib/projections/rebuild.js";
import { db, nbaProjectionJob } from "@repo/db";
import { eq } from "drizzle-orm";

async function main() {
  const leagueId = process.argv[2];
  if (!leagueId) {
    console.error("usage: _rebuild-actuals.ts <leagueId>");
    process.exit(1);
  }
  console.log(`[rebuild-actuals] starting for leagueId=${leagueId}`);
  const start = Date.now();
  const jobId = await enqueueProjectionRebuild({
    leagueId,
    requestedByUserId: null,
    mode: "actuals-only",
  });
  console.log(`[rebuild-actuals] jobId=${jobId}`);

  while (true) {
    await new Promise((r) => setTimeout(r, 1000));
    const rows = await db
      .select()
      .from(nbaProjectionJob)
      .where(eq(nbaProjectionJob.id, jobId))
      .limit(1);
    const job = rows[0];
    if (!job) continue;
    const secs = ((Date.now() - start) / 1000).toFixed(1);
    console.log(
      `[${secs}s] status=${job.status} processed=${job.processedEvents}/${job.totalEvents ?? "?"}`,
    );
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
