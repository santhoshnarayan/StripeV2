import { db, closeDb } from "@repo/db";
import { leagueAction, rosterEntry, user, draftRound } from "@repo/db/schema";
import { and, asc, eq, inArray } from "drizzle-orm";

const LEAGUE_ID = "founders-league";

async function main() {
  const [robin] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.name, "Robin Jiang"));

  const rounds = await db
    .select()
    .from(draftRound)
    .where(eq(draftRound.leagueId, LEAGUE_ID))
    .orderBy(asc(draftRound.roundNumber));
  const r4 = rounds.find((r) => r.roundNumber === 4)!;

  const actions = await db
    .select()
    .from(leagueAction)
    .where(
      and(
        eq(leagueAction.leagueId, LEAGUE_ID),
        inArray(leagueAction.type, [
          "draft_award",
          "roster_remove",
          "roster_add",
          "auction_award",
          "auction_undo_award",
          "budget_adjust",
        ]),
      ),
    )
    .orderBy(asc(leagueAction.sequenceNumber));

  const rosters = await db
    .select()
    .from(rosterEntry)
    .where(eq(rosterEntry.leagueId, LEAGUE_ID));
  const awardsByRoundId = new Map<string, typeof rosters>();
  for (const r of rosters) {
    if (!r.acquisitionRoundId) continue;
    awardsByRoundId.set(r.acquisitionRoundId, [
      ...(awardsByRoundId.get(r.acquisitionRoundId) ?? []),
      r,
    ]);
  }
  const rowIndexByRoundPlayer = new Map<string, Map<string, number>>();
  for (const [roundId, awards] of awardsByRoundId) {
    const sorted = [...awards].sort(
      (a, b) => a.acquisitionOrder - b.acquisitionOrder,
    );
    const m = new Map<string, number>();
    for (let i = 0; i < sorted.length; i++) m.set(sorted[i].playerId, i);
    rowIndexByRoundPlayer.set(roundId, m);
  }

  const budget = new Map<string, number>([[robin.id, 200]]);
  const slots = new Map<string, number>([[robin.id, 10]]);

  for (const a of actions) {
    if (!a.userId || a.amount == null) continue;
    if (a.userId !== robin.id) continue;
    const b = budget.get(robin.id)!;
    const s = slots.get(robin.id)!;
    if (a.type === "draft_award") {
      const rowIdx =
        a.roundId && a.playerId
          ? rowIndexByRoundPlayer.get(a.roundId)?.get(a.playerId)
          : undefined;
      const isR4Tyson = a.roundId === r4.id && a.playerId === "4683747";
      if (isR4Tyson) {
        console.log(
          `\nR4 Tyson pre-deduct: budget=$${b} slots=${s} rowIdx=${rowIdx}`,
        );
      }
      budget.set(robin.id, b - a.amount);
      slots.set(robin.id, s - 1);
      if (isR4Tyson) {
        console.log(
          `R4 Tyson post-deduct: budget=$${budget.get(robin.id)} slots=${slots.get(robin.id)}`,
        );
      }
    } else if (a.type === "roster_remove" || a.type === "auction_undo_award") {
      budget.set(robin.id, b + a.amount);
      slots.set(robin.id, s + 1);
    } else if (a.type === "roster_add" || a.type === "auction_award") {
      budget.set(robin.id, b - a.amount);
      slots.set(robin.id, s - 1);
    } else if (a.type === "budget_adjust") {
      budget.set(robin.id, b + a.amount);
    }
  }

  console.log(`\nFinal: budget=$${budget.get(robin.id)} slots=${slots.get(robin.id)}`);
  console.log(
    `Expected (user's correction): Tyson pre=$53/6slots  post=$37/5slots  Final=$0/0slots`,
  );

  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
