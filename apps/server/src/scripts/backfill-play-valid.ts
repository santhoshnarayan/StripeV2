import { db, nbaGame, nbaPlay, closeDb } from "@repo/db";
import { getGamePlayByPlay } from "../lib/espn-nba/client.js";
import { sql, eq, and, isNull } from "drizzle-orm";

/**
 * Backfill nba_play.valid from ESPN for games that have NULL valid rows.
 *
 * Scope: games with seriesKey IS NOT NULL (playoff series — play-in + rounds)
 * and status='post'. One PBP call per game; we match plays by id and issue a
 * single multi-row UPDATE per game using a VALUES table.
 *
 * --dry          Don't write, just report
 * --limit=N      Process at most N games (for smoke-testing)
 * --game=ID      Only process one specific game id
 */

function parseArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.find((a) => a.startsWith(prefix));
  return match?.slice(prefix.length);
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const dry = hasFlag("dry");
  const limit = parseArg("limit") ? parseInt(parseArg("limit")!, 10) : undefined;
  const onlyGame = parseArg("game");

  // Find games with NULL valid rows. seriesKey + post filter keeps us on data
  // the projection sim actually reads (loadPlays uses seriesKey IS NOT NULL).
  const candidates = await db
    .select({
      gameId: nbaGame.id,
      awayTeam: nbaGame.awayTeamAbbrev,
      homeTeam: nbaGame.homeTeamAbbrev,
      nulls: sql<number>`count(${nbaPlay.id}) FILTER (WHERE ${nbaPlay.valid} IS NULL)::int`,
      total: sql<number>`count(${nbaPlay.id})::int`,
    })
    .from(nbaGame)
    .leftJoin(nbaPlay, eq(nbaPlay.gameId, nbaGame.id))
    .where(
      and(
        eq(nbaGame.status, "post"),
        sql`${nbaGame.seriesKey} IS NOT NULL`,
        onlyGame ? eq(nbaGame.id, onlyGame) : sql`true`,
      ),
    )
    .groupBy(nbaGame.id, nbaGame.awayTeamAbbrev, nbaGame.homeTeamAbbrev)
    .having(sql`count(${nbaPlay.id}) FILTER (WHERE ${nbaPlay.valid} IS NULL) > 0`);

  const targets = limit ? candidates.slice(0, limit) : candidates;
  console.log(
    `[backfill-valid] ${candidates.length} games need backfill${
      limit ? ` (processing first ${targets.length})` : ""
    }${dry ? " [DRY RUN]" : ""}`,
  );

  let gamesOk = 0;
  let gamesFail = 0;
  let playsUpdated = 0;
  let playsMissing = 0;

  for (const g of targets) {
    const label = `${g.awayTeam}@${g.homeTeam} (${g.gameId})`;
    try {
      const pbp = await getGamePlayByPlay(g.gameId);
      const updates: Array<{ id: string; valid: boolean }> = [];
      for (const item of pbp.items ?? []) {
        if (!item.id) continue;
        if (typeof item.valid !== "boolean") continue;
        updates.push({ id: item.id, valid: item.valid });
      }

      if (updates.length === 0) {
        console.log(`  ${label}: ESPN returned no typed-valid plays, skipping`);
        gamesOk += 1;
        continue;
      }

      if (!dry) {
        // Single round-trip: UPDATE ... FROM (VALUES ...) WHERE id matches.
        // Drizzle's ${table.col} renders as "table"."col" which Postgres
        // rejects in the SET clause — use unqualified column names.
        const valuesSql = sql.join(
          updates.map((u) => sql`(${u.id}, ${u.valid})`),
          sql`, `,
        );
        const result = await db.execute(sql`
          UPDATE "nba_play"
          SET "valid" = v.valid
          FROM (VALUES ${valuesSql}) AS v(id, valid)
          WHERE "nba_play"."id" = v.id
            AND "nba_play"."valid" IS NULL
        `);
        const affected = (result as unknown as { rowCount?: number }).rowCount ?? updates.length;
        playsUpdated += affected;
        console.log(
          `  ${label}: updated ${affected}/${updates.length} (nulls_before=${g.nulls})`,
        );
      } else {
        console.log(
          `  ${label}: would update up to ${updates.length} (nulls_before=${g.nulls})`,
        );
      }
      gamesOk += 1;

      // Track how many NULLs the game had but ESPN didn't re-return (likely deleted plays).
      if (!dry && updates.length < g.nulls) {
        playsMissing += g.nulls - updates.length;
      }
    } catch (err) {
      gamesFail += 1;
      console.warn(`  ${label}: failed — ${(err as Error).message}`);
    }
    // Be polite to ESPN.
    await new Promise((r) => setTimeout(r, 150));
  }

  console.log(
    `\n[backfill-valid] done. games ok=${gamesOk} fail=${gamesFail} plays_updated=${playsUpdated} plays_espn_missing=${playsMissing}`,
  );

  // Sanity-check leftover NULLs on playoff post games.
  const leftover = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(nbaPlay)
    .innerJoin(nbaGame, eq(nbaPlay.gameId, nbaGame.id))
    .where(
      and(
        isNull(nbaPlay.valid),
        eq(nbaGame.status, "post"),
        sql`${nbaGame.seriesKey} IS NOT NULL`,
      ),
    );
  console.log(`[backfill-valid] leftover NULLs (playoff post): ${leftover[0]?.c ?? 0}`);

  await closeDb();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
