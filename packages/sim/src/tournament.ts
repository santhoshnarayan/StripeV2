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

function simulateGame(
  homeRating: number,
  awayRating: number,
  rng: RNG,
  hca: number,
  stdev: number,
): { homeWins: boolean; homeScore: number; awayScore: number } {
  const spread = homeRating - awayRating + hca;
  const margin = rng.normal(spread, stdev);
  const totalPts = 220;
  const homeScore = Math.round((totalPts + margin) / 2);
  const awayScore = Math.round((totalPts - margin) / 2);
  return { homeWins: margin > 0, homeScore, awayScore };
}

// ─── LEBRON player-based team rating ─────────────────────────────
// Ported from explore/misc/sports/espn/nba/playoff_sim/web/src/lib/simulator.ts
// Uses ALL rostered players with projected playoff minutes (not just top 8).
// Minutes are scaled so the total reaches 240 (5 players × 48 mins).

function calcLebronRating(
  roster: SimPlayer[],
  playoffMinutes: Record<string, number> | null,
  adjustmentsById: Map<string, PlayerAdjustment>,
  injuriesByName: Map<string, InjuryEntry>,
  rng: RNG,
  gameNum: number,
): { rating: number; playerMinutes: Map<string, number> } {
  // Filter to players who are "available" for this game
  const active: SimPlayer[] = [];
  for (const p of roster) {
    if (p.mpg <= 0) continue;
    const injury = injuriesByName.get(p.name);
    if (injury) {
      const avail = injury.availability[Math.min(gameNum, injury.availability.length - 1)] ?? 1;
      if (rng.random() >= avail) continue; // player sits this game
    }
    active.push(p);
  }

  if (active.length === 0) return { rating: -10, playerMinutes: new Map() };

  const playerMinutes = new Map<string, number>();

  if (playoffMinutes) {
    // Collect base minutes + any overrides from adjustments
    let overriddenTotal = 0;
    let baseTotal = 0;
    const baseMins = new Map<string, number>();
    const overrides = new Map<string, number>();

    for (const p of active) {
      const adj = adjustmentsById.get(p.espn_id);
      const base = playoffMinutes[p.nba_id] ?? 0;
      if (base <= 0 && !adj?.minutes_override) continue;

      if (adj?.minutes_override != null) {
        overrides.set(p.espn_id, adj.minutes_override);
        overriddenTotal += adj.minutes_override;
      } else {
        baseMins.set(p.espn_id, base);
        baseTotal += base;
      }
    }

    // Scale non-overridden minutes so total = 240
    const remaining = Math.max(0, 240 - overriddenTotal);
    const scale = baseTotal > 0 ? remaining / baseTotal : 0;

    let rating = 0;
    for (const p of active) {
      const adj = adjustmentsById.get(p.espn_id);
      const override = overrides.get(p.espn_id);
      const base = baseMins.get(p.espn_id);
      const mins = override ?? (base != null ? base * scale : 0);
      if (mins <= 0) continue;

      const lebron = p.lebron + (adj?.o_lebron_delta ?? 0) + (adj?.d_lebron_delta ?? 0);
      rating += (lebron * mins) / 48;
      playerMinutes.set(p.espn_id, mins);
    }
    return { rating, playerMinutes };
  }

  // Fallback: top-5 by MPG, rest share the remainder
  active.sort((a, b) => b.mpg - a.mpg);
  const top5 = active.slice(0, 5);
  const rest = active.slice(5);
  const top5Mins = top5.reduce((s, p) => s + p.mpg, 0);
  const remainingMins = Math.max(0, 240 - top5Mins);
  const restTotal = rest.reduce((s, p) => s + p.mpg, 0);

  let rating = 0;
  for (const p of top5) {
    const adj = adjustmentsById.get(p.espn_id);
    const mins = adj?.minutes_override ?? p.mpg;
    const lebron = p.lebron + (adj?.o_lebron_delta ?? 0) + (adj?.d_lebron_delta ?? 0);
    rating += (lebron * mins) / 48;
    playerMinutes.set(p.espn_id, mins);
  }
  for (const p of rest) {
    const adj = adjustmentsById.get(p.espn_id);
    const mins = adj?.minutes_override ?? (restTotal > 0 ? p.mpg * (remainingMins / restTotal) : 0);
    const lebron = p.lebron + (adj?.o_lebron_delta ?? 0) + (adj?.d_lebron_delta ?? 0);
    rating += (lebron * mins) / 48;
    playerMinutes.set(p.espn_id, mins);
  }
  return { rating, playerMinutes };
}

