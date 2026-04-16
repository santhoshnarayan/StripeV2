/**
 * Component B: Auction Draft Optimizer
 *
 * Given the sim matrix from Component A (per-sim per-player fantasy totals)
 * and the current league roster state, computes:
 *   - Each manager's projected point distribution + win probability
 *   - Marginal win probability of drafting each remaining player
 *   - Opponent valuations (what each manager "should" bid)
 *   - Suggested bid amounts
 *
 * This runs cheaply (~50-100ms for 173 players × 10K sims) without
 * re-running the tournament simulation.
 */

import type {
  SimResults,
  ManagerProjection,
  MarginalValue,
} from "./types";

// ─── Roster → sim-matrix column sums ────────────────────────────────

/**
 * For each sim, sum the player columns for a given set of ESPN IDs.
 * Returns a Float64Array of length numSims with the per-sim roster total.
 */
function rosterSimTotals(
  simMatrix: Float64Array,
  playerIndex: Map<string, number>,
  espnIds: string[],
  numSims: number,
  numPlayers: number,
): Float64Array {
  const totals = new Float64Array(numSims);
  for (const id of espnIds) {
    const col = playerIndex.get(id);
    if (col == null) continue;
    for (let sim = 0; sim < numSims; sim++) {
      totals[sim] += simMatrix[sim * numPlayers + col];
    }
  }
  return totals;
}

function percentile(arr: Float64Array, p: number): number {
  const sorted = Float64Array.from(arr).sort();
  const idx = Math.min(Math.floor(p * sorted.length), sorted.length - 1);
  return sorted[idx];
}

function mean(arr: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i];
  return sum / arr.length;
}

function stddev(arr: Float64Array, meanVal: number): number {
  let sumSq = 0;
  for (let i = 0; i < arr.length; i++) {
    const diff = arr[i] - meanVal;
    sumSq += diff * diff;
  }
  return Math.sqrt(sumSq / arr.length);
}

// ─── Manager projections + win probability ──────────────────────────

export interface RosterInput {
  userId: string;
  name: string;
  /** ESPN IDs of players on this manager's roster */
  playerIds: string[];
}

/**
 * Compute each manager's projected total distribution + win probability.
 * Win probability = fraction of sims where that manager has the highest total.
 */
export function computeManagerProjections(
  simResults: SimResults,
  rosters: RosterInput[],
): ManagerProjection[] {
  const { simMatrix, playerIndex, numSims } = simResults;
  const numPlayers = playerIndex.size;

  // Pre-compute per-manager per-sim totals
  const managerTotals = rosters.map((roster) =>
    rosterSimTotals(simMatrix, playerIndex, roster.playerIds, numSims, numPlayers),
  );

  // Count wins per manager (ties go to the first manager found, but
  // they're vanishingly rare with continuous point distributions)
  const winCounts = new Uint32Array(rosters.length);
  for (let sim = 0; sim < numSims; sim++) {
    let bestIdx = 0;
    let bestTotal = managerTotals[0][sim];
    for (let m = 1; m < rosters.length; m++) {
      if (managerTotals[m][sim] > bestTotal) {
        bestIdx = m;
        bestTotal = managerTotals[m][sim];
      }
    }
    winCounts[bestIdx]++;
  }

  return rosters.map((roster, idx) => {
    const totals = managerTotals[idx];
    const m = mean(totals);
    return {
      userId: roster.userId,
      name: roster.name,
      mean: m,
      stddev: stddev(totals, m),
      p10: percentile(totals, 0.1),
      p90: percentile(totals, 0.9),
      winProbability: winCounts[idx] / numSims,
    };
  });
}

// ─── Marginal value of drafting a player ────────────────────────────

/**
 * For each available player, compute the marginal win probability change
 * if a specific manager drafts that player.
 *
 * Returns results sorted by marginalWinProb descending.
 */
export function computeMarginalValues(
  simResults: SimResults,
  rosters: RosterInput[],
  viewerManagerIndex: number,
  availablePlayerIds: string[],
  budget: number,
  slotsRemaining: number,
  minBid: number,
): MarginalValue[] {
  const { simMatrix, playerIndex, numSims, players: playerProjections } = simResults;
  const numPlayers = playerIndex.size;

  // Pre-compute current per-manager per-sim totals
  const managerTotals = rosters.map((roster) =>
    rosterSimTotals(simMatrix, playerIndex, roster.playerIds, numSims, numPlayers),
  );

  // Current win probability for the viewer
  let currentWins = 0;
  for (let sim = 0; sim < numSims; sim++) {
    let best = -1;
    let bestIdx = -1;
    for (let m = 0; m < rosters.length; m++) {
      if (managerTotals[m][sim] > best) {
        best = managerTotals[m][sim];
        bestIdx = m;
      }
    }
    if (bestIdx === viewerManagerIndex) currentWins++;
  }
  const currentWinProb = currentWins / numSims;

  // Player projection lookup
  const projByEspnId = new Map(
    playerProjections.map((p) => [p.espnId, p]),
  );

  const results: MarginalValue[] = [];
  const viewerTotals = managerTotals[viewerManagerIndex];

  for (const espnId of availablePlayerIds) {
    const col = playerIndex.get(espnId);
    if (col == null) continue;

    // Count wins if viewer adds this player
    let newWins = 0;
    for (let sim = 0; sim < numSims; sim++) {
      const viewerWithPlayer = viewerTotals[sim] + simMatrix[sim * numPlayers + col];
      let isWinner = true;
      for (let m = 0; m < rosters.length; m++) {
        if (m === viewerManagerIndex) continue;
        if (managerTotals[m][sim] >= viewerWithPlayer) {
          isWinner = false;
          break;
        }
      }
      if (isWinner) newWins++;
    }
    const newWinProb = newWins / numSims;
    const marginal = newWinProb - currentWinProb;

    const proj = projByEspnId.get(espnId);
    const projectedPoints = proj?.projectedPoints ?? 0;

    // Suggested bid: scale marginal win prob by budget/slots to get a dollar value.
    // lambda = budget available above minimums / total marginal opportunity
    const freeBudget = Math.max(0, budget - (slotsRemaining - 1) * minBid);
    const suggestedBid = Math.max(
      minBid,
      Math.min(
        freeBudget,
        Math.round(marginal * freeBudget * 10), // scale factor tuned for visibility
      ),
    );

    results.push({
      espnId,
      playerName: proj?.name ?? espnId,
      team: proj?.team ?? "",
      projectedPoints,
      currentWinProb,
      newWinProb,
      marginalWinProb: marginal,
      suggestedBid,
    });
  }

  results.sort((a, b) => b.marginalWinProb - a.marginalWinProb);
  return results;
}

/**
 * Compute marginal values for ALL managers (not just the viewer).
 * Returns a map from manager userId to their marginal value list.
 */
export function computeAllManagerMarginals(
  simResults: SimResults,
  rosters: RosterInput[],
  availablePlayerIds: string[],
  budgets: Map<string, { budget: number; slotsRemaining: number }>,
  minBid: number,
): Map<string, MarginalValue[]> {
  const result = new Map<string, MarginalValue[]>();
  for (let m = 0; m < rosters.length; m++) {
    const info = budgets.get(rosters[m].userId);
    const marginals = computeMarginalValues(
      simResults,
      rosters,
      m,
      availablePlayerIds,
      info?.budget ?? 200,
      info?.slotsRemaining ?? 10,
      minBid,
    );
    result.set(rosters[m].userId, marginals);
  }
  return result;
}
