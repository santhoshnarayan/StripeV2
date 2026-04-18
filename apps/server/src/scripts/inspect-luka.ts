import { db } from "@repo/db";
import { league, user, rosterEntry, leagueAction, leagueMember, draftRound } from "@repo/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";

async function main() {
  const leagueRow = (
    await db.select().from(league).where(eq(league.id, "founders-league")).limit(1)
  )[0];
  if (!leagueRow) throw new Error("founders-league not found");
  console.log("League:", leagueRow.id, leagueRow.name, "phase:", leagueRow.phase);

  const lukaId = "3945274"; // ESPN Luka Doncic

  const currentEntries = await db
    .select({
      id: rosterEntry.id,
      userId: rosterEntry.userId,
      playerId: rosterEntry.playerId,
      playerName: rosterEntry.playerName,
      playerTeam: rosterEntry.playerTeam,
      bid: rosterEntry.acquisitionBid,
      roundId: rosterEntry.acquisitionRoundId,
      createdAt: rosterEntry.createdAt,
    })
    .from(rosterEntry)
    .where(and(eq(rosterEntry.leagueId, leagueRow.id), eq(rosterEntry.playerId, lukaId)));
  console.log("\nCurrent roster entries for Luka in founders:", currentEntries);

  const actionsForLuka = await db
    .select({
      id: leagueAction.id,
      seq: leagueAction.sequenceNumber,
      type: leagueAction.type,
      userId: leagueAction.userId,
      actorUserId: leagueAction.actorUserId,
      amount: leagueAction.amount,
      roundId: leagueAction.roundId,
      metadata: leagueAction.metadata,
      createdAt: leagueAction.createdAt,
    })
    .from(leagueAction)
    .where(and(eq(leagueAction.leagueId, leagueRow.id), eq(leagueAction.playerId, lukaId)))
    .orderBy(leagueAction.sequenceNumber);
  console.log("\nAll leagueAction rows referencing Luka:");
  console.table(actionsForLuka);

  const members = await db
    .select({
      userId: leagueMember.userId,
      userName: user.name,
      userEmail: user.email,
    })
    .from(leagueMember)
    .innerJoin(user, eq(leagueMember.userId, user.id))
    .where(eq(leagueMember.leagueId, leagueRow.id));
  console.log("\nFounders-league members:");
  console.table(members);

  const userNameById = new Map(members.map((m) => [m.userId, m.userName]));

  const rosterRows = await db
    .select({
      userId: rosterEntry.userId,
      playerId: rosterEntry.playerId,
      playerName: rosterEntry.playerName,
      playerTeam: rosterEntry.playerTeam,
      bid: rosterEntry.acquisitionBid,
      roundId: rosterEntry.acquisitionRoundId,
      createdAt: rosterEntry.createdAt,
    })
    .from(rosterEntry)
    .where(eq(rosterEntry.leagueId, leagueRow.id))
    .orderBy(asc(rosterEntry.createdAt));
  console.log(`\nAll rosterEntry rows in founders-league (count=${rosterRows.length}):`);
  console.table(
    rosterRows.map((r) => ({
      user: userNameById.get(r.userId) ?? r.userId,
      player: r.playerName,
      team: r.playerTeam,
      bid: r.bid,
      round: r.roundId ?? "(null)",
      createdAt: r.createdAt.toISOString(),
    })),
  );

  const rounds = await db
    .select({
      id: draftRound.id,
      roundNumber: draftRound.roundNumber,
      status: draftRound.status,
      createdAt: draftRound.createdAt,
    })
    .from(draftRound)
    .where(eq(draftRound.leagueId, leagueRow.id))
    .orderBy(asc(draftRound.roundNumber));
  console.log("\nDraft rounds:");
  console.table(rounds);

  const allActions = await db
    .select({
      seq: leagueAction.sequenceNumber,
      type: leagueAction.type,
      user: leagueAction.userId,
      playerId: leagueAction.playerId,
      amount: leagueAction.amount,
      roundId: leagueAction.roundId,
      createdAt: leagueAction.createdAt,
    })
    .from(leagueAction)
    .where(eq(leagueAction.leagueId, leagueRow.id))
    .orderBy(asc(leagueAction.sequenceNumber));
  console.log("\nAll founders-league actions:");
  console.table(
    allActions.map((a) => ({
      seq: a.seq,
      type: a.type,
      user: userNameById.get(a.user ?? "") ?? a.user,
      playerId: a.playerId,
      amount: a.amount,
      round: a.roundId ?? "",
      createdAt: a.createdAt.toISOString(),
    })),
  );

  const maxSeq = (
    await db
      .select({ maxSeq: sql<number>`COALESCE(MAX(${leagueAction.sequenceNumber}), 0)` })
      .from(leagueAction)
      .where(eq(leagueAction.leagueId, leagueRow.id))
  )[0]?.maxSeq;
  console.log("\nMax sequenceNumber in founders-league:", maxSeq);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
