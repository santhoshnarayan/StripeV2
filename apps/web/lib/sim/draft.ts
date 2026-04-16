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

  // ── Step 2: Compute opponent demand (how many managers want each player) ───
  // For each player, count how many opponents rank it in their top-N (where N = their remaining slots)
  const opponentDemand = new Map<string, number>();
  for (let m = 0; m < rosters.length; m++) {
    if (m === viewerManagerIndex) continue;
    const slots = managerBudgets[m]?.remainingRosterSlots ?? 0;
    if (slots <= 0) continue;
    // Rank this manager's candidates by their marginal
    const ranked = [...candidateIds]
      .map((pid) => ({ pid, marg: managerMarginals[m].get(pid) ?? 0 }))
      .sort((a, b) => b.marg - a.marg)
      .slice(0, slots);
    for (const { pid } of ranked) {
      opponentDemand.set(pid, (opponentDemand.get(pid) ?? 0) + 1);
    }
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

    results.push({
      espnId: candidateId,
      playerName: proj?.name ?? candidateId,
      team: proj?.team ?? "",
      projectedPoints,
      currentWinProb,
      newWinProb,
      marginalWinProb: newWinProb - currentWinProb,
      suggestedBid: 0, // computed below
    });
  }

  // ── Step 5: Bid allocation ──────────────────────────────────────────
  // Use value-above-replacement (VARP) with demand-adjusted premiums.
  // 1. Rank by marginal, find replacement level (slots+1 th best)
  // 2. Allocate budget proportionally to value above replacement
  // 3. Boost bids for high-demand players (many opponents want them)
  const viewerBudget = managerBudgets[viewerManagerIndex];
  const viewerSlots = viewerBudget.remainingRosterSlots;
  const budget = viewerBudget.remainingBudget;
  const freeBudget = Math.max(0, budget - (viewerSlots - 1) * minBid);
  const perSlotBudget = viewerSlots > 0 ? budget / viewerSlots : budget;

  const ranked = [...results].sort((a, b) => b.marginalWinProb - a.marginalWinProb);
  const replacementMarginal = ranked.length > viewerSlots
    ? Math.max(0, ranked[viewerSlots]?.marginalWinProb ?? 0)
    : 0;

  // Only players above replacement share the budget
  let totalVAR = 0;
  const varMap = new Map<string, number>();
  for (const r of results) {
    const v = Math.max(0, r.marginalWinProb - replacementMarginal);
    varMap.set(r.espnId, v);
    totalVAR += v;
  }

  for (const r of results) {
    const v = varMap.get(r.espnId) ?? 0;
    if (totalVAR > 0 && v > 0) {
      // Base bid from VARP share of budget
      const share = v / totalVAR;
      let rawBid = share * budget;

      // Demand premium: if multiple opponents want this player, bid more aggressively
      const demand = opponentDemand.get(r.espnId) ?? 0;
      const demandMultiplier = 1 + demand * 0.15; // +15% per competing manager
      rawBid *= demandMultiplier;

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

// ─── Equilibrium bid simulation ────────────────────────────────────

export interface EquilibriumBidRow {
  espnId: string;
  playerName: string;
  team: string;
  projectedPoints: number;
  /** Bid per manager index (same order as rosters). */
  bids: number[];
}

export interface EquilibriumResult {
  players: EquilibriumBidRow[];
  managerNames: string[];
  iterations: number;
}

/**
 * Simulate an auction draft given bid vectors for all teams.
 * Players are auctioned in order of highest total demand (sum of bids).
 * Highest bidder wins and pays their bid. Returns rosters as espnId arrays.
 */
function simulateAuction(
  playerIds: string[],
  bidMatrix: number[][],  // [managerIdx][playerIdx]
  budgets: number[],
  slots: number[],
  minBid: number,
  noise: number,
): string[][] {
  const rosters: string[][] = budgets.map(() => []);
  const remainBudget = [...budgets];
  const remainSlots = [...slots];

  // Order players by total demand (sum of all bids)
  const order = playerIds
    .map((_, pi) => ({
      pi,
      demand: bidMatrix.reduce((s, mgr) => s + mgr[pi], 0),
    }))
    .sort((a, b) => b.demand - a.demand)
    .map((o) => o.pi);

  for (const pi of order) {
    let bestM = -1;
    let bestBid = -1;
    for (let m = 0; m < budgets.length; m++) {
      if (remainSlots[m] <= 0) continue;
      const maxAllowed = remainBudget[m] - (remainSlots[m] - 1) * minBid;
      if (maxAllowed < minBid) continue;
      // Add noise to bid for simulation variance
      const noisyBid = bidMatrix[m][pi] + (noise > 0 ? (Math.random() - 0.5) * 2 * noise : 0);
      const effectiveBid = Math.max(0, Math.min(maxAllowed, Math.round(noisyBid)));
      if (effectiveBid > bestBid) {
        bestBid = effectiveBid;
        bestM = m;
      }
    }
    if (bestM >= 0 && bestBid >= minBid) {
      rosters[bestM].push(playerIds[pi]);
      remainBudget[bestM] -= bestBid;
      remainSlots[bestM]--;
    }
  }

  return rosters;
}

/**
 * Compute win probability for each manager given their drafted rosters.
 */
function computeWinProbs(
  simMatrix: Float64Array,
  playerIndex: Map<string, number>,
  numSims: number,
  numPlayers: number,
  draftedRosters: string[][],
): number[] {
  const totals = draftedRosters.map((ids) =>
    rosterSimTotals(simMatrix, playerIndex, ids, numSims, numPlayers),
  );
  const wins = new Float64Array(draftedRosters.length);
  for (let sim = 0; sim < numSims; sim++) {
    let best = -1;
    let bestIdx = 0;
    for (let m = 0; m < totals.length; m++) {
      if (totals[m][sim] > best) {
        best = totals[m][sim];
        bestIdx = m;
      }
    }
    wins[bestIdx]++;
  }
  return Array.from(wins, (w) => w / numSims);
}

/**
 * Iterated best-response equilibrium bid simulation.
 *
 * 1. Initialize each team's bids from their VARP-based marginal win probabilities
 * 2. Simulate N auctions with current bids + noise
 * 3. Each team evaluates: for each player, would bidding more/less improve my avg win prob?
 * 4. Adjust bids accordingly
 * 5. Repeat for K iterations
 * 6. Return the converged bid matrix for all teams × all players
 */
export function computeEquilibriumBids(
  simResults: SimResults,
  rosters: RosterInput[],
  availablePlayerIds: string[],
  managerBudgets: ManagerBudgetInfo[],
  minBid: number,
  iterations: number = 5,
  auctionsPerIteration: number = 20,
): EquilibriumResult {
  const { simMatrix, playerIndex, numSims, players: playerProjections } = simResults;
  const numPlayers = playerIndex.size;
  const nManagers = rosters.length;
  const nPlayers = availablePlayerIds.length;

  const projByEspnId = new Map(
    playerProjections.map((p) => [p.espnId, p]),
  );

  // ── Initialize bids from single-step marginals (VARP) ──────────────
  // Compute marginals for each manager
  const managerTotals = rosters.map((roster) =>
    rosterSimTotals(simMatrix, playerIndex, roster.playerIds, numSims, numPlayers),
  );

  // bidMatrix[m][p] = manager m's bid on player p
  const bidMatrix: number[][] = [];

  for (let m = 0; m < nManagers; m++) {
    const info = managerBudgets[m];
    const budget = info.remainingBudget;
    const slots = info.remainingRosterSlots;
    if (slots <= 0) {
      bidMatrix.push(new Array(nPlayers).fill(0));
      continue;
    }

    // Compute marginal for this manager
    let mWins = 0;
    for (let sim = 0; sim < numSims; sim++) {
      let best = -1;
      let bestIdx = 0;
      for (let mm = 0; mm < nManagers; mm++) {
        if (managerTotals[mm][sim] > best) {
          best = managerTotals[mm][sim];
          bestIdx = mm;
        }
      }
      if (bestIdx === m) mWins++;
    }
    const mWP = mWins / numSims;

    const marginals: number[] = [];
    for (let p = 0; p < nPlayers; p++) {
      const col = playerIndex.get(availablePlayerIds[p]);
      if (col == null) { marginals.push(0); continue; }
      let newWins = 0;
      for (let sim = 0; sim < numSims; sim++) {
        const withP = managerTotals[m][sim] + simMatrix[sim * numPlayers + col];
        let isWin = true;
        for (let mm = 0; mm < nManagers; mm++) {
          if (mm === m) continue;
          if (managerTotals[mm][sim] >= withP) { isWin = false; break; }
        }
        if (isWin) newWins++;
      }
      marginals.push(Math.max(0, (newWins / numSims) - mWP));
    }

    // VARP initialization: distribute budget by marginal share
    const sorted = [...marginals].sort((a, b) => b - a);
    const repl = sorted[Math.min(slots, sorted.length - 1)] ?? 0;
    let totalVAR = 0;
    const vars = marginals.map((mg) => { const v = Math.max(0, mg - repl); totalVAR += v; return v; });

    const bids = vars.map((v) => {
      if (totalVAR <= 0 || v <= 0) return 0;
      const maxAllowed = Math.max(0, budget - (slots - 1) * minBid);
      return Math.max(0, Math.min(maxAllowed, Math.round((v / totalVAR) * budget)));
    });
    bidMatrix.push(bids);
  }

  // Helper: compute VARP bids for one manager given their expected roster context
  function computeVARPBids(
    m: number,
    expectedRosterTotals: Float64Array, // per-sim totals for manager m's expected roster
    allTotals: Float64Array[],          // per-sim totals for all managers
  ): number[] {
    const info = managerBudgets[m];
    const budget = info.remainingBudget;
    const slots = info.remainingRosterSlots;
    if (slots <= 0) return new Array(nPlayers).fill(0);

    // Compute current win prob for this manager
    let mWins = 0;
    for (let sim = 0; sim < numSims; sim++) {
      let best = -1;
      let bestIdx = 0;
      for (let mm = 0; mm < nManagers; mm++) {
        if (allTotals[mm][sim] > best) {
          best = allTotals[mm][sim];
          bestIdx = mm;
        }
      }
      if (bestIdx === m) mWins++;
    }
    const mWP = mWins / numSims;

    // Compute marginal for each available player
    const marginals: number[] = [];
    for (let p = 0; p < nPlayers; p++) {
      const col = playerIndex.get(availablePlayerIds[p]);
      if (col == null) { marginals.push(0); continue; }
      let newWins = 0;
      for (let sim = 0; sim < numSims; sim++) {
        const withP = expectedRosterTotals[sim] + simMatrix[sim * numPlayers + col];
        let isWin = true;
        for (let mm = 0; mm < nManagers; mm++) {
          if (mm === m) continue;
          if (allTotals[mm][sim] >= withP) { isWin = false; break; }
        }
        if (isWin) newWins++;
      }
      marginals.push(Math.max(0, (newWins / numSims) - mWP));
    }

    // VARP: distribute budget by value above replacement
    const sorted = [...marginals].sort((a, b) => b - a);
    const repl = sorted[Math.min(slots, sorted.length - 1)] ?? 0;
    let totalVAR = 0;
    const vars = marginals.map((mg) => { const v = Math.max(0, mg - repl); totalVAR += v; return v; });
    const maxAllowed = Math.max(0, budget - (slots - 1) * minBid);

    return vars.map((v) => {
      if (totalVAR <= 0 || v <= 0) return 0;
      return Math.max(0, Math.min(maxAllowed, Math.round((v / totalVAR) * budget)));
    });
  }

  // ── Iterate: simulate → each team recomputes strategy → repeat ─────
  for (let iter = 0; iter < iterations; iter++) {
    const noiseLevel = Math.max(1, 4 - iter);

    // Step 1: Run a batch of auctions with current bids + noise
    // Accumulate average drafted rosters per manager across auctions
    const avgPlayerWins: number[][] = Array.from({ length: nManagers }, () => new Array(nPlayers).fill(0));

    for (let a = 0; a < auctionsPerIteration; a++) {
      const drafted = simulateAuction(
        availablePlayerIds, bidMatrix,
        managerBudgets.map((b) => b.remainingBudget),
        managerBudgets.map((b) => b.remainingRosterSlots),
        minBid, noiseLevel,
      );
      const pidToIdx = new Map(availablePlayerIds.map((id, i) => [id, i]));
      for (let m = 0; m < nManagers; m++) {
        for (const id of drafted[m]) {
          const pi = pidToIdx.get(id);
          if (pi != null) avgPlayerWins[m][pi]++;
        }
      }
    }

    // Step 2: Each team recomputes optimal bids given the average outcome
    // Build "expected roster" for each manager: their existing players +
    // the players they won most frequently in the auction batch
    for (let m = 0; m < nManagers; m++) {
      const info = managerBudgets[m];
      if (info.remainingRosterSlots <= 0) continue;

      // Find the players this manager most often drafted (their "expected roster")
      const winRates = avgPlayerWins[m].map((count, pi) => ({ pi, rate: count / auctionsPerIteration }));
      winRates.sort((a, b) => b.rate - a.rate);
      const expectedDraft = winRates
        .slice(0, info.remainingRosterSlots)
        .filter((w) => w.rate > 0.1) // only include players they win >10% of the time
        .map((w) => availablePlayerIds[w.pi]);

      // Build expected roster totals (existing + expected draft)
      const expectedIds = [...rosters[m].playerIds, ...expectedDraft];
      const expectedTotals = rosterSimTotals(simMatrix, playerIndex, expectedIds, numSims, numPlayers);

      // Build opponent totals similarly
      const allExpectedTotals: Float64Array[] = [];
      for (let mm = 0; mm < nManagers; mm++) {
        if (mm === m) {
          allExpectedTotals.push(expectedTotals);
        } else {
          const oppWinRates = avgPlayerWins[mm].map((count, pi) => ({ pi, rate: count / auctionsPerIteration }));
          oppWinRates.sort((a, b) => b.rate - a.rate);
          const oppDraft = oppWinRates
            .slice(0, managerBudgets[mm].remainingRosterSlots)
            .filter((w) => w.rate > 0.1)
            .map((w) => availablePlayerIds[w.pi]);
          const oppIds = [...rosters[mm].playerIds, ...oppDraft];
          allExpectedTotals.push(rosterSimTotals(simMatrix, playerIndex, oppIds, numSims, numPlayers));
        }
      }

      // Step 3: Recompute VARP bids for this manager given expected context
      bidMatrix[m] = computeVARPBids(m, expectedTotals, allExpectedTotals);
    }
  }

  // ── Build result ────────────────────────────────────────────────────
  const players: EquilibriumBidRow[] = availablePlayerIds.map((id, pi) => {
    const proj = projByEspnId.get(id);
    return {
      espnId: id,
      playerName: proj?.name ?? id,
      team: proj?.team ?? "",
      projectedPoints: proj?.projectedPoints ?? 0,
      bids: bidMatrix.map((mgr) => mgr[pi]),
    };
  });

  // Sort by highest total demand
  players.sort((a, b) => {
    const aDemand = a.bids.reduce((s, v) => s + v, 0);
    const bDemand = b.bids.reduce((s, v) => s + v, 0);
    return bDemand - aDemand;
  });

  return {
    players,
    managerNames: rosters.map((r) => r.name),
    iterations,
  };
}
