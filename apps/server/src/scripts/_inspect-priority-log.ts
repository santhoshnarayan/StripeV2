import { db, closeDb, leagueAction, user } from "@repo/db";
import { and, eq, asc } from "drizzle-orm";

async function main() {
  // Unique action types used in founders-league
  const all = await db
    .select()
    .from(leagueAction)
    .where(eq(leagueAction.leagueId, "founders-league"))
    .orderBy(asc(leagueAction.sequenceNumber));

  const types = new Map<string, number>();
  for (const a of all) types.set(a.type, (types.get(a.type) ?? 0) + 1);
  console.log("Action type counts:");
  for (const [t, c] of types) console.log(`  ${t}\t${c}`);

  // Any with priority-ish metadata
  const priority = all.filter(
    (a) =>
      a.type.includes("priority") ||
      a.type.includes("tiebreak") ||
      (a.metadata && JSON.stringify(a.metadata).includes("priority")),
  );
  console.log(`\nPriority/tiebreak entries: ${priority.length}`);
  for (const a of priority.slice(0, 10)) {
    console.log(`  seq=${a.sequenceNumber} type=${a.type} meta=${JSON.stringify(a.metadata)}`);
  }

  // Also sample first 20 action types to see overall structure
  console.log("\nFirst 20 actions:");
  for (const a of all.slice(0, 20)) {
    console.log(
      `  seq=${a.sequenceNumber} type=${a.type} user=${a.userId?.slice(0, 8)} player=${a.playerId?.slice(0, 8)} amt=${a.amount} meta=${a.metadata ? JSON.stringify(a.metadata).slice(0, 80) : "—"}`,
    );
  }

  await closeDb();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
