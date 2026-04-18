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
import type {
  LiveGameState,
  SimConfig,
  SimData,
  SimPlayer,
  SimResults,
  TeamSimResult,
  PlayerProjection,
  PlayerAdjustment,
  InjuryEntry,
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
  playerGameCounts: Map<string, number[]>;
  playerPointsAccum: Map<string, number[]>;
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

    // Distribute points to players using Dirichlet
    const trackTeam = (team: string, score: number) => {
      const teamKey = resolveTeam(team, ctx.rostersByTeam, ctx.aliases, ctx.aliasesRev);
      const roster = ctx.rostersByTeam[teamKey] ?? [];
      const pm = ctx.playoffMinutes[team] ?? ctx.playoffMinutes[teamKey] ?? {};

      const activeIds: string[] = [];
      const weights: number[] = [];
      let totalWeight = 0;

      for (const p of roster) {
        // Only distribute points to players who have projected playoff minutes.
        // Using regular-season MPG as fallback dilutes star shares and under-
        // projects top scorers. Matches the explore reference behavior.
        const mins = pm[p.nba_id] ?? 0;
        if (mins <= 0) continue;
        const ptsPerMin = p.mpg > 0 ? p.ppg / p.mpg : 1;
        const w = ptsPerMin * mins;
        activeIds.push(p.espn_id);
        weights.push(w);
        totalWeight += w;
      }

      if (activeIds.length === 0 || totalWeight === 0) return;

      // Dirichlet-distributed shares (concentration=20)
      const concentration = 20;
      const alphas = weights.map((w) => (w / totalWeight) * concentration);
      const shares = rng.dirichlet(alphas);

      for (let i = 0; i < activeIds.length; i++) {
        const espnId = activeIds[i];
        const gc = accum.playerGameCounts.get(espnId) ?? [0, 0, 0, 0];
        gc[roundIdx] = (gc[roundIdx] ?? 0) + 1;
        accum.playerGameCounts.set(espnId, gc);

        const pts = score * shares[i];
        const pa = accum.playerPointsAccum.get(espnId) ?? [0, 0, 0, 0];
        pa[roundIdx] = (pa[roundIdx] ?? 0) + pts;
        accum.playerPointsAccum.set(espnId, pa);
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
      const touched = new Set<string>();
      for (const [espnId, pts] of Object.entries(live.playerPoints)) {
        if (!Number.isFinite(pts) || pts <= 0) continue;
        const pa = accum.playerPointsAccum.get(espnId) ?? [0, 0, 0, 0];
        pa[roundIdx] = (pa[roundIdx] ?? 0) + pts;
        accum.playerPointsAccum.set(espnId, pa);
        touched.add(espnId);
      }
      for (const espnId of touched) {
        const gc = accum.playerGameCounts.get(espnId) ?? [0, 0, 0, 0];
        gc[roundIdx] = (gc[roundIdx] ?? 0) + 1;
        accum.playerGameCounts.set(espnId, gc);
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
  };

  // Build player index for the sim matrix
  const allPlayerIds = simPlayers.map((p) => p.espn_id);
  const playerIndex = new Map<string, number>();
  allPlayerIds.forEach((id, idx) => playerIndex.set(id, idx));
  const numPlayers = allPlayerIds.length;

  // Sim matrix: sims × numPlayers
  const simMatrix = new Float64Array(config.sims * numPlayers);

  const rng = new RNG(42);

  // Accumulators
  const r1Counts: Record<string, number> = {};
  const r2Counts: Record<string, number> = {};
  const cfCounts: Record<string, number> = {};
  const finalsCounts: Record<string, number> = {};
  const champCounts: Record<string, number> = {};
  const totalPlayerGames = new Map<string, number[]>();
  const totalPlayerPoints = new Map<string, number[]>();
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

    const accum: SeriesPlayerAccum = {
      playerGameCounts: new Map(),
      playerPointsAccum: new Map(),
    };

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
      e1w.push(winner);
    }
    const w1w: string[] = [];
    for (const { pair: [h, l], key } of westR1) {
      const winner = simulateSeries(h, l, ctx, rng, 0, accum, 2, key);
      r1Counts[winner] = (r1Counts[winner] ?? 0) + 1;
      markReached(winner, 2, sim);
      w1w.push(winner);
    }

    // Round 2: preserve original pairings (e1w: 0=1v8, 1=4v5, 2=3v6, 3=2v7).
    // top = 1v8-winner vs 2v7-winner (was index 0 × 3), bot = 4v5-winner vs 3v6-winner (1 × 2).
    const eastR2: Array<{ pair: [string, string]; key: string }> = [
      { pair: orderMatchup(e1w[0], e1w[3], allSeeds, allPlayin), key: "r2.east.top" },
      { pair: orderMatchup(e1w[1], e1w[2], allSeeds, allPlayin), key: "r2.east.bot" },
    ];
    const westR2: Array<{ pair: [string, string]; key: string }> = [
      { pair: orderMatchup(w1w[0], w1w[3], allSeeds, allPlayin), key: "r2.west.top" },
      { pair: orderMatchup(w1w[1], w1w[2], allSeeds, allPlayin), key: "r2.west.bot" },
    ];

    const e2w: string[] = [];
    for (const { pair: [h, l], key } of eastR2) {
      const winner = simulateSeries(h, l, ctx, rng, 1, accum, 9, key);
      r2Counts[winner] = (r2Counts[winner] ?? 0) + 1;
      markReached(winner, 3, sim);
      e2w.push(winner);
    }
    const w2w: string[] = [];
    for (const { pair: [h, l], key } of westR2) {
      const winner = simulateSeries(h, l, ctx, rng, 1, accum, 9, key);
      r2Counts[winner] = (r2Counts[winner] ?? 0) + 1;
      markReached(winner, 3, sim);
      w2w.push(winner);
    }

    // Conference Finals
    const [ecfH, ecfL] = orderMatchup(e2w[0], e2w[1], allSeeds, allPlayin);
    const ecfWinner = simulateSeries(ecfH, ecfL, ctx, rng, 2, accum, 16, "cf.east");
    cfCounts[ecfWinner] = (cfCounts[ecfWinner] ?? 0) + 1;
    markReached(ecfWinner, 4, sim);

    const [wcfH, wcfL] = orderMatchup(w2w[0], w2w[1], allSeeds, allPlayin);
    const wcfWinner = simulateSeries(wcfH, wcfL, ctx, rng, 2, accum, 16, "cf.west");
    cfCounts[wcfWinner] = (cfCounts[wcfWinner] ?? 0) + 1;
    markReached(wcfWinner, 4, sim);

    // Finals
    const [finH, finL] = orderMatchup(ecfWinner, wcfWinner, allSeeds, allPlayin);
    const finWinner = simulateSeries(finH, finL, ctx, rng, 3, accum, 23, "finals");
    finalsCounts[finWinner] = (finalsCounts[finWinner] ?? 0) + 1;
    champCounts[finWinner] = (champCounts[finWinner] ?? 0) + 1;
    markReached(finWinner, 5, sim);

    // Record per-sim per-player totals into the sim matrix
    for (const [espnId, pts] of accum.playerPointsAccum) {
      const colIdx = playerIndex.get(espnId);
      if (colIdx == null) continue;
      const total = pts.reduce((s, v) => s + v, 0);
      simMatrix[sim * numPlayers + colIdx] = total;
    }

    // Accumulate for aggregate projections
    for (const [espnId, games] of accum.playerGameCounts) {
      const existing = totalPlayerGames.get(espnId) ?? [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) existing[i] += games[i] ?? 0;
      totalPlayerGames.set(espnId, existing);
    }
    for (const [espnId, pts] of accum.playerPointsAccum) {
      const existing = totalPlayerPoints.get(espnId) ?? [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) existing[i] += pts[i] ?? 0;
      totalPlayerPoints.set(espnId, existing);
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
  for (const [espnId, games] of totalPlayerGames) {
    const p = playerLookup.get(espnId);
    if (!p) continue;
    const pts = totalPlayerPoints.get(espnId) ?? [0, 0, 0, 0];

    // Condition on team making the main bracket
    const divisor = teamPlayoffSims[p.team] ?? n;
    if (divisor <= 0) continue;

    const meanPts = pts.reduce((s, pt) => s + pt, 0) / divisor;

    // Compute stddev, p10, p90 from sim matrix
    const col = playerIndex.get(espnId);
    let stddev = 0;
    let p10 = 0;
    let p90 = 0;
    if (col != null) {
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
    }

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

  return { teams, players, simMatrix, playerIndex, numSims: n, teamRoundReached };
}
