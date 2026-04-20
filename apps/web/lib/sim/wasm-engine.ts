"use client";

// Main-thread façade for the wasm sim worker. Spawns a singleton Worker on
// first call, queues runs sequentially per-worker, and returns a Promise that
// resolves to the same `SimResults` shape the TS engine produces — letting
// useAutoSim treat it as a drop-in replacement for `runTournamentSim`.

import { runTournamentSim, type SimConfig, type SimData, type SimResults } from "@repo/sim";

type Pending = {
  resolve: (r: SimResults) => void;
  reject: (e: Error) => void;
};

type WorkerReply =
  | { type: "result"; reqId: number; results: SimResults }
  | { type: "error"; reqId: number; error: string };

let worker: Worker | null = null;
let nextReqId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./wasm-worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (ev: MessageEvent<WorkerReply>) => {
    const msg = ev.data;
    const p = pending.get(msg.reqId);
    if (!p) return;
    pending.delete(msg.reqId);
    if (msg.type === "result") p.resolve(msg.results);
    else p.reject(new Error(msg.error));
  };
  worker.onerror = (ev) => {
    // If the worker crashes mid-sim, fail every in-flight request and let
    // callers fall back to the TS engine.
    const err = new Error(ev.message || "wasm worker crashed");
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** True iff the runtime supports the wasm worker path (browser, Worker API). */
export function wasmAvailable(): boolean {
  return typeof window !== "undefined" && typeof Worker !== "undefined";
}

export function runWasmSim(data: SimData, sims?: number): Promise<SimResults> {
  if (!wasmAvailable()) {
    return Promise.reject(new Error("wasm sim engine unavailable in this runtime"));
  }
  const w = getWorker();
  const reqId = nextReqId++;
  return new Promise<SimResults>((resolve, reject) => {
    pending.set(reqId, { resolve, reject });
    w.postMessage({ type: "run", reqId, data, sims });
  });
}

/** Runs a tournament sim using the WASM engine when available, falling back to
 *  the TS engine if the worker is unavailable or fails. Progress callbacks only
 *  fire on the TS path; for WASM we emit a synthetic 0 and 1 so UIs that drive
 *  spinners off progress still transition cleanly. */
export async function runSimAuto(
  data: SimData,
  config: SimConfig,
  onProgress?: (p: number) => void,
): Promise<SimResults> {
  if (wasmAvailable()) {
    try {
      onProgress?.(0);
      const results = await runWasmSim(data, config.sims);
      onProgress?.(1);
      return results;
    } catch (err) {
      console.warn("[sim] wasm engine failed, falling back to TS:", err);
    }
  }
  return runTournamentSim(data, config, onProgress);
}
