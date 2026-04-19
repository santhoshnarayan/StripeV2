/// <reference lib="webworker" />

// Web Worker that runs the Rust/Wasm sim engine off the main thread. The main
// thread loads this with `new Worker(new URL("./wasm-worker.ts", import.meta.url))`
// and posts `{ type: "run", data, sims }`. The worker replies with the same
// shape `SimResults` the TS engine produces, so callers can swap engines
// without touching downstream code.

import init, { runSim, WasmSimResults } from "@repo/sim-engine-wasm";
import type {
  PlayerProjection,
  SeriesKey,
  SimData,
  SimResults,
  TeamSimResult,
} from "@repo/sim";
import { PLAYIN_KEYS, SERIES_KEYS } from "@repo/sim";

let initialized: Promise<unknown> | null = null;

function ensureInit(): Promise<unknown> {
  if (!initialized) {
    // Path is the static asset under /public/wasm/. The Rust crate is rebuilt
    // via `pnpm --filter @repo/sim-engine-wasm build` which copies the binary
    // into apps/web/public/wasm/sim_engine.wasm.
    initialized = init("/wasm/sim_engine.wasm");
  }
  return initialized;
}

function reshape(wasmRes: WasmSimResults): SimResults {
  const numSims = wasmRes.numSims;
  const teams = wasmRes.teams as TeamSimResult[];
  const players = wasmRes.players as PlayerProjection[];
  const teamNames = wasmRes.teamNames as string[];
  const teamIndexObj = wasmRes.teamIndex as Record<string, number>;
  const playerIndexObj = wasmRes.playerIndex as Record<string, number>;
  const teamRoundReachedObj = wasmRes.teamRoundReached as Record<string, Uint8Array>;

  const simMatrixF32 = wasmRes.simMatrix; // Float32Array
  // The TS engine returns Float64Array; convert once here so consumers don't
  // need to care which engine produced the result.
  const simMatrix = new Float64Array(simMatrixF32.length);
  for (let i = 0; i < simMatrixF32.length; i++) simMatrix[i] = simMatrixF32[i];

  const teamIndex = new Map<string, number>(Object.entries(teamIndexObj));
  const playerIndex = new Map<string, number>(Object.entries(playerIndexObj));

  const seriesFlat = wasmRes.seriesWinnersFlat; // Uint8Array, length numSims * 15
  const seriesN = SERIES_KEYS.length;
  const seriesWinners = {} as Record<SeriesKey, Uint8Array>;
  for (let s = 0; s < seriesN; s++) {
    const key = SERIES_KEYS[s];
    const arr = new Uint8Array(numSims);
    for (let i = 0; i < numSims; i++) arr[i] = seriesFlat[i * seriesN + s];
    seriesWinners[key] = arr;
  }

  const playinFlat = wasmRes.playinSeedsFlat; // Uint8Array, length numSims * 4
  const playinSeeds = {} as SimResults["playinSeeds"];
  for (let s = 0; s < PLAYIN_KEYS.length; s++) {
    const key = PLAYIN_KEYS[s];
    const arr = new Uint8Array(numSims);
    for (let i = 0; i < numSims; i++) arr[i] = playinFlat[i * 4 + s];
    playinSeeds[key] = arr;
  }

  // Free wasm memory immediately — the JS-owned buffers above hold all we need.
  wasmRes.free();

  return {
    teams,
    players,
    simMatrix,
    playerIndex,
    numSims,
    teamRoundReached: teamRoundReachedObj,
    teamNames,
    teamIndex,
    seriesWinners,
    playinSeeds,
  };
}

type RunMsg = { type: "run"; reqId: number; data: SimData; sims?: number };
type ResultMsg = { type: "result"; reqId: number; results: SimResults };
type ErrorMsg = { type: "error"; reqId: number; error: string };

self.onmessage = async (ev: MessageEvent<RunMsg>) => {
  const msg = ev.data;
  if (msg?.type !== "run") return;
  try {
    await ensureInit();
    const json = JSON.stringify({ ...msg.data, liveGames: msg.data.liveGames ?? [] });
    const wasmRes = runSim(json, msg.sims);
    const results = reshape(wasmRes);

    // Transfer the heavy buffers — saves a copy on postMessage. We list the
    // underlying ArrayBuffers; Float64Array and Uint8Array views ride along.
    // (Typed arrays we allocate are always backed by ArrayBuffer, never
    //  SharedArrayBuffer — the cast is safe.)
    const transfer: Transferable[] = [results.simMatrix.buffer as ArrayBuffer];
    for (const k of SERIES_KEYS) transfer.push(results.seriesWinners[k].buffer as ArrayBuffer);
    for (const k of PLAYIN_KEYS) transfer.push(results.playinSeeds[k].buffer as ArrayBuffer);
    for (const arr of Object.values(results.teamRoundReached)) {
      transfer.push(arr.buffer as ArrayBuffer);
    }

    const reply: ResultMsg = { type: "result", reqId: msg.reqId, results };
    (self as unknown as Worker).postMessage(reply, transfer);
  } catch (err) {
    const reply: ErrorMsg = {
      type: "error",
      reqId: msg.reqId,
      error: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(reply);
  }
};
