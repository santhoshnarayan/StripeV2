import {
  clearLiveWindowGate,
  isSyncPaused,
  syncLiveGames,
  syncScoreboard,
} from "../../lib/espn-nba/ingest.js";
import { autoTriggerLiveRebuilds } from "../../lib/projections/rebuild.js";

export async function runScoreboardSync(): Promise<void> {
  try {
    if (await isSyncPaused()) {
      console.log("[cron] nba scoreboard sync skipped — sync paused");
      return;
    }
    await syncScoreboard(new Date());
    // Reset the 1-min gate so the next tick re-evaluates with fresh schedule data.
    clearLiveWindowGate();
  } catch (err) {
    console.error("[cron] nba scoreboard sync failed:", (err as Error).message);
  }
}

export async function runLiveGamesSync(): Promise<void> {
  try {
    if (await isSyncPaused()) return;
    const count = await syncLiveGames();
    if (count > 0) console.log(`[cron] nba live-games sync updated ${count} games`);
    // Auto-rebuild projections for every active league after each ingest tick.
    // hasInFlightRebuild() inside the trigger coalesces bursts; reconciliation
    // inside the rebuild handles inserts/edits/deletes from the new plays.
    if (count > 0) {
      try {
        const { enqueued, skipped } = await autoTriggerLiveRebuilds();
        if (enqueued > 0) {
          console.log(`[cron] nba auto-rebuild enqueued=${enqueued} skipped=${skipped}`);
        }
      } catch (err) {
        console.error("[cron] nba auto-rebuild trigger failed:", (err as Error).message);
      }
    }
  } catch (err) {
    console.error("[cron] nba live-games sync failed:", (err as Error).message);
  }
}
