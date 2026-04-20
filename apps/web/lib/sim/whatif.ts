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
  /** Per-round means [R1, R2, CF, Finals]. Baseline values come straight from
   *  PlayerProjection. Conditional values are approximated by scaling baseline
   *  with the team's per-round reach ratio (cond reach / base reach), since
   *  per-sim per-round player pts isn't tracked in simMatrix. */
  baselinePointsByRound: number[];
  baselineGamesByRound: number[];
  conditionalPointsByRound: number[];
  conditionalGamesByRound: number[];
  /** Per-game means, length 28 = 4 rounds × 7 games. Index = round*7 + gameNum.
   *  Conditional values scale baseline by the round-r multiplier (same as
   *  conditionalPointsByRound), so sum_g(condByGame[r*7+g]) ≈ condByRound[r]. */
  baselinePointsByGame: number[];
  baselineGamesByGame: number[];
  conditionalPointsByGame: number[];
  conditionalGamesByGame: number[];
}

export interface ConditionalManagerRow {
  userId: string;
  name: string;
  baselineMean: number;
  baselineWinPct: number;
  conditionalMean: number;
  conditionalWinPct: number;
  meanDelta: number;
  winDelta: number;
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

  // Pre-compute per-team baseline+conditional reach counts for each of the 4
  // rounds so we can derive per-round multipliers without a per-team loop
  // inside the per-player loop. reach[r] = "team reached round r+1" semantics:
  //   r=0 → in main bracket (trr ≥ 1)
  //   r=1 → won R1 (trr ≥ 2) → played R2
  //   r=2 → won R2 (trr ≥ 3) → played CF
  //   r=3 → won CF (trr ≥ 4) → played Finals
  const teamReach = new Map<string, { base: Uint32Array; cond: Uint32Array }>();
  for (const team in results.teamRoundReached) {
    const trr = results.teamRoundReached[team];
    const base = new Uint32Array(4);
    const cond = new Uint32Array(4);
    for (let i = 0; i < N; i++) {
      const r = trr[i];
      if (r >= 1) {
        base[0]++;
        if (mask[i]) cond[0]++;
      }
      if (r >= 2) {
        base[1]++;
        if (mask[i]) cond[1]++;
      }
      if (r >= 3) {
        base[2]++;
        if (mask[i]) cond[2]++;
      }
      if (r >= 4) {
        base[3]++;
        if (mask[i]) cond[3]++;
      }
    }
    teamReach.set(team, { base, cond });
  }

  const rows: ConditionalPlayerRow[] = [];
  for (const [espnId, col] of results.playerIndex) {
    const baseProjection = results.players.find((p) => p.espnId === espnId);
    if (!baseProjection) continue;
    let sum = 0;
    for (let i = 0; i < N; i++) {
      if (mask[i]) sum += results.simMatrix[i * numPlayers + col];
    }
    const condPts = surviving > 0 ? sum / denom : 0;

    const basePtsRound = baseProjection.projectedPointsByRound ?? [0, 0, 0, 0];
    const baseGamesRound = baseProjection.projectedGamesByRound ?? [0, 0, 0, 0];
    const basePtsGame =
      baseProjection.projectedPointsByGame ?? new Array(28).fill(0);
    const baseGamesGame =
      baseProjection.projectedGamesByGame ?? new Array(28).fill(0);

    // Conditional per-round = baseline × multiplier. Multiplier renormalizes
    // by team's reach: a team forced into the Finals shows ~10× their
    // baseline Finals pts (their pts conditional on reaching it).
    const tr = teamReach.get(baseProjection.team);
    const condPtsRound = [0, 0, 0, 0];
    const condGamesRound = [0, 0, 0, 0];
    const condPtsGame = new Array(28).fill(0);
    const condGamesGame = new Array(28).fill(0);
    if (tr && surviving > 0) {
      const teamPlayoffSimsBaseline = tr.base[0]; // trr ≥ 1 baseline count
      for (let r = 0; r < 4; r++) {
        if (tr.base[r] === 0 || teamPlayoffSimsBaseline === 0) continue;
        // Recover per-trip mean: basePts is sum(pts in round r) / playoffSims.
        // Per-trip = basePts × playoffSims / baseReach[r]. Then conditional
        // average over surviving sims = perTrip × condReach[r] / surviving.
        const mult = (teamPlayoffSimsBaseline * tr.cond[r]) / (tr.base[r] * surviving);
        condPtsRound[r] = basePtsRound[r] * mult;
        condGamesRound[r] = baseGamesRound[r] * mult;
        // Per-game uses same per-round multiplier — sum across games in a
        // round still equals the round total.
        for (let g = 0; g < 7; g++) {
          const idx = r * 7 + g;
          condPtsGame[idx] = basePtsGame[idx] * mult;
          condGamesGame[idx] = baseGamesGame[idx] * mult;
        }
      }
    }

    rows.push({
      espnId,
      name: baseProjection.name,
      team: baseProjection.team,
      baselinePoints: baseProjection.projectedPoints,
      conditionalPoints: condPts,
      delta: condPts - baseProjection.projectedPoints,
      baselinePointsByRound: basePtsRound,
      baselineGamesByRound: baseGamesRound,
      conditionalPointsByRound: condPtsRound,
      conditionalGamesByRound: condGamesRound,
      baselinePointsByGame: basePtsGame,
      baselineGamesByGame: baseGamesGame,
      conditionalPointsByGame: condPtsGame,
      conditionalGamesByGame: condGamesGame,
    });
  }
  return rows;
}

