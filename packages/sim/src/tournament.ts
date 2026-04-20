/**
 * Component A: Tournament Outcome Simulator
 *
 * Monte Carlo simulation of the NBA playoff bracket. Given team ratings,
 * player rosters, and bracket seedings, produces:
 *   - Per-team advancement probabilities (R1 → Champion)
 *   - Per-player fantasy point distributions (mean + per-sim raw data)
 *   - A flat Float64Array sim matrix for Component B (draft optimizer)
 *
 * Ported from explore/misc/sports/espn/nba/playoff_sim/web/src/lib/simulator.ts
 */

import { RNG } from "./rng";
import { buildLiveGameMap } from "./live-game-utils";
import {
  SERIES_KEYS,
  PLAYIN_KEYS,
  type LiveGameState,
  type SimConfig,
  type SimData,
  type SimPlayer,
  type SimResults,
  type SeriesKey,
  type PlayinKey,
  type TeamSimResult,
  type PlayerProjection,
  type PlayerAdjustment,
  type InjuryEntry,
} from "./types";

// ─── Helpers ───────────────────────────────────────────────────────

function buildAliasMap(aliases: Record<string, string>): Record<string, string> {
  const rev: Record<string, string> = {};
  for (const [k, v] of Object.entries(aliases)) {
    rev[v] = k;
  }
  return rev;
}

function resolveTeam(
  team: string,
  data: Record<string, unknown>,
  aliases: Record<string, string>,
  aliasesRev: Record<string, string>,
): string {
  if (team in data) return team;
  const alt = aliases[team];
  if (alt && alt in data) return alt;
  const rev = aliasesRev[team];
  if (rev && rev in data) return rev;
  return team;
}

function seedOrder(
  team: string,
  seeds: [number, string][],
  playin: [number, string][],
): number {
  for (const [seed, abbr] of seeds) {
    if (abbr === team) return seed;
  }
  for (const [seed, abbr] of playin) {
    if (abbr === team) return seed;
  }
  return 99;
}

function orderMatchup(
  a: string,
  b: string,
  allSeeds: [number, string][],
  allPlayin: [number, string][],
): [string, string] {
  const sa = seedOrder(a, allSeeds, allPlayin);
  const sb = seedOrder(b, allSeeds, allPlayin);
  return sa < sb ? [a, b] : [b, a];
}

// ─── Game + Series simulation ──────────────────────────────────────

/** NBA overtime is 5 min vs 48 of regulation → shared by OT loops below. */
const OT_FRAC = 5 / 48;
const TOTAL_PTS = 220;
/** Physical cap — a player cannot play more than the game's regulation length. */
const MAX_PLAYER_MINUTES = 48;
/** Dirichlet concentration for the per-team point share (higher = tighter). */
const CONCENTRATION = 20;
/** 2 play-in + 4 rounds × 7 games. Mirrors `InjuryEntry.availability` shape. */
const NUM_AVAIL_SLOTS = 30;
/** alpha = min(1, gp / ACTUAL_BLEND_CAP_GAMES) — fully trust actuals after 5 games. */
const ACTUAL_BLEND_CAP_GAMES = 5;

/**
 * Fill `baseMins` up to `target` using sqrt(base) weights (concave — stars
 * absorb proportionally less of the deficit than rotation players). Caps
 * each slot at 48 min and iteratively re-routes overflow to uncapped slots.
 */
function sqrtRedistribute(baseMins: number[], target: number): number[] {
  const n = baseMins.length;
  if (n === 0 || target <= 0) return new Array(n).fill(0);
  let total = 0;
  for (let i = 0; i < n; i++) total += baseMins[i];
  if (total <= 0) return new Array(n).fill(0);
  if (total >= target) {
    const scale = target / total;
    return baseMins.map((m) => m * scale);
  }
  const weights = baseMins.map((m) => Math.sqrt(m));
  const out = baseMins.slice();
  const capped = new Array(n).fill(false);
  for (let iter = 0; iter <= n; iter++) {
    let curTotal = 0;
    for (let i = 0; i < n; i++) curTotal += out[i];
    const deficit = target - curTotal;
    if (deficit <= 1e-9) break;
    let sumW = 0;
    for (let i = 0; i < n; i++) if (!capped[i]) sumW += weights[i];
    if (sumW <= 1e-9) break;
    let newlyCapped = false;
    for (let i = 0; i < n; i++) {
      if (capped[i]) continue;
      const add = (deficit * weights[i]) / sumW;
      const candidate = out[i] + add;
      if (candidate > MAX_PLAYER_MINUTES) {
        out[i] = MAX_PLAYER_MINUTES;
        capped[i] = true;
        newlyCapped = true;
      } else {
        out[i] = candidate;
      }
    }
    if (!newlyCapped) break;
  }
  return out;
}

function simulateGame(
  homeRating: number,
  awayRating: number,
  rng: RNG,
  hca: number,
  stdev: number,
): { homeWins: boolean; homeScore: number; awayScore: number } {
  const spread = homeRating - awayRating + hca;
  const margin = rng.normal(spread, stdev);
  let homeScore = Math.round((TOTAL_PTS + margin) / 2);
  let awayScore = Math.round((TOTAL_PTS - margin) / 2);
  // HCA is regulation-only; OT is played on a neutral spread.
  const otSpread = (homeRating - awayRating) * OT_FRAC;
  const otStdev = stdev * Math.sqrt(OT_FRAC);
  const otPot = TOTAL_PTS * OT_FRAC;
  while (homeScore === awayScore) {
    const m = rng.normal(otSpread, otStdev);
    homeScore += Math.round((otPot + m) / 2);
    awayScore += Math.round((otPot - m) / 2);
  }
  return { homeWins: homeScore > awayScore, homeScore, awayScore };
}

