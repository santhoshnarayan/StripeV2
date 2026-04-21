import { db, closeDb, rosterEntry, user, draftRound } from "@repo/db";
import { and, asc, eq } from "drizzle-orm";

async function main() {
  const rows = await db
    .select({
      playerName: rosterEntry.playerName,
      userId: rosterEntry.userId,
      userName: user.name,
      bid: rosterEntry.acquisitionBid,
      order: rosterEntry.acquisitionOrder,
      wonByTiebreak: rosterEntry.wonByTiebreak,
      roundId: rosterEntry.acquisitionRoundId,
    })
    .from(rosterEntry)
    .innerJoin(user, eq(user.id, rosterEntry.userId))
    .where(eq(rosterEntry.leagueId, "founders-league"))
    .orderBy(asc(rosterEntry.acquisitionOrder));

  const rounds = await db
    .select()
    .from(draftRound)
    .where(eq(draftRound.leagueId, "founders-league"));
  const roundNumberById = new Map(rounds.map((r) => [r.id, r.roundNumber]));

  const tiebreakWins = rows.filter((r) => r.wonByTiebreak);
  console.log(`Founders League — ${rows.length} total awards; ${tiebreakWins.length} by tiebreak:`);
  for (const r of tiebreakWins) {
    console.log(
      `  R${roundNumberById.get(r.roundId ?? "") ?? "?"} ord=${r.order} ${r.userName.padEnd(20)} won ${r.playerName.padEnd(28)} @$${r.bid}`,
    );
  }

  // Also dump Robin's $1 acquisitions
  const robinOnes = rows.filter((r) => r.userName === "Robin Jiang" && r.bid === 1);
  console.log(`\nRobin's $1 acquisitions (${robinOnes.length}):`);
  for (const r of robinOnes) {
    console.log(
      `  R${roundNumberById.get(r.roundId ?? "") ?? "?"} ord=${r.order} ${r.playerName.padEnd(28)} tiebreak=${r.wonByTiebreak}`,
    );
  }

  await closeDb();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