function getTeamRating(
  team: string,
  netRatings: Record<string, number>,
  rostersByTeam: Record<string, SimPlayer[]>,
  playoffMinutes: Record<string, Record<string, number>>,
  adjustmentsById: Map<string, PlayerAdjustment>,
  injuriesByName: Map<string, InjuryEntry>,
  config: SimConfig,
  rng: RNG,
  gameNum: number,
  aliases: Record<string, string>,
  aliasesRev: Record<string, string>,
): { rating: number; playerMinutes: Map<string, number> } {
  const netKey = resolveTeam(team, netRatings, aliases, aliasesRev);
  const nrRating = netRatings[netKey] ?? 0;

  if (config.model === "netrtg") {
    return { rating: nrRating, playerMinutes: new Map() };
  }

  const rosterKey = resolveTeam(team, rostersByTeam, aliases, aliasesRev);
  const roster = rostersByTeam[rosterKey] ?? [];
  const pm = playoffMinutes[team] ?? playoffMinutes[rosterKey] ?? null;
  const result = calcLebronRating(roster, pm, adjustmentsById, injuriesByName, rng, gameNum);

  if (config.model === "lebron") {
    return result;
  }

  // blend
  const blended = config.blendWeight * result.rating + (1 - config.blendWeight) * nrRating;
  return { rating: blended, playerMinutes: result.playerMinutes };
}

interface SeriesPlayerAccum {
  /** Dense (numPlayers × 4) Float32Array of per-round game counts. */
  games: Float32Array;
  /** Dense (numPlayers × 4) Float64Array of per-round points. */
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
  rostersByTeam: Record<string, SimPlayer[]>;
  playoffMinutes: Record<string, Record<string, number>>;
  adjustmentsById: Map<string, PlayerAdjustment>;
  injuriesByName: Map<string, InjuryEntry>;
  playerLookup: Map<string, SimPlayer>;
  seriesPattern: boolean[];
  aliases: Record<string, string>;
  aliasesRev: Record<string, string>;
  liveByKey: Map<string, LiveGameState[]>;
  /** team abbrev (any known alias) → precomputed distribution. */
  teamDistByKey: Map<string, TeamPointDistribution>;
  /** playerIndex: espnId → column in simMatrix / row in accum typed arrays. */
  playerIndex: Map<string, number>;
  numPlayers: number;
  /** Scratch buffer reused by the Dirichlet sampler. */
  scratchShares: Float64Array;
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
  const hResult = getTeamRating(higher, ctx.netRatings, ctx.rostersByTeam, ctx.playoffMinutes, ctx.adjustmentsById, ctx.injuriesByName, ctx.config, rng, gameOffset, ctx.aliases, ctx.aliasesRev);
  const lResult = getTeamRating(lower, ctx.netRatings, ctx.rostersByTeam, ctx.playoffMinutes, ctx.adjustmentsById, ctx.injuriesByName, ctx.config, rng, gameOffset, ctx.aliases, ctx.aliasesRev);
  const hRating = hResult.rating;
  const lRating = lResult.rating;

  let hWins = 0;
  let lWins = 0;

  const liveGames = seriesKey ? ctx.liveByKey.get(seriesKey) : undefined;