// ─── Mask-cache: precomputed per-active-set team state ───────────────
// Replaces the old per-game `calcLebronRating` path. For each team we
// enumerate every possible "which injured players sit" bitmask (2^k, where
// k = injured players with any avail<1) at prepare time. The hot path then
// samples a mask from the availability vector and looks up the entry in O(1).

/** Precomputed rating + Dirichlet distribution for a specific active set. */
interface TeamMaskEntry {
  rating: number;
  dist: TeamPointDistribution;
}

/** Per-team bundle of precomputed mask entries + info to re-derive the mask. */
interface TeamPrecomputed {
  /** Per-injured-player availability vectors (length 30). Hot loop reads these
   *  directly so no HashMap touch per game. Bit i of `mask` = injured[i] sits. */
  injuredAvailability: number[][];
  /** Length 30 × 2^k. entries[availIdx * maskCount + mask] is the resolved
   *  state for that (game slot, active set). Per-game variants exist so
   *  actuals from sim'd game G don't leak into the minutes distribution
   *  used to predict game G itself. */
  entries: TeamMaskEntry[];
  /** 2^k — stride for indexing `entries` by availIdx. */
  maskCount: number;
}

interface SeriesPlayerAccum {
  /** Dense (numPlayers × 28) Float32Array of per-(round,gameNum) game counts.
   *  Index = playerIdx * 28 + roundIdx * 7 + gameNum (gameNum ∈ 0..6). */
  games: Float32Array;
  /** Dense (numPlayers × 28) Float64Array of per-(round,gameNum) points. */
  pts: Float64Array;
}

/** Precomputed point-distribution weights for a team, stored as typed arrays
 *  indexed into the global playerIndex. Built once per `runTournamentSim`
 *  call and reused across every sim × series × game. */
interface TeamPointDistribution {
  /** Number of eligible players (length of active slices of typed arrays). */
  count: number;
  /** Global player indices (into `playerIndex`), first `count` entries valid. */
  playerIdx: Int32Array;
  /** Per-player Dirichlet alpha (share × concentration), first `count` valid. */
  alphas: Float64Array;
}

interface SimContext {
  config: SimConfig;
  netRatings: Record<string, number>;
  seriesPattern: boolean[];
  aliases: Record<string, string>;
  aliasesRev: Record<string, string>;
  liveByKey: Map<string, LiveGameState[]>;
  /** team abbrev (any known alias) → precomputed mask cache. */
  teamPrecomputed: Map<string, TeamPrecomputed>;
  /** playerIndex: espnId → column in simMatrix / row in accum typed arrays. */
  playerIndex: Map<string, number>;
  numPlayers: number;
  /** Scratch buffer reused by the Dirichlet sampler. */
  scratchShares: Float64Array;
}

/** Sample the per-game active-set mask for `team` by rolling each injured
 *  player's availability once, then return the precomputed entry. */
function sampleTeamState(
  ctx: SimContext,
  team: string,
  rng: RNG,
  availIdx: number,
): TeamMaskEntry | undefined {
  const pre = ctx.teamPrecomputed.get(team);
  if (!pre) return undefined;
  let mask = 0;
  const inj = pre.injuredAvailability;
  for (let bit = 0; bit < inj.length; bit++) {
    const avail = inj[bit];
    if (avail.length === 0) continue;
    const i = Math.min(availIdx, avail.length - 1);
    if (rng.random() >= avail[i]) mask |= 1 << bit;
  }
  const slot = Math.min(availIdx, NUM_AVAIL_SLOTS - 1);
  return pre.entries[slot * pre.maskCount + mask];
}

/** Combine the precomputed LEBRON-style rating with the configured model. */
function resolveRating(
  ctx: SimContext,
  team: string,
  state: TeamMaskEntry | undefined,
): number {
  const netKey = resolveTeam(team, ctx.netRatings, ctx.aliases, ctx.aliasesRev);
  const nrRating = ctx.netRatings[netKey] ?? 0;
  switch (ctx.config.model) {
    case "netrtg":
      return nrRating;
    case "lebron":
      return state?.rating ?? -10;
    case "blend": {
      const lebron = state?.rating ?? -10;
      return ctx.config.blendWeight * lebron + (1 - ctx.config.blendWeight) * nrRating;
    }
  }
}

/** Spread `score` across players using the precomputed Dirichlet alphas. */
function trackTeamWithDist(
  dist: TeamPointDistribution,
  scratch: Float64Array,
  rng: RNG,
  score: number,
  accumGames: Float32Array,
  accumPts: Float64Array,
  roundIdx: number,
  gameNum: number,
): void {
  if (dist.count === 0) return;
  const count = dist.count;
  rng.dirichletInto(dist.alphas, scratch, count);
  const slot = roundIdx * 7 + gameNum;
  const playerIdx = dist.playerIdx;
  for (let i = 0; i < count; i++) {
    const offset = playerIdx[i] * 28 + slot;
    accumGames[offset] += 1;
    accumPts[offset] += score * scratch[i];
  }
}

