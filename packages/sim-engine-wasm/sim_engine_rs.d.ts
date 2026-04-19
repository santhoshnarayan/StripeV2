/* tslint:disable */
/* eslint-disable */

export class WasmSimResults {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Play-in slot labels in the order `playinSeedsFlat` uses.
     */
    static playinKeys(): any[];
    /**
     * Series-key labels in the order `seriesWinnersFlat` uses.
     */
    static seriesKeys(): any[];
    readonly numSims: number;
    /**
     * Espn ID → column index in `simMatrix`.
     */
    readonly playerIndex: any;
    /**
     * JSON-shaped array of `PlayerProjection`.
     */
    readonly players: any;
    /**
     * Per-sim play-in seed assignment, row-major `[sim, slot]` packed Uint8Array
     * (4 slots per sim: east7, east8, west7, west8 — see `playinKeys()`).
     */
    readonly playinSeedsFlat: Uint8Array;
    /**
     * Per-series winner indices, row-major `[sim, series]` packed into a single
     * Uint8Array. JS slices it into per-series Uint8Arrays using `seriesKeys()`.
     */
    readonly seriesWinnersFlat: Uint8Array;
    /**
     * Float32 [sims × players] matrix of fantasy points.
     */
    readonly simMatrix: Float32Array;
    /**
     * `{ alias: idx }` lookup into `team_names`.
     */
    readonly teamIndex: any;
    /**
     * Stable list of team abbreviations indexed by the `*_winners` arrays.
     */
    readonly teamNames: any;
    /**
     * `{ team: Uint8Array(numSims) }` — round reached per sim per team (0..=5).
     */
    readonly teamRoundReached: any;
    /**
     * JSON-shaped array of `TeamSimResult`.
     */
    readonly teams: any;
}

export function init(): void;

/**
 * Run a sim from a JSON-encoded `SimData` blob. `sims_override` lets the
 * caller dial the Monte Carlo count without re-encoding the config.
 */
export function runSim(data_json: string, sims_override?: number | null): WasmSimResults;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmsimresults_free: (a: number, b: number) => void;
    readonly wasmsimresults_numSims: (a: number) => number;
    readonly wasmsimresults_teams: (a: number) => [number, number, number];
    readonly wasmsimresults_players: (a: number) => [number, number, number];
    readonly wasmsimresults_teamNames: (a: number) => [number, number, number];
    readonly wasmsimresults_teamIndex: (a: number) => [number, number, number];
    readonly wasmsimresults_playerIndex: (a: number) => [number, number, number];
    readonly wasmsimresults_simMatrix: (a: number) => any;
    readonly wasmsimresults_seriesWinnersFlat: (a: number) => any;
    readonly wasmsimresults_playinSeedsFlat: (a: number) => any;
    readonly wasmsimresults_teamRoundReached: (a: number) => [number, number, number];
    readonly wasmsimresults_seriesKeys: () => [number, number];
    readonly wasmsimresults_playinKeys: () => [number, number];
    readonly runSim: (a: number, b: number, c: number) => [number, number, number];
    readonly init: () => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
