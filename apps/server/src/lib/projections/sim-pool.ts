// Main-thread handle for the sim-worker. Spawns a single persistent worker,
// feeds it the static SimData once at startup, and forwards per-snapshot run
// requests. The worker runs the Monte Carlo tournament sim off the main
// Node thread so HTTP handlers stay responsive during projection rebuilds.
import { Worker } from "node:worker_threads";
import type { LiveGameState, RosterInput, SimData } from "@repo/sim";

type StaticSimData = Omit<SimData, "liveGames">;

type ProjByUser = Record<
  string,
  { mean: number; stddev: number; p10: number; p90: number; winProb: number }
>;

type Pending = {
  resolve: (value: ProjByUser) => void;
  reject: (reason: Error) => void;
};

type OutboundMessage =
  | { type: "ready" }
  | { type: "result"; id: number; projByUser: ProjByUser }
  | { type: "error"; id: number; message: string };

class SimPool {
  private worker: Worker | null = null;
  private initPromise: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  async ensureInit(baseSimData: StaticSimData): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = new Promise<void>((resolve, reject) => {
      // Spawn the .mjs bootstrap (not the .ts directly) so Node's native
      // type-stripping doesn't win the race against tsx's ESM loader. The
      // bootstrap registers tsx then dynamic-imports the real worker.
      const workerUrl = new URL(
        "../../workers/sim-worker-boot.mjs",
        import.meta.url,
      );
      const worker = new Worker(workerUrl);
      this.worker = worker;

      worker.on("message", (msg: OutboundMessage) => {
        if (msg.type === "ready") {
          resolve();
          return;
        }
        if (msg.type === "result") {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            p.resolve(msg.projByUser);
          }
          return;
        }
        if (msg.type === "error") {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            p.reject(new Error(msg.message));
          }
          return;
        }
      });

      worker.on("error", (err) => {
        // Fatal worker error — fail every outstanding run and reset so the
        // next request re-spawns a fresh worker.
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        this.worker = null;
        this.initPromise = null;
        reject(err);
      });

      worker.on("exit", (code) => {
        if (code !== 0) {
          const err = new Error(`sim-worker exited with code ${code}`);
          for (const p of this.pending.values()) p.reject(err);
        }
        this.pending.clear();
        this.worker = null;
        this.initPromise = null;
      });

      worker.postMessage({ type: "init", baseSimData });
    });
    return this.initPromise;
  }

  async run(
    baseSimData: StaticSimData,
    liveGames: LiveGameState[],
    rosters: RosterInput[],
    simCount: number,
  ): Promise<ProjByUser> {
    await this.ensureInit(baseSimData);
    if (!this.worker) throw new Error("sim-worker not available");
    const id = this.nextId++;
    return new Promise<ProjByUser>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({
        type: "run",
        id,
        liveGames,
        rosters,
        simCount,
      });
    });
  }
}

export const simPool = new SimPool();
