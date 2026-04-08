import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { handleExampleTask } from "./handlers/example.js";

const connection = process.env.REDIS_URL
  ? new IORedis(process.env.REDIS_URL)
  : undefined;

export const taskQueue = connection
  ? new Queue("tasks", { connection })
  : undefined;

export function startWorker() {
  if (!connection) {
    console.log("[tasks] No REDIS_URL configured, skipping worker");
    return;
  }

  const worker = new Worker(
    "tasks",
    async (job) => {
      console.log(`[tasks] Processing job ${job.name} (${job.id})`);

      switch (job.name) {
        case "example":
          await handleExampleTask(job.data);
          break;
        default:
          console.warn(`[tasks] Unknown job type: ${job.name}`);
      }
    },
    { connection }
  );

  worker.on("completed", (job) => {
    console.log(`[tasks] Job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[tasks] Job ${job?.id} failed:`, err.message);
  });

  console.log("[tasks] Worker started");
}

export async function enqueueTask(name: string, data: Record<string, unknown>) {
  if (!taskQueue) {
    console.warn("[tasks] Queue not available (no Redis). Task not enqueued:", name);
    return;
  }
  await taskQueue.add(name, data);
}
