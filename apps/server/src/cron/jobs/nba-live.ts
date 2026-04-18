import {
  clearLiveWindowGate,
  isSyncPaused,
  syncLiveGames,
  syncScoreboard,
} from "../../lib/espn-nba/ingest.js";

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
  } catch (err) {
    console.error("[cron] nba live-games sync failed:", (err as Error).message);
  }
}
