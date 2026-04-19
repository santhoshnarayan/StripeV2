/**
 * Bracket-conditioning logic for the Simulator → What-If tab.
 *
 * Given a `SimResults` (carrying `seriesWinners` + `playinSeeds` per-sim
 * trajectory tracks added in Slice 1) and a user-supplied force map,
 * compute:
 *   - `mask`: which of the N sims satisfy every forced series outcome
 *   - conditional team % per round (R1/R2/CF/Champ)
 *   - conditional per-player mean fantasy points
 *
 * Logic is pure and synchronous. At N=10k sims and ~20 teams / ~172
 * players the full re-mask + recompute is < 5 ms on the main thread —
 * no Web Worker needed (yet; Slice 7 will move it to WASM).
 */

import {
  PLAYIN_KEYS,
  SERIES_KEYS,
  type PlayinKey,
  type SeriesKey,
  type SimResults,
} from "@repo/sim";

export type SlotKey = SeriesKey | PlayinKey;

/** User force vector: slot key → forced team idx (into `SimResults.teamNames`).
 *  Absence of a key = "auto" (no constraint). */
export type ForceMap = Partial<Record<SlotKey, number>>;

export interface ConditionalTeamRow {
  team: string;
  fullName: string;
  seed: number | null;
  conference: "E" | "W" | null;
  rating: number;
  /** Baseline (unconditional) % per round, taken from `simResults.teams[]`. */
  base: { r1: number; r2: number; cf: number; finals: number };
  /** Conditional % per round, computed over surviving sims. */
  cond: { r1: number; r2: number; cf: number; finals: number };
}

export interface ConditionalPlayerRow {
  espnId: string;
  name: string;
  team: string;
  baselinePoints: number;
  conditionalPoints: number;
  delta: number;
}

/** Compute the surviving-sims mask given forced slot outcomes. */
export function computeMask(results: SimResults, forces: ForceMap): Uint8Array {
  const N = results.numSims;
  const mask = new Uint8Array(N);
  mask.fill(1);
  for (const k of SERIES_KEYS) {
    const force = forces[k];
    if (force == null) continue;
    const arr = results.seriesWinners[k];
    if (!arr) continue;
    for (let i = 0; i < N; i++) {
      if (mask[i] && arr[i] !== force) mask[i] = 0;
    }
  }
  for (const k of PLAYIN_KEYS) {
    const force = forces[k];
    if (force == null) continue;
    const arr = results.playinSeeds[k];
    if (!arr) continue;
    for (let i = 0; i < N; i++) {
      if (mask[i] && arr[i] !== force) mask[i] = 0;
    }
  }
  return mask;
}

export function maskCount(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) n += mask[i];
  return n;
}

/** Conditional team-by-team R1/R2/CF/Finals% over surviving sims.
 *
 * Note `teamRoundReached` semantics:
 *   1 = reached R1 (entered playoffs)
 *   2 = won R1
 *   3 = won R2
 *   4 = won CF (reached Finals)
 *   5 = won Finals (Champion)
 *
 * `simResults.teams[].r1` (and friends) count *winning* the round, so:
 *   teams[].r1 ≡ % of sims where trr[sim] >= 2
 *   teams[].r2 ≡ % of sims where trr[sim] >= 3
 *   teams[].cf ≡ % of sims where trr[sim] >= 4
 *   teams[].finals ≡ % of sims where trr[sim] >= 5  (== teams[].champ)
 */
export function computeConditionalTeams(
  results: SimResults,
  mask: Uint8Array,
): ConditionalTeamRow[] {
  const N = results.numSims;
  const surviving = maskCount(mask);
  const denom = surviving > 0 ? surviving : 1;

  return results.teams.map((t) => {
    const trr = results.teamRoundReached[t.team];
    let wonR1 = 0;
    let wonR2 = 0;
    let wonCf = 0;
    let wonF = 0;
    if (trr) {
      for (let i = 0; i < N; i++) {
        if (!mask[i]) continue;
        const r = trr[i];
        if (r >= 2) wonR1++;
        if (r >= 3) wonR2++;
        if (r >= 4) wonCf++;
        if (r >= 5) wonF++;
      }
    }
    return {
      team: t.team,
      fullName: t.fullName,
      seed: t.seed,
      conference: t.conference,
      rating: t.rating,
      base: { r1: t.r1, r2: t.r2, cf: t.cf, finals: t.finals },
      cond: {
        r1: surviving > 0 ? (wonR1 / denom) * 100 : 0,
        r2: surviving > 0 ? (wonR2 / denom) * 100 : 0,
        cf: surviving > 0 ? (wonCf / denom) * 100 : 0,
        finals: surviving > 0 ? (wonF / denom) * 100 : 0,
      },
    };
  });
}

/** Conditional per-player mean fantasy points over surviving sims.
 *
 * Denominator is # surviving sims (NOT player-team-conditioned). A player
 * whose team is eliminated in every surviving sim shows 0 — which is the
 * correct interpretation under the user's hypothetical.
 *
 * Per-round breakdown is omitted in v1: `simMatrix` only stores per-sim
 * totals, not per-sim-per-round. Surface that in v2 if needed. */
export function computeConditionalPlayers(
  results: SimResults,
  mask: Uint8Array,
): ConditionalPlayerRow[] {
  const N = results.numSims;
  const numPlayers = results.playerIndex.size;
  const surviving = maskCount(mask);
  const denom = surviving > 0 ? surviving : 1;

  const baselineByEspn = new Map<string, number>();
  for (const p of results.players) baselineByEspn.set(p.espnId, p.projectedPoints);

  const rows: ConditionalPlayerRow[] = [];
  for (const [espnId, col] of results.playerIndex) {
    const baseProjection = results.players.find((p) => p.espnId === espnId);
    if (!baseProjection) continue;
    let sum = 0;
    for (let i = 0; i < N; i++) {
      if (mask[i]) sum += results.simMatrix[i * numPlayers + col];
    }
    const condPts = surviving > 0 ? sum / denom : 0;
    rows.push({
      espnId,
      name: baseProjection.name,
      team: baseProjection.team,
      baselinePoints: baseProjection.projectedPoints,
      conditionalPoints: condPts,
      delta: condPts - baseProjection.projectedPoints,
    });
  }
  return rows;
}

/** For each forced-able slot, return the distribution of teams that have
 *  appeared as winner across all sims (used to populate UI dropdowns).
 *  Filters out near-zero-frequency entries (< 0.5%). */
export function computeSlotOptions(
  results: SimResults,
): Record<SlotKey, Array<{ teamIdx: number; team: string; pct: number }>> {
  const N = results.numSims;
  const out = {} as Record<SlotKey, Array<{ teamIdx: number; team: string; pct: number }>>;

  const tally = (arr: Uint8Array) => {
    const counts = new Uint32Array(results.teamNames.length);
    for (let i = 0; i < N; i++) counts[arr[i]]++;
    const opts: Array<{ teamIdx: number; team: string; pct: number }> = [];
    for (let i = 0; i < counts.length; i++) {
      if (counts[i] === 0) continue;
      const pct = (counts[i] / N) * 100;
      if (pct < 0.5) continue;
      opts.push({ teamIdx: i, team: results.teamNames[i], pct });
    }
    opts.sort((a, b) => b.pct - a.pct);
    return opts;
  };

  for (const k of SERIES_KEYS) out[k] = tally(results.seriesWinners[k]);
  for (const k of PLAYIN_KEYS) out[k] = tally(results.playinSeeds[k]);
  return out;
}
