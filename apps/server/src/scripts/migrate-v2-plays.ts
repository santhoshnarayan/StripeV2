import { closeDb, db, nbaEventProjection, nbaGame } from "@repo/db";
import { setSyncPaused, syncGameDetail } from "../lib/espn-nba/ingest.js";

/**
 * Post-0008 schema-port orchestration (DB-only):
 *   1. Pause ingest crons via nbaSyncState flag.
 *   2. Drain in-flight syncs.
 *   3. Wipe nbaEventProjection (sim cache — rebuild later, separately).
 *   4. Backfill: call syncGameDetail() for every post/in nbaGame so
 *      nbaPlay + nbaPlayParticipant repopulate under the new schema.
 *   5. Unpause crons.
 *
 * Sim rebuild is deliberately NOT part of this script — projections are
 * rebuilt separately (e.g., via rebuild-projections.ts or a dedicated
 * shared-sim rebuild once that refactor lands).
 *
 * Idempotent: safe to re-run. On any error, crons are unpaused in `finally`
 * so live syncs can resume even if backfill partially fails.
 */

const DRAIN_MS = Number(process.env.MIGRATE_DRAIN_MS ?? 3_000);
const DETAIL_DELAY_MS = 150;

function fmt(d: Date): string {
  return d.toISOString();
}

async function run(): Promise<void> {
  console.log(`[migrate-v2] starting at ${fmt(new Date())}`);

  console.log("[migrate-v2] step 1/5: pausing ingest crons");
  await setSyncPaused(true, "v2-plays schema migration");

  console.log(`[migrate-v2] step 2/5: draining in-flight syncs (${DRAIN_MS}ms)`);
  await new Promise((r) => setTimeout(r, DRAIN_MS));

  console.log("[migrate-v2] step 3/5: wiping nbaEventProjection");
  const projRowsBefore = await db.select({ id: nbaEventProjection.gameId }).from(nbaEventProjection);
  console.log(`[migrate-v2]   existing projection rows: ${projRowsBefore.length}`);
  await db.delete(nbaEventProjection);

  console.log("[migrate-v2] step 4/5: backfilling plays via syncGameDetail");
  // nbaPlay was dropped cascade in migration 0008, so every non-pre game must
  // be rehydrated. Include all post/in games — even non-bracket ones — so the
  // game-detail UI works across everything we have stored.
  const games = await db
    .select({ id: nbaGame.id, status: nbaGame.status })
    .from(nbaGame);
  const needsDetail = games.filter((g) => g.status === "post" || g.status === "in");
  console.log(`[migrate-v2]   games to rehydrate: ${needsDetail.length}`);

  let ok = 0;
  let fail = 0;
  for (const g of needsDetail) {
    try {
      await syncGameDetail(g.id);
      ok += 1;
      console.log(`[migrate-v2]   ${ok}/${needsDetail.length}  ${g.id}`);
    } catch (err) {
      fail += 1;
      console.warn(`[migrate-v2]   detail ${g.id} failed — ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
  }
  console.log(`[migrate-v2]   backfill done. ok=${ok} fail=${fail}`);

  console.log("[migrate-v2] step 5/5: unpausing ingest crons");
  await setSyncPaused(false);

  console.log(`[migrate-v2] done at ${fmt(new Date())}`);
}

async function main(): Promise<void> {
  try {
    await run();
    await closeDb();
    process.exit(0);
  } catch (err) {
    console.error("[migrate-v2] FATAL:", err);
    try {
      await setSyncPaused(false);
      console.log("[migrate-v2] crons unpaused after fatal error");
    } catch (e) {
      console.error("[migrate-v2] failed to unpause crons:", e);
    }
    await closeDb();
    process.exit(1);
  }
}

void main();
