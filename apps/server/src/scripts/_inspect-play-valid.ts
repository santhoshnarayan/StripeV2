import { db, nbaGame, nbaPlay, closeDb } from "@repo/db";
import { sql, eq, and, isNull } from "drizzle-orm";

/** Diagnostic: how many nba_play rows are missing .valid, by game? */
async function main() {
  const totals = await db
    .select({
      total: sql<number>`count(*)::int`,
      nulls: sql<number>`count(*) FILTER (WHERE ${nbaPlay.valid} IS NULL)::int`,
      trues: sql<number>`count(*) FILTER (WHERE ${nbaPlay.valid} = true)::int`,
      falses: sql<number>`count(*) FILTER (WHERE ${nbaPlay.valid} = false)::int`,
    })
    .from(nbaPlay);

  const t = totals[0];
  console.log("=== nba_play.valid overall ===");
  console.log(`  total=${t.total} null=${t.nulls} true=${t.trues} false=${t.falses}`);
  console.log();

  const perGame = await db
    .select({
      gameId: nbaPlay.gameId,
      status: nbaGame.status,
      seriesKey: nbaGame.seriesKey,
      total: sql<number>`count(*)::int`,
      nulls: sql<number>`count(*) FILTER (WHERE ${nbaPlay.valid} IS NULL)::int`,
    })
    .from(nbaPlay)
    .innerJoin(nbaGame, eq(nbaPlay.gameId, nbaGame.id))
    .groupBy(nbaPlay.gameId, nbaGame.status, nbaGame.seriesKey);

  const gamesNeedingBackfill = perGame.filter((g) => g.nulls > 0);
  console.log(
    `Games with NULL valid rows: ${gamesNeedingBackfill.length} of ${perGame.length} total`,
  );
  const playoffNeeding = gamesNeedingBackfill.filter((g) => g.seriesKey !== null);
  console.log(
    `  ...of which playoff (seriesKey IS NOT NULL): ${playoffNeeding.length}`,
  );
  const postNeeding = gamesNeedingBackfill.filter(
    (g) => g.seriesKey !== null && g.status === "post",
  );
  console.log(`  ...of which playoff + status=post: ${postNeeding.length}`);
  console.log();

  if (postNeeding.length > 0) {
    console.log("Sample (up to 10):");
    for (const g of postNeeding.slice(0, 10)) {
      console.log(
        `  ${g.gameId} series=${g.seriesKey} nulls=${g.nulls}/${g.total}`,
      );
    }
  }

  // Also count games with ZERO plays (won't be covered by above query):
  const zeroPlay = await db
    .select({
      id: nbaGame.id,
      status: nbaGame.status,
      seriesKey: nbaGame.seriesKey,
    })
    .from(nbaGame)
    .where(
      and(
        isNull(
          sql`(SELECT 1 FROM ${nbaPlay} WHERE ${nbaPlay.gameId} = ${nbaGame.id} LIMIT 1)`,
        ),
        eq(nbaGame.status, "post"),
      ),
    );
  console.log(`\nPost games with zero stored plays: ${zeroPlay.length}`);

  await closeDb();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
