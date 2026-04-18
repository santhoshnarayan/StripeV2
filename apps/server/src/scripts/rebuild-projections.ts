import { db, league, nbaEventProjection, nbaProjectionJob } from "@repo/db";
import { eq } from "drizzle-orm";
import { enqueueProjectionRebuild } from "../lib/projections/rebuild.js";

const LEAGUE_ID = process.argv[2] ?? "founders-league";
const MODE = (process.argv[3] as "full" | "incremental" | undefined) ?? "full";

async function main() {
  const row = (
    await db.select().from(league).where(eq(league.id, LEAGUE_ID)).limit(1)
  )[0];
  if (!row) throw new Error(`league ${LEAGUE_ID} not found`);

  const existingCount = (
    await db
      .select()
      .from(nbaEventProjection)
      .where(eq(nbaEventProjection.leagueId, LEAGUE_ID))
  ).length;
  console.log(`league: ${row.name} (${row.id})`);
  console.log(`existing projection rows: ${existingCount}`);
  console.log(`mode: ${MODE}`);

  const jobId = await enqueueProjectionRebuild({
    leagueId: LEAGUE_ID,
    requestedByUserId: null,
    mode: MODE,
  });
  console.log(`\nenqueued jobId: ${jobId}`);

  // Poll until done.
  const started = Date.now();
  while (true) {
    await new Promise((r) => setTimeout(r, 2000));
    const j = (
      await db
        .select()
        .from(nbaProjectionJob)
        .where(eq(nbaProjectionJob.id, jobId))
        .limit(1)
    )[0];
    if (!j) {
      console.log("job disappeared");
      process.exit(1);
    }
    const elapsed = Math.round((Date.now() - started) / 1000);
    process.stdout.write(
      `\r[${elapsed}s] ${j.status}  ${j.processedEvents}/${j.totalEvents ?? "?"}`.padEnd(80),
    );
    if (j.status === "completed" || j.status === "failed") {
      process.stdout.write("\n");
      if (j.status === "failed") {
        console.error("lastError:", j.lastError);
        process.exit(1);
      }
      break;
    }
  }

  // Summarize results.
  const rows = await db
    .select()
    .from(nbaEventProjection)
    .where(eq(nbaEventProjection.leagueId, LEAGUE_ID));
  console.log(`\nfinal projection rows: ${rows.length}`);
  if (rows.length > 0) {
    const last = rows[rows.length - 1];
    console.log(`\nlast event (${last.updatedAtEvent.toISOString()}, kind=${last.kind}):`);
    console.log("  eventMeta:", JSON.stringify(last.eventMeta, null, 2));
    console.log("  actualPoints:", JSON.stringify(last.actualPoints, null, 2));
    console.log("  projectedPoints (summary):");
    const proj = last.projectedPoints as Record<
      string,
      { mean: number; winProb: number }
    >;
    for (const [uid, v] of Object.entries(proj)) {
      console.log(
        `    ${uid.slice(0, 8)}  mean=${v.mean.toFixed(1)}  winProb=${(v.winProb * 100).toFixed(1)}%`,
      );
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
