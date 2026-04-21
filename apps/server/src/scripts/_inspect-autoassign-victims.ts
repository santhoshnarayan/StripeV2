import { db, closeDb, league, leagueMember, rosterEntry, user } from "@repo/db";
import { sql, eq } from "drizzle-orm";

/** Who was silently force-assigned players they couldn't afford?
 *
 *  The all-remaining auto-assign block in routes/app.ts skips the maxBid
 *  validity check and uses Math.max(0, budget-1), which lets sum(bids) exceed
 *  budgetPerTeam. Anyone whose final roster totals > budget was affected.
 */
async function main() {
  const leagues = await db.select().from(league);
  for (const L of leagues) {
    const rows = await db
      .select({
        userId: rosterEntry.userId,
        userName: user.name,
        totalSpent: sql<number>`sum(${rosterEntry.acquisitionBid})::int`,
        playerCount: sql<number>`count(*)::int`,
      })
      .from(rosterEntry)
      .innerJoin(leagueMember, eq(rosterEntry.userId, leagueMember.userId))
      .innerJoin(user, eq(user.id, rosterEntry.userId))
      .where(eq(rosterEntry.leagueId, L.id))
      .groupBy(rosterEntry.userId, user.name);

    const affected = rows.filter((r) => r.totalSpent > L.budgetPerTeam);
    const marginal = rows.filter(
      (r) =>
        r.totalSpent <= L.budgetPerTeam &&
        L.budgetPerTeam - r.totalSpent < L.rosterSize - r.playerCount,
    );

    console.log(
      `\n=== league: ${L.name} (${L.id}) budget=$${L.budgetPerTeam} rosterSize=${L.rosterSize} ===`,
    );
    console.log(
      `  ${rows.length} members; ${affected.length} overdrafted, ${marginal.length} marginal (would be affected if still drafting)`,
    );
    for (const r of rows) {
      const over = r.totalSpent - L.budgetPerTeam;
      const tag =
        over > 0
          ? `❌ OVERDRAFT by $${over}`
          : L.budgetPerTeam - r.totalSpent < L.rosterSize - r.playerCount
            ? "⚠ marginal"
            : "ok";
      console.log(
        `  ${r.userName.padEnd(22)} spent=$${r.totalSpent} slots=${r.playerCount}/${L.rosterSize} ${tag}`,
      );
    }

    // For overdrafted members, show their $1 roster entries (likely candidates
    // for the auto-assign force-award).
    for (const a of affected) {
      const dollarEntries = await db
        .select({
          playerName: rosterEntry.playerName,
          bid: rosterEntry.acquisitionBid,
          order: rosterEntry.acquisitionOrder,
        })
        .from(rosterEntry)
        .where(
          sql`${rosterEntry.leagueId} = ${L.id} AND ${rosterEntry.userId} = ${a.userId} AND ${rosterEntry.acquisitionBid} = 1`,
        )
        .orderBy(rosterEntry.acquisitionOrder);
      console.log(`    ${a.userName} $1 entries (${dollarEntries.length}):`);
      for (const e of dollarEntries) {
        console.log(`      #${e.order} ${e.playerName}`);
      }
    }
  }
  await closeDb();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
