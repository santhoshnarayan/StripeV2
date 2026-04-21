// Worker-thread entry for the Monte Carlo projection simulator.
//
// Why this exists: runTournamentSim at 2k sims is CPU-heavy (~2s per call).
// Running it on the main Node thread blocks every HTTP handler on the server
// for the duration — we saw /players, /sim-data, /schedule all spike to 2-3s
// the moment a projection rebuild ticked. This worker runs the sim on a
// separate thread so the main event loop stays responsive.
//
// Protocol: parent posts one { type: "init" } with the static sim data, then
// any number of { type: "run", id, liveGames, rosters, simCount } messages.
// Worker replies with { type: "ready" } then { type: "result", id, projByUser }
// or { type: "error", id, message } for each run.
import { parentPort } from "node:worker_threads";
import {
  DEFAULT_SIM_CONFIG,
  computeManagerProjections,
  runTournamentSim,
  type LiveGameState,
  type RosterInput,
  type SimData,
} from "@repo/sim";

if (!parentPort) {
  throw new Error("sim-worker must be spawned as a worker_thread");
}

type StaticSimData = Omit<SimData, "liveGames">;

type InitMessage = { type: "init"; baseSimData: StaticSimData };
type RunMessage = {
  type: "run";
  id: number;
  liveGames: LiveGameState[];
  rosters: RosterInput[];
  simCount: number;
};
type InboundMessage = InitMessage | RunMessage;

let baseSimData: StaticSimData | null = null;

parentPort.on("message", async (msg: InboundMessage) => {
  if (msg.type === "init") {
    baseSimData = msg.baseSimData;
    parentPort!.postMessage({ type: "ready" });
    return;
  }
  if (msg.type === "run") {
    if (!baseSimData) {
      parentPort!.postMessage({
        type: "error",
        id: msg.id,
        message: "sim-worker not initialized",
      });
      return;
    }
    try {
      const simData: SimData = { ...baseSimData, liveGames: msg.liveGames };
      const results = await runTournamentSim(simData, {
        ...DEFAULT_SIM_CONFIG,
        sims: msg.simCount,
      });
      const projections = computeManagerProjections(results, msg.rosters);
      const projByUser: Record<
        string,
        { mean: number; stddev: number; p10: number; p90: number; winProb: number }
      > = {};
      for (const p of projections) {
        projByUser[p.userId] = {
          mean: p.mean,
          stddev: p.stddev,
          p10: p.p10,
          p90: p.p90,
          winProb: p.winProbability,
        };
      }
      parentPort!.postMessage({ type: "result", id: msg.id, projByUser });
    } catch (err) {
      parentPort!.postMessage({
        type: "error",
        id: msg.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
});
