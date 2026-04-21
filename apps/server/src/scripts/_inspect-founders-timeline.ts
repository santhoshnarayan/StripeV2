import { db, closeDb } from "@repo/db";
import { leagueAction, draftRound, user } from "@repo/db/schema";
import { asc, eq, inArray } from "drizzle-orm";

async function main() {
  const rounds = await db
    .select()
    .from(draftRound)
    .where(eq(draftRound.leagueId, "founders-league"))
    .orderBy(asc(draftRound.roundNumber));
  for (const r of rounds)
    console.log(`R${r.roundNumber} id=${r.id.slice(0, 8)} status=${r.status}`);

  const actions = await db
    .select()
    .from(leagueAction)
    .where(eq(leagueAction.leagueId, "founders-league"))
    .orderBy(asc(leagueAction.sequenceNumber));

  const userIds = Array.from(new Set(actions.map((a) => a.userId).filter((x): x is string => !!x)));
  const users = userIds.length
    ? await db.select().from(user).where(inArray(user.id, userIds))
    : [];
  const nameById = new Map(users.map((u) => [u.id, u.name]));

  console.log("\n-- budget-affecting actions --");
  const shown = new Set(["roster_remove", "round_closed", "draft_award", "draft_priority_seed", "budget_adjust", "roster_add", "auction_award", "auction_undo_award"]);
  for (const a of actions) {
    if (!shown.has(a.type)) continue;
    const uname = a.userId ? nameById.get(a.userId) ?? a.userId.slice(0, 8) : "-";
    console.log(
      `seq=${a.sequenceNumber.toString().padStart(3)} ${a.type.padEnd(22)} user=${uname.padEnd(18)} amt=${a.amount ?? "-"} round=${a.roundId?.slice(0, 8) ?? "-"} player=${a.playerId ?? "-"}`,
    );
  }
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
