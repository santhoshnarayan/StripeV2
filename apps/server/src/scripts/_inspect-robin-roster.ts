import { db, closeDb } from "@repo/db";
import { rosterEntry, user, leagueMember } from "@repo/db/schema";
import { and, asc, eq } from "drizzle-orm";

async function main() {
  const [robin] = await db
    .select({ id: user.id })
    .from(user)
    .innerJoin(leagueMember, eq(leagueMember.userId, user.id))
    .where(and(eq(leagueMember.leagueId, "founders-league"), eq(user.name, "Robin Jiang")));
  console.log("Robin id:", robin?.id);
  const rows = await db
    .select()
    .from(rosterEntry)
    .where(and(eq(rosterEntry.leagueId, "founders-league"), eq(rosterEntry.userId, robin.id)))
    .orderBy(asc(rosterEntry.acquisitionOrder));
  console.log(`\nRobin's rosterEntries (${rows.length}):`);
  for (const r of rows) {
    console.log(
      `  ord=${r.acquisitionOrder} ${r.playerName} $${r.acquisitionBid} round=${r.acquisitionRoundId?.slice(0, 8)}`,
    );
  }
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
