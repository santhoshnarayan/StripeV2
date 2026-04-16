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

/**
 * Compute manager projections after simulating a greedy forward draft to
 * fill all remaining roster slots. Used when the draft hasn't started or
 * is partially complete.
 */
export function computeManagerProjectionsWithDraftSim(
  simResults: SimResults,
  rosters: RosterInput[],
  availablePlayerIds: string[],
  managerBudgets: ManagerBudgetInfo[],
  minBid: number,
): ManagerProjection[] {
  const { simMatrix, playerIndex, numSims, players: playerProjections } = simResults;
  const numPlayers = playerIndex.size;

  const projByEspnId = new Map(
    playerProjections.map((p) => [p.espnId, p]),
  );

  // Sort available players by projected points for greedy picking
  const sortedAvailable = [...availablePlayerIds].sort((a, b) => {
    const pa = projByEspnId.get(a)?.projectedPoints ?? 0;
    const pb = projByEspnId.get(b)?.projectedPoints ?? 0;
    return pb - pa;
  });

  // Greedy draft: fill remaining slots
  const filledRosterIds = rosters.map((r) => [...r.playerIds]);
  const pool = new Set(availablePlayerIds);
  const slots = managerBudgets.map((b) => b.remainingRosterSlots);
  const maxRounds = Math.max(...slots, 0);

  for (let round = 0; round < maxRounds; round++) {
    for (let m = 0; m < filledRosterIds.length; m++) {
      if (slots[m] <= 0) continue;
      let bestId: string | null = null;
      for (const pid of sortedAvailable) {
        if (!pool.has(pid)) continue;
        bestId = pid;
        break;
      }
      if (bestId) {
        filledRosterIds[m].push(bestId);
        pool.delete(bestId);
        slots[m]--;
      }
    }
  }

  // Now compute projections with filled rosters
  const filledRosters: RosterInput[] = rosters.map((r, i) => ({
    ...r,
    playerIds: filledRosterIds[i],
  }));

  return computeManagerProjections(simResults, filledRosters);
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

    results.push({
      espnId,
      playerName: proj?.name ?? espnId,
      team: proj?.team ?? "",
      projectedPoints,
      currentWinProb,
      newWinProb,
      marginalWinProb: marginal,
      suggestedBid: 0, // computed below after all marginals known
    });
  }

  // Compute suggested bids proportionally: each player's share of the total
  // positive marginal, allocated across the per-slot budget.
  const freeBudget = Math.max(0, budget - (slotsRemaining - 1) * minBid);
  const perSlotBudget = slotsRemaining > 0 ? budget / slotsRemaining : budget;
  const totalPositiveMarginal = results.reduce(
    (sum, r) => sum + Math.max(0, r.marginalWinProb),
    0,
  );

  for (const r of results) {
    if (totalPositiveMarginal > 0 && r.marginalWinProb > 0) {
      const share = r.marginalWinProb / totalPositiveMarginal;
      // Bid = share of total marginal × per-slot budget × number of slots
      // (top players get proportionally more, but capped at freeBudget)
      const rawBid = share * perSlotBudget * slotsRemaining;
      r.suggestedBid = Math.max(
        minBid,
        Math.min(freeBudget, Math.round(rawBid)),
      );
    } else {
      r.suggestedBid = r.marginalWinProb > 0 ? minBid : 0;
    }
  }

  results.sort((a, b) => b.marginalWinProb - a.marginalWinProb);
  return results;
}

// ─── Forward draft simulation ──────────────────────────────────────

export interface ManagerBudgetInfo {
  userId: string;
  remainingBudget: number;
  remainingRosterSlots: number;
}

