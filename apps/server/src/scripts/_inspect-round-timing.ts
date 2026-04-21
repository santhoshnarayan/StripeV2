import { db, closeDb, draftRound, rosterEntry, leagueAction, user } from "@repo/db";
import { asc, eq } from "drizzle-orm";

async function main() {
  const rounds = await db
    .select()
    .from(draftRound)
    .where(eq(draftRound.leagueId, "founders-league"))
    .orderBy(asc(draftRound.roundNumber));
  console.log("Rounds:");
  for (const r of rounds) {
    console.log(
      `  R${r.roundNumber} id=${r.id.slice(0, 8)} mode=${r.eligiblePlayerMode} opened=${r.openedAt.toISOString()} closed=${r.closedAt?.toISOString() ?? "—"} resolved=${r.resolvedAt?.toISOString() ?? "—"}`,
    );
  }

  const actions = await db
    .select()
    .from(leagueAction)
    .where(eq(leagueAction.leagueId, "founders-league"))
    .orderBy(asc(leagueAction.sequenceNumber));
  console.log("\nAll non-draft-award actions (seq, type, meta summary):");
  for (const a of actions.filter((a) => a.type !== "draft_award")) {
    console.log(
      `  seq=${a.sequenceNumber} type=${a.type} user=${a.userId?.slice(0, 8) ?? "—"} amt=${a.amount ?? "—"} created=${a.createdAt.toISOString()} meta=${a.metadata ? JSON.stringify(a.metadata) : "—"}`,
    );
  }

  // Check for Luka-related rosterEntry
  const luka = await db
    .select()
    .from(rosterEntry)
    .where(eq(rosterEntry.playerId, "3945274"));
  console.log("\nLuka rosterEntry rows league-wide:");
  for (const r of luka) {
    console.log(
      `  ${r.leagueId} user=${r.userId.slice(0, 8)} bid=${r.acquisitionBid} order=${r.acquisitionOrder} roundId=${r.acquisitionRoundId?.slice(0, 8)} createdAt=${r.createdAt.toISOString()}`,
    );
  }

  await closeDb();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
