// Runtime registry for cron handlers. The `cron_job` table stores
// schedules/state; this module maps a row's `id` to the function that runs
// when the scheduler ticks. Keep handlers side-effect-free at import time —
// they should be plain async functions.

import { exampleJob } from "./jobs/example.js";
import { runLiveGamesSync, runScoreboardSync } from "./jobs/nba-live.js";

export type CronHandler = () => Promise<unknown> | unknown;

export type CronDefinition = {
  id: string;
  name: string;
  description: string;
  schedule: string;
  handler: CronHandler;
};

// Built-in jobs. Edit schedules here for the default that gets seeded on
// first boot; after that the DB row is the source of truth and admins edit
// through the panel.
export const BUILTIN_JOBS: CronDefinition[] = [
  {
    id: "example",
    name: "Example hourly job",
    description: "Placeholder cron for testing the scheduler plumbing.",
    schedule: "0 * * * *",
    handler: async () => {
      await exampleJob();
    },
  },
  {
    id: "nba-scoreboard-sync",
    name: "NBA scoreboard sync",
    description:
      "Refreshes today's ESPN scoreboard + assigns game→series mappings.",
    schedule: "*/15 * * * *",
    handler: async () => {
      await runScoreboardSync();
    },
  },
  {
    id: "nba-live-sync",
    name: "NBA live games sync",
    description:
      "Pulls live / about-to-start / recently-ended games every minute.",
    schedule: "* * * * *",
    handler: async () => {
      await runLiveGamesSync();
    },
  },
];

const BY_ID = new Map(BUILTIN_JOBS.map((j) => [j.id, j] as const));

export function getHandler(id: string): CronHandler | undefined {
  return BY_ID.get(id)?.handler;
}

export function getDefinition(id: string): CronDefinition | undefined {
  return BY_ID.get(id);
}
