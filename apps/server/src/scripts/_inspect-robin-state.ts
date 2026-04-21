import { db, closeDb, rosterEntry, draftRound, user, leagueAction } from "@repo/db";
import { and, asc, eq } from "drizzle-orm";

async function main() {
  const rounds = await db
    .select()
    .from(draftRound)
    .where(eq(draftRound.leagueId, "founders-league"))
    .orderBy(asc(draftRound.roundNumber));
  const roundNum = new Map(rounds.map((r) => [r.id, r.roundNumber]));

  const u = await db.select().from(user).where(eq(user.name, "Robin Jiang"));
  const rjId = u[0].id;

  const roster = await db
    .select()
    .from(rosterEntry)
    .where(and(eq(rosterEntry.leagueId, "founders-league"), eq(rosterEntry.userId, rjId)))
    .orderBy(asc(rosterEntry.acquisitionOrder));

  console.log(`Robin's rosterEntry rows (${roster.length}):`);
  for (const r of roster) {
    console.log(
      `  ord=${String(r.acquisitionOrder).padStart(3)} R${roundNum.get(r.acquisitionRoundId ?? "") ?? "?"} ${r.playerName.padEnd(28)} $${r.acquisitionBid} tiebreak=${r.wonByTiebreak} auto=${r.isAutoAssigned}`,
    );
  }

  const total = roster.reduce((s, r) => s + r.acquisitionBid, 0);
  const byRound = new Map<number, number>();
  for (const r of roster) {
    const rn = roundNum.get(r.acquisitionRoundId ?? "") ?? -1;
    byRound.set(rn, (byRound.get(rn) ?? 0) + r.acquisitionBid);
  }
  console.log(`\n  total=${total}`);
  for (const [rn, s] of [...byRound].sort()) console.log(`  R${rn} sum=$${s}`);

  // Robin's actions
  const acts = await db
    .select()
    .from(leagueAction)
    .where(and(eq(leagueAction.leagueId, "founders-league"), eq(leagueAction.userId, rjId)))
    .orderBy(asc(leagueAction.sequenceNumber));
  console.log(`\nRobin's league_action entries (${acts.length}):`);
  for (const a of acts) {
    console.log(
      `  seq=${a.sequenceNumber} type=${a.type.padEnd(22)} amt=${a.amount} created=${a.createdAt.toISOString()} meta=${a.metadata ? JSON.stringify(a.metadata).slice(0, 60) : "—"}`,
    );
  }

  await closeDb();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
