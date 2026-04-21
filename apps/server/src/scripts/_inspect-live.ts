import { db, nbaGame, nbaPlay, closeDb } from "@repo/db";
import { sql } from "drizzle-orm";

async function main() {
  const now = new Date();
  const nowMs = now.getTime();
  const fifteenMinFuture = new Date(nowMs + 15 * 60 * 1000);
  const oneHourAgo = new Date(nowMs - 60 * 60 * 1000);
  const thirtyMinAgo = new Date(nowMs - 30 * 60 * 1000);

  const rows = await db
    .select({
      id: nbaGame.id,
      status: nbaGame.status,
      startTime: nbaGame.startTime,
      updatedAt: nbaGame.updatedAt,
      homeTeamAbbrev: nbaGame.homeTeamAbbrev,
      awayTeamAbbrev: nbaGame.awayTeamAbbrev,
      lastPlayAt: sql<Date | null>`(SELECT max(${nbaPlay.wallclock}) FROM ${nbaPlay} WHERE ${nbaPlay.gameId} = ${nbaGame.id})`,
    })
    .from(nbaGame);

  console.log("DEBUG raw row sample:", JSON.stringify(rows[0], null, 2));

  console.log("NOW (UTC):", now.toISOString());
  console.log("oneHourAgo:", oneHourAgo.toISOString());
  console.log("thirtyMinAgo:", thirtyMinAgo.toISOString());
  console.log("fifteenMinFuture:", fifteenMinFuture.toISOString());
  console.log("Total games in table:", rows.length);
  console.log();

  const newTargets: Array<{ id: string; reason: string; teams: string; status: string; lastPlayAt: string | null; startTime: string | null }> = [];
  const oldTargets = new Set<string>();
  const allNewTargets = new Set<string>();

  for (const g of rows) {
    const teams = `${g.awayTeamAbbrev}@${g.homeTeamAbbrev}`;
    const lastPlayISO = g.lastPlayAt ? new Date(g.lastPlayAt).toISOString() : null;
    const startISO = g.startTime ? g.startTime.toISOString() : null;

    // NEW logic
    let includedNew = false;
    let reason = "";
    if (g.status === "in") {
      includedNew = true;
      reason = "in-progress";
    } else if (g.status === "pre" && g.startTime && g.startTime <= fifteenMinFuture && g.startTime >= oneHourAgo) {
      includedNew = true;
      reason = "pre within 15min window";
    } else if (g.status === "post" && g.lastPlayAt && new Date(g.lastPlayAt) >= oneHourAgo) {
      includedNew = true;
      reason = `post within 1h of last play (${lastPlayISO})`;
    }
    if (includedNew) {
      allNewTargets.add(g.id);
      newTargets.push({ id: g.id, reason, teams, status: g.status ?? "?", lastPlayAt: lastPlayISO, startTime: startISO });
    }

    // OLD logic approximation: status=in OR (pre within 15min) OR (post with updatedAt >= 30min ago)
    let includedOld = false;
    if (g.status === "in") includedOld = true;
    else if (g.status === "pre" && g.startTime && g.startTime <= fifteenMinFuture && g.startTime >= oneHourAgo) includedOld = true;
    else if (g.status === "post" && g.updatedAt && g.updatedAt >= thirtyMinAgo) includedOld = true;
    if (includedOld) oldTargets.add(g.id);
  }

  console.log("=== NEW LOGIC INCLUDES ===");
  for (const t of newTargets) {
    console.log(`  ${t.teams} (${t.id}) status=${t.status} — ${t.reason}`);
    console.log(`    startTime=${t.startTime} lastPlayAt=${t.lastPlayAt}`);
  }
  if (newTargets.length === 0) console.log("  (none)");
  console.log();

  console.log("=== OLD LOGIC INCLUDED but NEW excludes ===");
  const dropped = [...oldTargets].filter((id) => !allNewTargets.has(id));
  for (const id of dropped) {
    const g = rows.find((r) => r.id === id)!;
    const teams = `${g.awayTeamAbbrev}@${g.homeTeamAbbrev}`;
    const lastPlayISO = g.lastPlayAt ? new Date(g.lastPlayAt).toISOString() : null;
    console.log(`  ${teams} (${id}) status=${g.status} updatedAt=${g.updatedAt?.toISOString()} lastPlayAt=${lastPlayISO}`);
  }
  if (dropped.length === 0) console.log("  (none)");
  console.log();

  // Diagnostics: is nba_play populated at all? Is wallclock set?
  const playCount = await db.select({ c: sql<number>`count(*)::int` }).from(nbaPlay);
  const playWithWall = await db.select({ c: sql<number>`count(*)::int` }).from(nbaPlay).where(sql`${nbaPlay.wallclock} IS NOT NULL`);
  console.log("nba_play total rows:", playCount[0]?.c, "with wallclock:", playWithWall[0]?.c);

  const maxWallPerGame = await db
    .select({
      gameId: nbaPlay.gameId,
      maxWall: sql<Date | null>`max(${nbaPlay.wallclock})`,
      cnt: sql<number>`count(*)::int`,
    })
    .from(nbaPlay)
    .groupBy(nbaPlay.gameId);
  console.log("Per-game play counts + max wallclock:");
  for (const r of maxWallPerGame) {
    console.log(`  ${r.gameId}: count=${r.cnt} maxWall=${r.maxWall ? new Date(r.maxWall).toISOString() : "null"}`);
  }
  console.log();

  // Also show recent post games for context
  console.log("=== Recent post games (last 6h by lastPlayAt) for context ===");
  const sixHoursAgo = new Date(nowMs - 6 * 60 * 60 * 1000);
  const recentPost = rows
    .filter((r) => r.status === "post" && r.lastPlayAt && new Date(r.lastPlayAt) >= sixHoursAgo)
    .sort((a, b) => new Date(b.lastPlayAt!).getTime() - new Date(a.lastPlayAt!).getTime());
  for (const g of recentPost) {
    const teams = `${g.awayTeamAbbrev}@${g.homeTeamAbbrev}`;
    const lastPlayMs = new Date(g.lastPlayAt!).getTime();
    const deltaMin = Math.round((nowMs - lastPlayMs) / 60000);
    console.log(`  ${teams} (${g.id}) lastPlayAt=${new Date(g.lastPlayAt!).toISOString()} (${deltaMin}m ago) updatedAt=${g.updatedAt?.toISOString()}`);
  }

  await closeDb();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