/** Per-manager mean and win % over surviving sims (with `mask`) vs baseline.
 *
 * Baseline is computed over all sims so the "Δ" column is meaningful even if
 * `forces` collapses the surviving set to a small slice. Win % counts sims
 * where the manager has the highest roster total in the (sub)set considered.
 */
export function computeConditionalManagers(
  results: SimResults,
  mask: Uint8Array,
  rosters: Array<{ userId: string; name: string; playerIds: string[] }>,
): ConditionalManagerRow[] {
  const N = results.numSims;
  const numPlayers = results.playerIndex.size;
  const surviving = maskCount(mask);

  // Per-manager per-sim totals (computed once, reused for both baseline +
  // conditional aggregates).
  const totals: Float64Array[] = rosters.map((r) => {
    const t = new Float64Array(N);
    for (const id of r.playerIds) {
      const col = results.playerIndex.get(id);
      if (col == null) continue;
      for (let sim = 0; sim < N; sim++) t[sim] += results.simMatrix[sim * numPlayers + col];
    }
    return t;
  });

  const baselineSum = new Float64Array(rosters.length);
  const conditionalSum = new Float64Array(rosters.length);
  const baselineWins = new Uint32Array(rosters.length);
  const conditionalWins = new Uint32Array(rosters.length);

  for (let sim = 0; sim < N; sim++) {
    let bestIdx = 0;
    let bestTotal = totals[0]?.[sim] ?? -Infinity;
    for (let m = 0; m < rosters.length; m++) {
      baselineSum[m] += totals[m][sim];
      if (m > 0 && totals[m][sim] > bestTotal) {
        bestIdx = m;
        bestTotal = totals[m][sim];
      }
    }
    if (rosters.length > 0) baselineWins[bestIdx]++;

    if (mask[sim]) {
      let condBestIdx = 0;
      let condBestTotal = totals[0]?.[sim] ?? -Infinity;
      for (let m = 0; m < rosters.length; m++) {
        conditionalSum[m] += totals[m][sim];
        if (m > 0 && totals[m][sim] > condBestTotal) {
          condBestIdx = m;
          condBestTotal = totals[m][sim];
        }
      }
      if (rosters.length > 0) conditionalWins[condBestIdx]++;
    }
  }

  const condDenom = surviving > 0 ? surviving : 1;
  return rosters.map((r, i) => {
    const baselineMean = baselineSum[i] / N;
    const baselineWinPct = (baselineWins[i] / N) * 100;
    const conditionalMean = surviving > 0 ? conditionalSum[i] / condDenom : 0;
    const conditionalWinPct = surviving > 0 ? (conditionalWins[i] / condDenom) * 100 : 0;
    return {
      userId: r.userId,
      name: r.name,
      baselineMean,
      baselineWinPct,
      conditionalMean,
      conditionalWinPct,
      meanDelta: conditionalMean - baselineMean,
      winDelta: conditionalWinPct - baselineWinPct,
    };
  });
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
