import { db, closeDb, leagueAction } from "@repo/db";
import { and, eq } from "drizzle-orm";

async function main() {
  const rows = await db
    .select()
    .from(leagueAction)
    .where(
      and(
        eq(leagueAction.leagueId, "founders-league"),
        eq(leagueAction.type, "roster_remove"),
      ),
    );
  console.log(JSON.stringify(rows, null, 2));
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