/**
 * Compute marginal values with opponent modeling and auction simulation.
 *
 * 1. Compute single-step marginal win probability for EVERY manager × top players
 * 2. Convert each manager's marginal to a max willingness-to-pay (lambda × deltaWP)
 * 3. For viewer's candidates, simulate the forward draft with budget-aware auction:
 *    - Viewer bids for a target at a specific price
 *    - Other managers bid based on their valuations
 *    - Remaining draft fills out greedily
 * 4. Find the optimal bid that maximizes post-draft win probability minus cost
 */
export function computeMarginalValuesWithDraftSim(
  simResults: SimResults,
  rosters: RosterInput[],
  viewerManagerIndex: number,
  availablePlayerIds: string[],
  managerBudgets: ManagerBudgetInfo[],
  minBid: number,
  rosterSize: number,
): MarginalValue[] {
  const { simMatrix, playerIndex, numSims, players: playerProjections } = simResults;
  const numPlayers = playerIndex.size;

  const projByEspnId = new Map(
    playerProjections.map((p) => [p.espnId, p]),
  );

  // Sort available players by projected points for greedy picking
  const sortedAvailable = [...availablePlayerIds].sort((a, b) => {
    const pa = projByEspnId.get(a)?.projectedPoints ?? 0;
    const pb = projByEspnId.get(b)?.projectedPoints ?? 0;
    return pb - pa;
  });

  // ── Step 1: Compute single-step marginals for ALL managers ──────────
  // Pre-compute per-manager per-sim totals
  const managerTotals = rosters.map((roster) =>
    rosterSimTotals(simMatrix, playerIndex, roster.playerIds, numSims, numPlayers),
  );

  // Current viewer win probability
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

  // Top candidates to evaluate
  const candidateIds = sortedAvailable.slice(0, 50);

  // For each manager, compute marginal win prob for each candidate (single-step)
  // managerMarginals[m][playerId] = deltaWP if manager m adds this player
  const managerMarginals: Map<string, number>[] = [];
  for (let m = 0; m < rosters.length; m++) {
    const margMap = new Map<string, number>();
    // Current win count for this manager
    let mWins = 0;
    for (let sim = 0; sim < numSims; sim++) {
      let best = -1;
      let bestIdx = -1;
      for (let mm = 0; mm < rosters.length; mm++) {
        if (managerTotals[mm][sim] > best) {
          best = managerTotals[mm][sim];
          bestIdx = mm;
        }
      }
      if (bestIdx === m) mWins++;
    }
    const mCurrentWP = mWins / numSims;

    for (const pid of candidateIds) {
      const col = playerIndex.get(pid);
      if (col == null) continue;
      let newWins = 0;
      for (let sim = 0; sim < numSims; sim++) {
        const withPlayer = managerTotals[m][sim] + simMatrix[sim * numPlayers + col];
        let isWinner = true;
        for (let mm = 0; mm < rosters.length; mm++) {
          if (mm === m) continue;
          if (managerTotals[mm][sim] >= withPlayer) {
            isWinner = false;
            break;
          }
        }
        if (isWinner) newWins++;
      }
      margMap.set(pid, (newWins / numSims) - mCurrentWP);
    }
    managerMarginals.push(margMap);
  }

  // ── Step 2: Convert marginals to max willingness-to-pay ─────────────
  // lambda_m = remaining budget / remaining slots (how much a win% point is worth in $)
  // maxBid_m,p = lambda_m × deltaWP_m,p × scaleFactor
  // scaleFactor accounts for the fact that deltaWP is small (0-10%) but budgets are $200
  const opponentMaxBids: Map<string, number[]> = new Map(); // playerId → bid per manager
  for (const pid of candidateIds) {
    const bids: number[] = [];
    for (let m = 0; m < rosters.length; m++) {
      const info = managerBudgets[m];
      if (!info || info.remainingRosterSlots <= 0) {
        bids.push(0);
        continue;
      }
      const lambda = info.remainingBudget / info.remainingRosterSlots;
      const deltaWP = managerMarginals[m].get(pid) ?? 0;
      // Scale: if deltaWP is 5% and lambda is $20/slot, raw = $1.
      // Multiply by numManagers to approximate auction competition pressure.
      const rawBid = lambda * deltaWP * rosters.length * 10;
      const maxAllowed = Math.max(0, info.remainingBudget - (info.remainingRosterSlots - 1) * minBid);
      bids.push(Math.max(0, Math.min(maxAllowed, Math.round(rawBid))));
    }
    opponentMaxBids.set(pid, bids);
  }

  // ── Step 3: Greedy forward draft helper ─────────────────────────────
  function simulateGreedyDraft(
    rosterPlayerIds: string[][],
    available: Set<string>,
    budgets: number[],
    slots: number[],
  ): string[][] {
    const result = rosterPlayerIds.map((ids) => [...ids]);
    const pool = new Set(available);
    const maxRounds = Math.max(...slots, 0);
    for (let round = 0; round < maxRounds; round++) {
      for (let m = 0; m < result.length; m++) {
        if (slots[m] <= 0) continue;
        let bestId: string | null = null;
        for (const pid of sortedAvailable) {
          if (!pool.has(pid)) continue;
          bestId = pid;
          break;
        }
        if (bestId) {
          result[m].push(bestId);
          pool.delete(bestId);
          slots[m]--;
          budgets[m] -= minBid;
        }
      }
    }
    return result;
  }

  // ── Step 4: Evaluate each candidate with forward draft sim ──────────
  const results: MarginalValue[] = [];

  for (const candidateId of candidateIds) {
    const col = playerIndex.get(candidateId);
    if (col == null) continue;

    const proj = projByEspnId.get(candidateId);
    const projectedPoints = proj?.projectedPoints ?? 0;

    // Viewer drafts this player; simulate the rest greedily
    const newRosterIds = rosters.map((r, i) => {
      if (i === viewerManagerIndex) return [...r.playerIds, candidateId];
      return [...r.playerIds];
    });
    const remaining = new Set(availablePlayerIds.filter((id) => id !== candidateId));
    const budgets = managerBudgets.map((b) => b.remainingBudget);
    const slots = managerBudgets.map((b, i) =>
      i === viewerManagerIndex ? b.remainingRosterSlots - 1 : b.remainingRosterSlots,
    );
    const filledRosters = simulateGreedyDraft(newRosterIds, remaining, budgets, slots);

    // Win probability after full draft
    const filledTotals = filledRosters.map((ids) =>
      rosterSimTotals(simMatrix, playerIndex, ids, numSims, numPlayers),
    );
    let wins = 0;
    for (let sim = 0; sim < numSims; sim++) {
      let best = -1;
      let bestIdx = -1;
      for (let m = 0; m < filledTotals.length; m++) {
        if (filledTotals[m][sim] > best) {
          best = filledTotals[m][sim];
          bestIdx = m;
        }
      }
      if (bestIdx === viewerManagerIndex) wins++;
    }
    const newWinProb = wins / numSims;

    // Suggested bid: beat the highest opponent bid, but don't exceed viewer's max value
    const oppBids = opponentMaxBids.get(candidateId) ?? [];
    const oppBidsExViewer = oppBids.filter((_, i) => i !== viewerManagerIndex);
    const highestOppBid = Math.max(0, ...oppBidsExViewer);
    const viewerMaxBid = Math.max(
      0,
      managerBudgets[viewerManagerIndex].remainingBudget
        - (managerBudgets[viewerManagerIndex].remainingRosterSlots - 1) * minBid,
    );
    // Bid = just enough to beat the highest opponent, capped by own max
    const suggestedBid = Math.max(
      minBid,
      Math.min(viewerMaxBid, highestOppBid + 1),
    );

    results.push({
      espnId: candidateId,
      playerName: proj?.name ?? candidateId,
      team: proj?.team ?? "",
      projectedPoints,
      currentWinProb,
      newWinProb,
      marginalWinProb: newWinProb - currentWinProb,
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