function simulateSeries(
  higher: string,
  lower: string,
  ctx: SimContext,
  rng: RNG,
  roundIdx: number,
  accum: SeriesPlayerAccum,
  gameOffset: number,
  seriesKey?: string,
): string {
  let hWins = 0;
  let lWins = 0;

  const liveGames = seriesKey ? ctx.liveByKey.get(seriesKey) : undefined;
  const accumGames = accum.games;
  const accumPts = accum.pts;
  const scratch = ctx.scratchShares;

  for (let gameNum = 0; gameNum < 7; gameNum++) {
    if (hWins === 4 || lWins === 4) break;

    // Sample per-game active set (mask) and look up precomputed rating + dist.
    const availIdx = gameOffset + gameNum;
    const hState = sampleTeamState(ctx, higher, rng, availIdx);
    const lState = sampleTeamState(ctx, lower, rng, availIdx);
    const hRating = resolveRating(ctx, higher, hState);
    const lRating = resolveRating(ctx, lower, lState);

    // ── Live-game injection ────────────────────────────────────────
    const live = liveGames?.find((g) => g.gameNum === gameNum + 1);
    if (live) {
      const liveHigherHome = live.homeTeam.toUpperCase() === higher.toUpperCase();
      const higherActual = liveHigherHome ? live.homeScore : live.awayScore;
      const lowerActual = liveHigherHome ? live.awayScore : live.homeScore;

      // Apply accrued actual player points (and count as played game for each)
      for (const espnId in live.playerPoints) {
        const pts = live.playerPoints[espnId];
        if (!Number.isFinite(pts) || pts <= 0) continue;
        const idx = ctx.playerIndex.get(espnId);
        if (idx == null) continue;
        const offset = idx * 28 + roundIdx * 7 + gameNum;
        accumPts[offset] += pts;
        accumGames[offset] += 1;
      }

      if (live.status === "post") {
        if (higherActual > lowerActual) hWins++;
        else lWins++;
        continue;
      }

      if (live.status === "in") {
        const frac = Math.max(0, Math.min(1, live.remainingFraction));
        if (frac <= 0.01) {
          if (higherActual >= lowerActual) hWins++;
          else lWins++;
          continue;
        }
        const scaledStd = ctx.config.stdev * Math.sqrt(frac);
        const spread = (hRating - lRating) * frac;
        const margin = rng.normal(spread, scaledStd);
        const remainingTotal = TOTAL_PTS * frac;
        let remainderHigher = Math.max(0, Math.round((remainingTotal + margin) / 2));
        let remainderLower = Math.max(0, Math.round((remainingTotal - margin) / 2));
        let finalHigher = higherActual + remainderHigher;
        let finalLower = lowerActual + remainderLower;
        const otSpread = (hRating - lRating) * OT_FRAC;
        const otStdev = ctx.config.stdev * Math.sqrt(OT_FRAC);
        const otPot = TOTAL_PTS * OT_FRAC;
        while (finalHigher === finalLower) {
          const m = rng.normal(otSpread, otStdev);
          const dh = Math.max(0, Math.round((otPot + m) / 2));
          const dl = Math.max(0, Math.round((otPot - m) / 2));
          remainderHigher += dh;
          remainderLower += dl;
          finalHigher += dh;
          finalLower += dl;
        }
        if (hState) trackTeamWithDist(hState.dist, scratch, rng, remainderHigher, accumGames, accumPts, roundIdx, gameNum);
        if (lState) trackTeamWithDist(lState.dist, scratch, rng, remainderLower, accumGames, accumPts, roundIdx, gameNum);
        if (finalHigher > finalLower) hWins++;
        else lWins++;
        continue;
      }
      // status === "pre" — fall through to normal simulation
    }

    const higherHome = ctx.seriesPattern[gameNum];
    const { homeWins, homeScore, awayScore } = higherHome
      ? simulateGame(hRating, lRating, rng, ctx.config.hca, ctx.config.stdev)
      : simulateGame(lRating, hRating, rng, ctx.config.hca, ctx.config.stdev);

    const higherWon = higherHome ? homeWins : !homeWins;
    if (higherWon) hWins++;
    else lWins++;

    const higherScore = higherHome ? homeScore : awayScore;
    const lowerScore = higherHome ? awayScore : homeScore;
    if (hState) trackTeamWithDist(hState.dist, scratch, rng, higherScore, accumGames, accumPts, roundIdx, gameNum);
    if (lState) trackTeamWithDist(lState.dist, scratch, rng, lowerScore, accumGames, accumPts, roundIdx, gameNum);
  }

  return hWins === 4 ? higher : lower;
}

function simulatePlayInGame(
  higher: string,
  lower: string,
  ctx: SimContext,
  rng: RNG,
  gameNum: number,
): { winner: string; loser: string } {
  const hState = sampleTeamState(ctx, higher, rng, gameNum);
  const lState = sampleTeamState(ctx, lower, rng, gameNum);
  const hRating = resolveRating(ctx, higher, hState);
  const lRating = resolveRating(ctx, lower, lState);
  const { homeWins } = simulateGame(hRating, lRating, rng, ctx.config.hca, ctx.config.stdev);
  return homeWins
    ? { winner: higher, loser: lower }
    : { winner: lower, loser: higher };
}

function simulatePlayIn(
  seeds: [number, string][],
  playin: [number, string][],
  ctx: SimContext,
  rng: RNG,
): [string, string] {
  const s7 = seeds.find(([s]) => s === 7)?.[1] ?? "";
  const s8 = seeds.find(([s]) => s === 8)?.[1] ?? "";
  const s9 = playin.find(([s]) => s === 9)?.[1] ?? "";
  const s10 = playin.find(([s]) => s === 10)?.[1] ?? "";

  // Play-in games — points from these do NOT count toward fantasy projections
  const g1 = simulatePlayInGame(s7, s8, ctx, rng, 0);
  const seed7 = g1.winner;

  const g2 = simulatePlayInGame(s9, s10, ctx, rng, 0);

  const g3 = simulatePlayInGame(g1.loser, g2.winner, ctx, rng, 1);
  const seed8 = g3.winner;

  return [seed7, seed8];
}

