import { closeDb, db, nbaGame, nbaPlayerGameStats } from "@repo/db";
import { syncGameDetail, syncScoreboard } from "../lib/espn-nba/ingest.js";

/**
 * Backfill all NBA playoff games (ESPN seasontype=3) for the current season
 * into nba_game + nba_player_game_stats + nba_play + nba_win_prob.
 *
 * Approach: iterate day-by-day from --from (default 2026-04-14, the 2025-26
 * play-in opener) to --to (default today) and call syncScoreboard for each.
 * After scoreboard ingest, call syncGameDetail for each game with status "post"
 * or "in" so box scores/PBP/win-prob are filled in.
 */

function parseArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.find((a) => a.startsWith(prefix));
  return match?.slice(prefix.length);
}

function parseDate(s: string): Date {
  // Accept YYYY-MM-DD and treat as local midnight.
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function fmt(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function main() {
  const fromStr = parseArg("from") ?? "2026-04-14";
  const toStr = parseArg("to") ?? fmt(new Date());
  const from = parseDate(fromStr);
  const to = parseDate(toStr);

  console.log(`[backfill] Scanning scoreboards from ${fmt(from)} to ${fmt(to)}`);

  const cursor = new Date(from);
  let dayCount = 0;
  while (cursor <= to) {
    const label = fmt(cursor);
    try {
      const events = await syncScoreboard(new Date(cursor));
      console.log(`[backfill] ${label}: ${events?.length ?? 0} events`);
    } catch (err) {
      console.warn(`[backfill] ${label}: scoreboard failed — ${(err as Error).message}`);
    }
    dayCount += 1;
    cursor.setDate(cursor.getDate() + 1);
    // Small delay to be polite to ESPN (no aggressive hammering).
    await new Promise((r) => setTimeout(r, 150));
  }

  console.log(`[backfill] Scoreboard pass complete across ${dayCount} days.`);

  // Fetch details for every non-pre game we have stored.
  const games = await db.select({ id: nbaGame.id, status: nbaGame.status }).from(nbaGame);
  const needsDetail = games.filter((g) => g.status === "post" || g.status === "in");
  console.log(`[backfill] Hydrating detail for ${needsDetail.length} games...`);

  let ok = 0;
  let fail = 0;
  for (const g of needsDetail) {
    try {
      await syncGameDetail(g.id);
      ok += 1;
      if (ok % 10 === 0) console.log(`[backfill] ...${ok}/${needsDetail.length}`);
    } catch (err) {
      fail += 1;
      console.warn(`[backfill] detail ${g.id} failed — ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  const totalStats = await db.select({ id: nbaPlayerGameStats.gameId }).from(nbaPlayerGameStats);
  console.log(`[backfill] Done. ok=${ok} fail=${fail}. nba_player_game_stats rows=${totalStats.length}`);
}

main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[backfill] Fatal:", err);
    await closeDb();
    process.exit(1);
  });
