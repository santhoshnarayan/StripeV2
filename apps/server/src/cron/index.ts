import cron from "node-cron";
import { exampleJob } from "./jobs/example.js";
import { runLiveGamesSync, runScoreboardSync } from "./jobs/nba-live.js";

export function startCronJobs() {
  // Run example job every hour
  cron.schedule("0 * * * *", () => {
    console.log("[cron] Running example job");
    exampleJob();
  });

  // Every 15 min: refresh today's scoreboard + assign game→series mappings.
  cron.schedule("*/15 * * * *", () => {
    runScoreboardSync();
  });

  // Every 1 min: update live/about-to-start/recently-ended games.
  cron.schedule("* * * * *", () => {
    runLiveGamesSync();
  });

  // Kick off an initial scoreboard sync on boot so we have data immediately.
  runScoreboardSync();

  console.log("[cron] Cron jobs started");
}