// ─── Main simulation ───────────────────────────────────────────────

export async function runTournamentSim(
  data: SimData,
  config: SimConfig,
  onProgress?: (fraction: number) => void,
): Promise<SimResults> {
  const { bracket, netRatings: netRatingsRaw, simPlayers, playoffMinutes } = data;
  const aliases = bracket.teamAliases;
  const aliasesRev = buildAliasMap(aliases);

  // Build rosters by team
  const rostersByTeam: Record<string, SimPlayer[]> = {};
  const playerLookup = new Map<string, SimPlayer>();
  for (const p of simPlayers) {
    if (!rostersByTeam[p.team]) rostersByTeam[p.team] = [];
    rostersByTeam[p.team].push(p);
    playerLookup.set(p.espn_id, p);
  }

  // Flatten net ratings to per-game
  const netRatings: Record<string, number> = {};
  for (const [team, info] of Object.entries(netRatingsRaw)) {
    netRatings[team] = info.net_rtg_per_game;
  }
  for (const [seedAbbr, csvAbbr] of Object.entries(aliases)) {
    if (csvAbbr in netRatings && !(seedAbbr in netRatings)) {
      netRatings[seedAbbr] = netRatings[csvAbbr];
    }
  }

  // Build adjustment + injury lookup maps
  const adjustmentsById = new Map<string, PlayerAdjustment>();
  for (const adj of data.adjustments ?? []) {
    adjustmentsById.set(adj.espn_id, adj);
  }
  const injuriesByName = new Map<string, InjuryEntry>();
  const injuries = data.injuries ?? {};
  for (const [name, entry] of Object.entries(injuries)) {
    if (name === "_meta") continue;
    injuriesByName.set(name, entry as InjuryEntry);
  }

  // Build player index for the sim matrix
  const allPlayerIds = simPlayers.map((p) => p.espn_id);
  const playerIndex = new Map<string, number>();
  allPlayerIds.forEach((id, idx) => playerIndex.set(id, idx));
  const numPlayers = allPlayerIds.length;

  // Per-team precomputed mask cache. For each team we:
  //   1. Identify the "base active" players (mpg>0 with playoff minutes or override).
  //   2. Within those, find the injured subset (players with any avail<1). Cap
  //      at 16 for the mask-space bound.
  //   3. For each availIdx G ∈ 0..30 enumerate 2^k masks; per-G the base mins
  //      are blended from pre-projection + cumulative actuals from slots < G
  //      (so sim(G) never sees its own data). Resolve rating + Dirichlet alphas
  //      into entries[G * maskCount + mask].
  const teamPrecomputed = new Map<string, TeamPrecomputed>();
  let maxTeamCount = 1;
  const actualsByGame = data.actualsByGame ?? {};
  for (const teamKey of Object.keys(rostersByTeam)) {
    const roster = rostersByTeam[teamKey];
    const pm = playoffMinutes[teamKey] ?? {};
    const teamActuals = actualsByGame[teamKey] ?? {};

    // Base-active = mpg>0 AND (has pm entry OR has minutes_override).
    const baseActive: SimPlayer[] = [];
    for (const p of roster) {
      if (p.mpg <= 0) continue;
      const adj = adjustmentsById.get(p.espn_id);
      const hasOverride = adj?.minutes_override != null;
      const baseMin = pm[p.nba_id] ?? 0;
      if (baseMin <= 0 && !hasOverride) continue;
      baseActive.push(p);
    }

    // Per-base-active player: flatten actuals into a [NUM_AVAIL_SLOTS] array
    // (0 where no data). Used to accumulate cumulative actuals-before-G.
    const actualsBySlot: Float64Array[] = baseActive.map((p) => {
      const arr = new Float64Array(NUM_AVAIL_SLOTS);
      const perSlot = teamActuals[p.nba_id];
      if (perSlot) {
        for (const [slotStr, mins] of Object.entries(perSlot)) {
          const slot = Number(slotStr);
          if (Number.isInteger(slot) && slot >= 0 && slot < NUM_AVAIL_SLOTS && mins > 0) {
            arr[slot] = mins;
          }
        }
      }
      return arr;
    });

    // Injured within active: any avail<1 → will sit in some fraction of sims.
    const injuredIdxInActive: number[] = [];
    for (let i = 0; i < baseActive.length; i++) {
      const injury = injuriesByName.get(baseActive[i].name);
      if (injury && injury.availability.some((a) => a < 1)) {
        injuredIdxInActive.push(i);
      }
    }
    // Keep 2^k bounded.
    if (injuredIdxInActive.length > 16) injuredIdxInActive.length = 16;
    const k = injuredIdxInActive.length;

    // Hoisted availability vectors (length 30 each).
    const injuredAvailability: number[][] = injuredIdxInActive.map((i) => {
      const entry = injuriesByName.get(baseActive[i].name);
      return entry ? entry.availability.slice() : [];
    });

    const maskCount = 1 << k;
    const entries: TeamMaskEntry[] = new Array(NUM_AVAIL_SLOTS * maskCount);
    for (let availIdx = 0; availIdx < NUM_AVAIL_SLOTS; availIdx++) {
      // Per-player blended base minutes at this slot. alpha = min(1, gp/5);
      // blended = alpha * actual_mpg + (1-alpha) * pre_proj. Only slots <G
      // contribute so we never leak game G's own actuals.
      const blendedMins = new Float64Array(baseActive.length);
      for (let bi = 0; bi < baseActive.length; bi++) {
        const pre = pm[baseActive[bi].nba_id] ?? 0;
        let gp = 0;
        let total = 0;
        const slots = actualsBySlot[bi];
        for (let prev = 0; prev < availIdx; prev++) {
          const m = slots[prev];
          if (m > 0) {
            gp++;
            total += m;
          }
        }
        if (gp > 0) {
          const actualMpg = total / gp;
          const alpha = Math.min(1, gp / ACTUAL_BLEND_CAP_GAMES);
          blendedMins[bi] = alpha * actualMpg + (1 - alpha) * pre;
        } else {
          blendedMins[bi] = pre;
        }
      }

      for (let mask = 0; mask < maskCount; mask++) {
        // Determine sitting set for this mask.
        const sitting = new Array<boolean>(baseActive.length).fill(false);
        for (let bit = 0; bit < k; bit++) {
          if ((mask >> bit) & 1) sitting[injuredIdxInActive[bit]] = true;
        }

        // Split active into override / base slots.
        const overrides: { pi: number; mins: number }[] = [];
        const baseMinsRaw: { pi: number; mins: number }[] = [];
        let overriddenTotal = 0;
        for (let i = 0; i < baseActive.length; i++) {
          if (sitting[i]) continue;
          const p = baseActive[i];
          const pi = playerIndex.get(p.espn_id);
          if (pi == null) continue;
          const adj = adjustmentsById.get(p.espn_id);
          if (adj?.minutes_override != null) {
            const o = adj.minutes_override;
            if (o > 0) {
              overrides.push({ pi, mins: o });
              overriddenTotal += o;
            }
            continue;
          }
          const base = blendedMins[i];
          if (base > 0) baseMinsRaw.push({ pi, mins: base });
        }

        const targetForBase = Math.max(0, 240 - overriddenTotal);
        const redistributed = sqrtRedistribute(baseMinsRaw.map((e) => e.mins), targetForBase);

        const idxList: number[] = [];
        const alphaList: number[] = [];
        let alphaTotal = 0;
        let rating = 0;

        // Overrides use fixed minutes.
        for (const { pi, mins } of overrides) {
          const p = simPlayers[pi];
          const adj = adjustmentsById.get(p.espn_id);
          const lebron = p.lebron + (adj?.o_lebron_delta ?? 0) + (adj?.d_lebron_delta ?? 0);
          rating += (lebron * mins) / 48;
          const ptsPerMin = p.mpg > 0 ? p.ppg / p.mpg : 1;
          const w = ptsPerMin * mins;
          if (w > 0) {
            idxList.push(pi);
            alphaList.push(w);
            alphaTotal += w;
          }
        }
        // Redistributed baseline mins.
        for (let i = 0; i < baseMinsRaw.length; i++) {
          const mins = redistributed[i];
          if (mins <= 0) continue;
          const p = simPlayers[baseMinsRaw[i].pi];
          const adj = adjustmentsById.get(p.espn_id);
          const lebron = p.lebron + (adj?.o_lebron_delta ?? 0) + (adj?.d_lebron_delta ?? 0);
          rating += (lebron * mins) / 48;
          const ptsPerMin = p.mpg > 0 ? p.ppg / p.mpg : 1;
          const w = ptsPerMin * mins;
          if (w > 0) {
            idxList.push(baseMinsRaw[i].pi);
            alphaList.push(w);
            alphaTotal += w;
          }
        }

        // Normalize to Dirichlet concentration.
        if (alphaTotal > 0) {
          for (let i = 0; i < alphaList.length; i++) {
            alphaList[i] = (alphaList[i] / alphaTotal) * CONCENTRATION;
          }
        }
        if (idxList.length === 0) rating = -10;

        const count = idxList.length;
        if (count > maxTeamCount) maxTeamCount = count;
        entries[availIdx * maskCount + mask] = {
          rating,
          dist: {
            count,
            playerIdx: Int32Array.from(idxList),
            alphas: Float64Array.from(alphaList),
          },
        };
      }
    }

    teamPrecomputed.set(teamKey, { injuredAvailability, entries, maskCount });
  }
  // Mirror across aliases so hot-path lookups never resolveTeam.
  for (const [seedAbbr, csvAbbr] of Object.entries(aliases)) {
    const d = teamPrecomputed.get(seedAbbr) ?? teamPrecomputed.get(csvAbbr);
    if (d) {
      teamPrecomputed.set(seedAbbr, d);
      teamPrecomputed.set(csvAbbr, d);
    }
  }

  // Build the shared simulation context
  const ctx: SimContext = {
    config,
    netRatings,
    seriesPattern: bracket.seriesPattern,
    aliases,
    aliasesRev,
    liveByKey: buildLiveGameMap(data.liveGames),
    teamPrecomputed,
    playerIndex,
    numPlayers,
    scratchShares: new Float64Array(maxTeamCount),
  };

  // Sim matrix: sims × numPlayers
  const simMatrix = new Float64Array(config.sims * numPlayers);

  // Build the canonical team index used by `seriesWinners` / `playinSeeds`.
  // Order is deterministic (East seeds 1-6, East play-in 7-10, then West).
  // Uint8Array sentinel: 0xff = "unset / no winner recorded".
  const teamNames: string[] = [];
  const teamIndex = new Map<string, number>();
  const registerTeam = (team: string) => {
    if (!team) return;
    if (teamIndex.has(team)) return;
    const idx = teamNames.length;
    teamNames.push(team);
    teamIndex.set(team, idx);
  };
  for (const [, t] of bracket.eastSeeds) registerTeam(t);
  for (const [, t] of bracket.eastPlayin ?? []) registerTeam(t);
  for (const [, t] of bracket.westSeeds) registerTeam(t);
  for (const [, t] of bracket.westPlayin ?? []) registerTeam(t);
  // Mirror across team aliases so any string the bracket might surface
  // (CSV abbrev or seed abbrev) resolves to the canonical idx.
  for (const [seedAbbr, csvAbbr] of Object.entries(aliases)) {
    const fromSeed = teamIndex.get(seedAbbr);
    const fromCsv = teamIndex.get(csvAbbr);
    if (fromSeed != null && fromCsv == null) teamIndex.set(csvAbbr, fromSeed);
    if (fromCsv != null && fromSeed == null) teamIndex.set(seedAbbr, fromCsv);
  }
  if (teamNames.length > 254) {
    throw new Error(
      `seriesWinners stores team idx as Uint8 (sentinel 0xff); got ${teamNames.length} teams. Bump to Uint16Array.`,
    );
  }

  const seriesWinners = {} as Record<SeriesKey, Uint8Array>;
  for (const k of SERIES_KEYS) seriesWinners[k] = new Uint8Array(config.sims).fill(0xff);
  const playinSeeds = {} as Record<PlayinKey, Uint8Array>;
  for (const k of PLAYIN_KEYS) playinSeeds[k] = new Uint8Array(config.sims).fill(0xff);

  const writeSeriesWinner = (key: SeriesKey, sim: number, team: string) => {
    const idx = teamIndex.get(team);
    if (idx != null) seriesWinners[key][sim] = idx;
  };

  const rng = new RNG(42);

  // Accumulators
  const r1Counts: Record<string, number> = {};
  const r2Counts: Record<string, number> = {};
  const cfCounts: Record<string, number> = {};
  const finalsCounts: Record<string, number> = {};
  const champCounts: Record<string, number> = {};
  // Dense (numPlayers × 28) accumulators across all sims, mirroring the per-sim
  // typed-array accum. Indexed: `idx * 28 + round * 7 + gameNum` (gameNum 0..6).
  const totalGames = new Float64Array(numPlayers * 28);
  const totalPts = new Float64Array(numPlayers * 28);
  // Per-sim accum, reused across sims via .fill(0).
  const accumGames = new Float32Array(numPlayers * 28);
  const accumPts = new Float64Array(numPlayers * 28);
  const accum: SeriesPlayerAccum = { games: accumGames, pts: accumPts };
  // Track how many sims each team made the main bracket (for conditioning)
  const teamPlayoffSims: Record<string, number> = {};
  // Per-sim per-team max round reached (0=not in playoffs, 1=lost R1, 2=lost R2,
  // 3=lost CF, 4=lost Finals, 5=champ). Allocated lazily per-team to save memory
  // for teams that never appear in the bracket.
  const teamRoundReached: Record<string, Uint8Array> = {};
  const markReached = (team: string, level: number, sim: number) => {
    let arr = teamRoundReached[team];
    if (!arr) {
      arr = new Uint8Array(config.sims);
      teamRoundReached[team] = arr;
    }
    if (arr[sim] < level) arr[sim] = level;
  };

  const allSeeds = [...bracket.eastSeeds, ...bracket.westSeeds];
  const allPlayin = [...(bracket.eastPlayin ?? []), ...(bracket.westPlayin ?? [])];

  // Seeds 1-6 always make the main bracket
  for (const [seed, team] of allSeeds) {
    if (seed <= 6) teamPlayoffSims[team] = config.sims;
  }

  // Real-world play-in lock: when bracket.playinR2 is complete, the 7/8 seeds
  // are decided in the actual playoffs. eastSeeds/westSeeds already reflect
  // the locked seeds (PHI=7, ORL=8 etc), so we use those directly instead of
  // running a random play-in sim that could swap teams (e.g. give ORL the
  // 7-seed in 2% of sims). This makes the picker reflect "from now state".
  const eastPlayinDone = !!bracket.playinR2?.east?.winner;
  const westPlayinDone = !!bracket.playinR2?.west?.winner;
  const lockedEast7 = bracket.eastSeeds.find(([s]) => s === 7)?.[1] ?? "";
  const lockedEast8 = bracket.eastSeeds.find(([s]) => s === 8)?.[1] ?? "";
  const lockedWest7 = bracket.westSeeds.find(([s]) => s === 7)?.[1] ?? "";
  const lockedWest8 = bracket.westSeeds.find(([s]) => s === 8)?.[1] ?? "";

  for (let sim = 0; sim < config.sims; sim++) {
    if (onProgress && sim > 0 && sim % 250 === 0) {
      onProgress(sim / config.sims);
      await new Promise((r) => setTimeout(r, 0));
    }

    accumGames.fill(0);
    accumPts.fill(0);

    // Play-in (points NOT tracked — play-in points don't count for fantasy)
    const [east7, east8] = eastPlayinDone
      ? [lockedEast7, lockedEast8]
      : simulatePlayIn(bracket.eastSeeds, bracket.eastPlayin ?? [], ctx, rng);
    const [west7, west8] = westPlayinDone
      ? [lockedWest7, lockedWest8]
      : simulatePlayIn(bracket.westSeeds, bracket.westPlayin ?? [], ctx, rng);

    // Track play-in advancement for conditioning
    for (const t of [east7, east8, west7, west8]) {
      teamPlayoffSims[t] = (teamPlayoffSims[t] ?? 0) + 1;
    }

    // Record per-sim play-in seed assignments for bracket-conditioning UI.
    {
      const e7Idx = teamIndex.get(east7);
      const e8Idx = teamIndex.get(east8);
      const w7Idx = teamIndex.get(west7);
      const w8Idx = teamIndex.get(west8);
      if (e7Idx != null) playinSeeds.east7[sim] = e7Idx;
      if (e8Idx != null) playinSeeds.east8[sim] = e8Idx;
      if (w7Idx != null) playinSeeds.west7[sim] = w7Idx;
      if (w8Idx != null) playinSeeds.west8[sim] = w8Idx;
    }

    // Mark every team that entered the main bracket as "reached R1" (level 1).
    for (const [seed, team] of allSeeds) {
      if (seed <= 6) markReached(team, 1, sim);
    }
    for (const t of [east7, east8, west7, west8]) markReached(t, 1, sim);

    // R1 matchups (seeds → seriesKey)
    const eastR1: Array<{ pair: [string, string]; key: string }> = [
      { pair: [bracket.eastSeeds[0][1], east8], key: "r1.east.1v8" },
      { pair: [bracket.eastSeeds[3][1], bracket.eastSeeds[4][1]], key: "r1.east.4v5" },
      { pair: [bracket.eastSeeds[2][1], bracket.eastSeeds[5][1]], key: "r1.east.3v6" },
      { pair: [bracket.eastSeeds[1][1], east7], key: "r1.east.2v7" },
    ];
    const westR1: Array<{ pair: [string, string]; key: string }> = [
      { pair: [bracket.westSeeds[0][1], west8], key: "r1.west.1v8" },
      { pair: [bracket.westSeeds[3][1], bracket.westSeeds[4][1]], key: "r1.west.4v5" },
      { pair: [bracket.westSeeds[2][1], bracket.westSeeds[5][1]], key: "r1.west.3v6" },
      { pair: [bracket.westSeeds[1][1], west7], key: "r1.west.2v7" },
    ];

    // Round 1 (gameOffset 2 for availability indexing)
    const e1w: string[] = [];
    for (const { pair: [h, l], key } of eastR1) {
      const winner = simulateSeries(h, l, ctx, rng, 0, accum, 2, key);
      r1Counts[winner] = (r1Counts[winner] ?? 0) + 1;
      markReached(winner, 2, sim);
      writeSeriesWinner(key as SeriesKey, sim, winner);
      e1w.push(winner);
    }
    const w1w: string[] = [];
    for (const { pair: [h, l], key } of westR1) {
      const winner = simulateSeries(h, l, ctx, rng, 0, accum, 2, key);
      r1Counts[winner] = (r1Counts[winner] ?? 0) + 1;
      markReached(winner, 2, sim);
      writeSeriesWinner(key as SeriesKey, sim, winner);
      w1w.push(winner);
    }

    // Round 2: standard NBA bracket halves (e1w: 0=1v8, 1=4v5, 2=3v6, 3=2v7).
    // top = 1v8-winner vs 4v5-winner (Half A), bot = 2v7-winner vs 3v6-winner (Half B).
    const eastR2: Array<{ pair: [string, string]; key: string }> = [
      { pair: orderMatchup(e1w[0], e1w[1], allSeeds, allPlayin), key: "r2.east.top" },
      { pair: orderMatchup(e1w[3], e1w[2], allSeeds, allPlayin), key: "r2.east.bot" },
    ];
    const westR2: Array<{ pair: [string, string]; key: string }> = [
      { pair: orderMatchup(w1w[0], w1w[1], allSeeds, allPlayin), key: "r2.west.top" },
      { pair: orderMatchup(w1w[3], w1w[2], allSeeds, allPlayin), key: "r2.west.bot" },
    ];

    const e2w: string[] = [];
    for (const { pair: [h, l], key } of eastR2) {
      const winner = simulateSeries(h, l, ctx, rng, 1, accum, 9, key);
      r2Counts[winner] = (r2Counts[winner] ?? 0) + 1;
      markReached(winner, 3, sim);
      writeSeriesWinner(key as SeriesKey, sim, winner);
      e2w.push(winner);
    }
    const w2w: string[] = [];
    for (const { pair: [h, l], key } of westR2) {
      const winner = simulateSeries(h, l, ctx, rng, 1, accum, 9, key);
      r2Counts[winner] = (r2Counts[winner] ?? 0) + 1;
      markReached(winner, 3, sim);
      writeSeriesWinner(key as SeriesKey, sim, winner);
      w2w.push(winner);
    }

    // Conference Finals
    const [ecfH, ecfL] = orderMatchup(e2w[0], e2w[1], allSeeds, allPlayin);
    const ecfWinner = simulateSeries(ecfH, ecfL, ctx, rng, 2, accum, 16, "cf.east");
    cfCounts[ecfWinner] = (cfCounts[ecfWinner] ?? 0) + 1;
    markReached(ecfWinner, 4, sim);
    writeSeriesWinner("cf.east", sim, ecfWinner);

    const [wcfH, wcfL] = orderMatchup(w2w[0], w2w[1], allSeeds, allPlayin);
    const wcfWinner = simulateSeries(wcfH, wcfL, ctx, rng, 2, accum, 16, "cf.west");
    cfCounts[wcfWinner] = (cfCounts[wcfWinner] ?? 0) + 1;
    markReached(wcfWinner, 4, sim);
    writeSeriesWinner("cf.west", sim, wcfWinner);

    // Finals
    const [finH, finL] = orderMatchup(ecfWinner, wcfWinner, allSeeds, allPlayin);
    const finWinner = simulateSeries(finH, finL, ctx, rng, 3, accum, 23, "finals");
    finalsCounts[finWinner] = (finalsCounts[finWinner] ?? 0) + 1;
    champCounts[finWinner] = (champCounts[finWinner] ?? 0) + 1;
    markReached(finWinner, 5, sim);
    writeSeriesWinner("finals", sim, finWinner);

    // Record per-sim per-player totals into the sim matrix and fold the
    // per-sim typed-array accums into the global totals. Dense O(numPlayers)
    // sweep — no per-player map lookups.
    const simOffset = sim * numPlayers;
    for (let p = 0; p < numPlayers; p++) {
      const base = p * 28;
      let total = 0;
      for (let i = 0; i < 28; i++) {
        const pts = accumPts[base + i];
        total += pts;
        totalGames[base + i] += accumGames[base + i];
        totalPts[base + i] += pts;
      }
      if (total !== 0) simMatrix[simOffset + p] = total;
    }
  }

  const n = config.sims;

  // Build team results
  const allTeamAbbrs = [
    ...bracket.eastSeeds.map(([, t]) => t),
    ...(bracket.eastPlayin ?? []).map(([, t]) => t),
    ...bracket.westSeeds.map(([, t]) => t),
    ...(bracket.westPlayin ?? []).map(([, t]) => t),
  ];

  const teams: TeamSimResult[] = allTeamAbbrs.map((team) => {
    const state = sampleTeamState(ctx, team, rng, 0);
    const rating = resolveRating(ctx, team, state);
    const eastSeed = bracket.eastSeeds.find(([, t]) => t === team);
    const westSeed = bracket.westSeeds.find(([, t]) => t === team);
    const seed = eastSeed?.[0] ?? westSeed?.[0] ?? null;
    const conference: "E" | "W" | null = eastSeed
      ? "E"
      : westSeed
        ? "W"
        : bracket.eastPlayin?.find(([, t]) => t === team)
          ? "E"
          : bracket.westPlayin?.find(([, t]) => t === team)
            ? "W"
            : null;

    return {
      team,
      fullName: bracket.teamFullNames[team] ?? team,
      seed,
      conference,
      rating,
      r1: ((r1Counts[team] ?? 0) / n) * 100,
      r2: ((r2Counts[team] ?? 0) / n) * 100,
      cf: ((cfCounts[team] ?? 0) / n) * 100,
      finals: ((finalsCounts[team] ?? 0) / n) * 100,
      champ: ((champCounts[team] ?? 0) / n) * 100,
    };
  });

  teams.sort((a, b) => b.champ - a.champ);

  // Build player projections — CONDITIONED on team making the main bracket.
  // For seeds 1-6, teamPlayoffSims = n (they always make it).
  // For play-in teams, teamPlayoffSims < n (only sims where they advanced).
  // This means play-in players don't get penalized by 0-point sims where
  // their team was eliminated before the bracket.
  const players: PlayerProjection[] = [];
  for (const [espnId, col] of playerIndex) {
    const p = playerLookup.get(espnId);
    if (!p) continue;
    const base = col * 28;
    // Per-game (28-length) raw totals, indexed [round*7 + gameNum].
    const gamesByGame: number[] = new Array(28);
    const ptsByGame: number[] = new Array(28);
    let totalRaw = 0;
    let anyGames = 0;
    for (let i = 0; i < 28; i++) {
      const g = totalGames[base + i];
      const pt = totalPts[base + i];
      gamesByGame[i] = g;
      ptsByGame[i] = pt;
      totalRaw += pt;
      anyGames += g;
    }
    // Per-round rollup (length 4) for backward compat with computeConditionalPlayers.
    const games: number[] = [0, 0, 0, 0];
    const pts: number[] = [0, 0, 0, 0];
    for (let r = 0; r < 4; r++) {
      for (let g = 0; g < 7; g++) {
        games[r] += gamesByGame[r * 7 + g];
        pts[r] += ptsByGame[r * 7 + g];
      }
    }
    // Skip players who never accumulated anything.
    if (anyGames === 0) continue;

    // Condition on team making the main bracket
    const divisor = teamPlayoffSims[p.team] ?? n;
    if (divisor <= 0) continue;

    const meanPts = totalRaw / divisor;

    // Compute stddev, p10, p90 from sim matrix
    let stddev = 0;
    let p10 = 0;
    let p90 = 0;
    const vals = new Float64Array(n);
    for (let sim = 0; sim < n; sim++) {
      vals[sim] = simMatrix[sim * numPlayers + col];
    }
    // Stddev
    let sumSq = 0;
    for (let sim = 0; sim < n; sim++) {
      const diff = vals[sim] - meanPts;
      sumSq += diff * diff;
    }
    stddev = Math.sqrt(sumSq / n);
    // Percentiles
    const sorted = Float64Array.from(vals).sort();
    p10 = sorted[Math.floor(0.1 * n)];
    p90 = sorted[Math.floor(0.9 * n)];

    players.push({
      espnId,
      name: p.name,
      team: p.team,
      ppg: p.ppg,
      mpg: p.mpg,
      projectedGames: games.reduce((s, g) => s + g, 0) / divisor,
      projectedPoints: meanPts,
      projectedPointsByRound: pts.map((pt) => pt / divisor),
      projectedGamesByRound: games.map((g) => g / divisor),
      projectedPointsByGame: ptsByGame.map((pt) => pt / divisor),
      projectedGamesByGame: gamesByGame.map((g) => g / divisor),
      stddev,
      p10,
      p90,
    });
  }

  players.sort((a, b) => b.projectedPoints - a.projectedPoints);

  return {
    teams,
    players,
    simMatrix,
    playerIndex,
    numSims: n,
    teamRoundReached,
    teamNames,
    teamIndex,
    seriesWinners,
    playinSeeds,
  };
}
