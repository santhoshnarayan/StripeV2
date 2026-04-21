import { db, closeDb } from "@repo/db";
import { league } from "@repo/db/schema";
import { eq } from "drizzle-orm";

async function main() {
  const [updated] = await db
    .update(league)
    .set({ name: "Munster", isPublic: true, updatedAt: new Date() })
    .where(eq(league.id, "founders-league"))
    .returning({ id: league.id, name: league.name, isPublic: league.isPublic });

  if (!updated) {
    console.error("founders-league not found — nothing renamed.");
    process.exitCode = 1;
  } else {
    console.log(`Renamed ${updated.id} → ${updated.name} (public=${updated.isPublic})`);
  }

  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
