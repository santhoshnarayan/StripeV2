import { db, closeDb, leagueMember, user } from "@repo/db";
import { and, eq } from "drizzle-orm";

async function main() {
  const rows = await db
    .select({ name: user.name, dp: leagueMember.draftPriority, userId: user.id })
    .from(leagueMember)
    .innerJoin(user, eq(user.id, leagueMember.userId))
    .where(and(eq(leagueMember.leagueId, "founders-league"), eq(leagueMember.status, "active")));
  rows.sort((a, b) => (a.dp ?? 999) - (b.dp ?? 999));
  console.log("Current draftPriority in founders-league:");
  for (const r of rows) console.log(`  ${r.dp}\t${r.name}\t${r.userId}`);
  await closeDb();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
