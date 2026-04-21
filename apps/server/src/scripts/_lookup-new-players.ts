import { db, closeDb, league as leagueTable, leagueMember, user } from "@repo/db";
import { and, eq } from "drizzle-orm";
import {
  auctionConfigFromLeague,
  getPlayerPoolMapForAuction,
} from "../lib/player-pool.js";

async function main() {
  const [leagueRow] = await db.select().from(leagueTable).where(eq(leagueTable.id, "founders-league"));
  const members = await db
    .select({ userId: user.id })
    .from(leagueMember)
    .innerJoin(user, eq(user.id, leagueMember.userId))
    .where(and(eq(leagueMember.leagueId, "founders-league"), eq(leagueMember.status, "active")));
  const pool = await getPlayerPoolMapForAuction(auctionConfigFromLeague(leagueRow, members.length));
  for (const pid of ["2528210", "4066648", "2990992", "2991350", "5105637", "6585"]) {
    const p = pool.get(pid);
    console.log(pid, p?.name, p?.team, "sv=$" + (p?.suggestedValue ?? "?"));
  }
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
