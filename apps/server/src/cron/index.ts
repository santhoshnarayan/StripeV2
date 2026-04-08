import cron from "node-cron";
import { exampleJob } from "./jobs/example.js";

export function startCronJobs() {
  // Run example job every hour
  cron.schedule("0 * * * *", () => {
    console.log("[cron] Running example job");
    exampleJob();
  });

  console.log("[cron] Cron jobs started");
}