  for (let gameNum = 0; gameNum < 7; gameNum++) {
    if (hWins === 4 || lWins === 4) break;

    // Distribute points to players using Dirichlet, using precomputed
    // per-team (playerIdx, alphas) typed arrays — no per-call allocation.
    const accumGames = accum.games;
    const accumPts = accum.pts;
    const scratch = ctx.scratchShares;
    const trackTeam = (team: string, score: number) => {
      const dist = ctx.teamDistByKey.get(team);
      if (!dist || dist.count === 0) return;
      const count = dist.count;
      rng.dirichletInto(dist.alphas, scratch, count);
      const playerIdx = dist.playerIdx;
      for (let i = 0; i < count; i++) {
        const offset = playerIdx[i] * 4 + roundIdx;
        accumGames[offset] += 1;
        accumPts[offset] += score * scratch[i];
      }
    };

    const hTeam = higher;
    const lTeam = lower;

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
        const offset = idx * 4 + roundIdx;
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
        // Simulate only the remaining fraction; HCA is already baked into
        // progress, so we don't re-apply it to the remainder.
        const scaledStd = ctx.config.stdev * Math.sqrt(frac);
        const spread = (hRating - lRating) * frac;
        const margin = rng.normal(spread, scaledStd);
        const remainingTotal = 220 * frac;
        const remainderHigher = Math.max(0, Math.round((remainingTotal + margin) / 2));
        const remainderLower = Math.max(0, Math.round((remainingTotal - margin) / 2));
        trackTeam(hTeam, remainderHigher);
        trackTeam(lTeam, remainderLower);
        const finalHigher = higherActual + remainderHigher;
        const finalLower = lowerActual + remainderLower;
        if (finalHigher >= finalLower) hWins++;
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

    if (higherHome) {
      trackTeam(hTeam, homeScore);
      trackTeam(lTeam, awayScore);
    } else {
      trackTeam(lTeam, homeScore);
      trackTeam(hTeam, awayScore);
    }
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
  const hResult = getTeamRating(higher, ctx.netRatings, ctx.rostersByTeam, ctx.playoffMinutes, ctx.adjustmentsById, ctx.injuriesByName, ctx.config, rng, gameNum, ctx.aliases, ctx.aliasesRev);
  const lResult = getTeamRating(lower, ctx.netRatings, ctx.rostersByTeam, ctx.playoffMinutes, ctx.adjustmentsById, ctx.injuriesByName, ctx.config, rng, gameNum, ctx.aliases, ctx.aliasesRev);
  const { homeWins } = simulateGame(hResult.rating, lResult.rating, rng, ctx.config.hca, ctx.config.stdev);
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

  // Precompute per-team Dirichlet distributions once. Keyed by every known
  // alias so `trackTeam(team, …)` can skip the alias resolution on the hot path.
  const teamDistByKey = new Map<string, TeamPointDistribution>();
  let maxTeamCount = 1;
  const CONCENTRATION = 20;
  for (const teamKey of Object.keys(rostersByTeam)) {
    const roster = rostersByTeam[teamKey];
    const pm = playoffMinutes[teamKey] ?? {};
    const idx: number[] = [];
    const w: number[] = [];
    let total = 0;
    for (const p of roster) {
      const mins = pm[p.nba_id] ?? 0;
      if (mins <= 0) continue;
      const playerIdx = playerIndex.get(p.espn_id);
      if (playerIdx == null) continue;
      const ptsPerMin = p.mpg > 0 ? p.ppg / p.mpg : 1;
      const ww = ptsPerMin * mins;
      idx.push(playerIdx);
      w.push(ww);
      total += ww;
    }
    const count = idx.length;
    const alphas = new Float64Array(count);
    if (total > 0) {
      for (let i = 0; i < count; i++) alphas[i] = (w[i] / total) * CONCENTRATION;
    }
    const dist: TeamPointDistribution = {
      count,
      playerIdx: Int32Array.from(idx),
      alphas,
    };
    teamDistByKey.set(teamKey, dist);
    if (count > maxTeamCount) maxTeamCount = count;
  }
  // Mirror the distribution map across team aliases so hot-path lookups never
  // need to run `resolveTeam`. Both directions of each alias point to the
  // same underlying distribution object.
  for (const [seedAbbr, csvAbbr] of Object.entries(aliases)) {
    const d = teamDistByKey.get(seedAbbr) ?? teamDistByKey.get(csvAbbr);
    if (d) {
      teamDistByKey.set(seedAbbr, d);
      teamDistByKey.set(csvAbbr, d);
    }
  }

  // Build the shared simulation context
  const ctx: SimContext = {
    config,
    netRatings,
    rostersByTeam,
    playoffMinutes,
    adjustmentsById,
    injuriesByName,
    playerLookup,
    seriesPattern: bracket.seriesPattern,
    aliases,
    aliasesRev,
    liveByKey: buildLiveGameMap(data.liveGames),
    teamDistByKey,
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
  // Dense (numPlayers × 4) accumulators across all sims, mirroring the per-sim
  // typed-array accum. Indexed the same way: `idx * 4 + round`.
  const totalGames = new Float64Array(numPlayers * 4);
  const totalPts = new Float64Array(numPlayers * 4);
  // Per-sim accum, reused across sims via .fill(0). Allocating once avoids
  // reallocating ~numPlayers × 4 × 8 bytes every sim.
  const accumGames = new Float32Array(numPlayers * 4);
  const accumPts = new Float64Array(numPlayers * 4);
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

  for (let sim = 0; sim < config.sims; sim++) {
    if (onProgress && sim > 0 && sim % 250 === 0) {
      onProgress(sim / config.sims);
      await new Promise((r) => setTimeout(r, 0));
    }

    accumGames.fill(0);
    accumPts.fill(0);

    // Play-in (points NOT tracked — play-in points don't count for fantasy)
    const [east7, east8] = simulatePlayIn(
      bracket.eastSeeds, bracket.eastPlayin ?? [], ctx, rng,
    );
    const [west7, west8] = simulatePlayIn(
      bracket.westSeeds, bracket.westPlayin ?? [], ctx, rng,
    );

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
      const base = p * 4;
      let total = 0;
      for (let r = 0; r < 4; r++) {
        const pts = accumPts[base + r];
        total += pts;
        totalGames[base + r] += accumGames[base + r];
        totalPts[base + r] += pts;
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
    const result = getTeamRating(team, netRatings, rostersByTeam, playoffMinutes, adjustmentsById, injuriesByName, config, rng, 0, aliases, aliasesRev);
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
      rating: result.rating,
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
    const base = col * 4;
    const games: number[] = [
      totalGames[base],
      totalGames[base + 1],
      totalGames[base + 2],
      totalGames[base + 3],
    ];
    const pts: number[] = [
      totalPts[base],
      totalPts[base + 1],
      totalPts[base + 2],
      totalPts[base + 3],
    ];
    // Skip players who never accumulated anything.
    if (games[0] === 0 && games[1] === 0 && games[2] === 0 && games[3] === 0) {
      continue;
    }

    // Condition on team making the main bracket
    const divisor = teamPlayoffSims[p.team] ?? n;
    if (divisor <= 0) continue;

    const meanPts = (pts[0] + pts[1] + pts[2] + pts[3]) / divisor;

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
