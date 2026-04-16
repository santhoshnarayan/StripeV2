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
import type {
  SimConfig,
  SimData,
  SimPlayer,
  SimResults,
  TeamSimResult,
  PlayerProjection,
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

function getTeamRating(
  team: string,
  netRatings: Record<string, number>,
  aliases: Record<string, string>,
  aliasesRev: Record<string, string>,
): number {
  const key = resolveTeam(team, netRatings, aliases, aliasesRev);
  return netRatings[key] ?? 0;
}

interface SeriesPlayerAccum {
  playerGameCounts: Map<string, number[]>;
  playerPointsAccum: Map<string, number[]>;
}

function simulateSeries(
  higher: string,
  lower: string,
  netRatings: Record<string, number>,
  rostersByTeam: Record<string, SimPlayer[]>,
  playoffMinutes: Record<string, Record<string, number>>,
  config: SimConfig,
  rng: RNG,
  roundIdx: number,
  accum: SeriesPlayerAccum,
  playerLookup: Map<string, SimPlayer>,
  seriesPattern: boolean[],
  aliases: Record<string, string>,
  aliasesRev: Record<string, string>,
): string {
  const hRating = getTeamRating(higher, netRatings, aliases, aliasesRev);
  const lRating = getTeamRating(lower, netRatings, aliases, aliasesRev);

  let hWins = 0;
  let lWins = 0;

  for (let gameNum = 0; gameNum < 7; gameNum++) {
    if (hWins === 4 || lWins === 4) break;

    const higherHome = seriesPattern[gameNum];
    const { homeWins, homeScore, awayScore } = higherHome
      ? simulateGame(hRating, lRating, rng, config.hca, config.stdev)
      : simulateGame(lRating, hRating, rng, config.hca, config.stdev);

    const higherWon = higherHome ? homeWins : !homeWins;
    if (higherWon) hWins++;
    else lWins++;

    // Distribute points to players using Dirichlet
    const trackTeam = (team: string, score: number) => {
      const teamKey = resolveTeam(team, rostersByTeam, aliases, aliasesRev);
      const roster = rostersByTeam[teamKey] ?? [];
      const pm = playoffMinutes[team] ?? playoffMinutes[teamKey] ?? {};

      const activeIds: string[] = [];
      const weights: number[] = [];
      let totalWeight = 0;

      for (const p of roster) {
        const mins = pm[p.nba_id] ?? (p.mpg > 0 ? p.mpg : 0);
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
  netRatings: Record<string, number>,
  config: SimConfig,
  rng: RNG,
  aliases: Record<string, string>,
  aliasesRev: Record<string, string>,
): { winner: string; loser: string } {
  const hRating = getTeamRating(higher, netRatings, aliases, aliasesRev);
  const lRating = getTeamRating(lower, netRatings, aliases, aliasesRev);
  const { homeWins } = simulateGame(hRating, lRating, rng, config.hca, config.stdev);
  return homeWins
    ? { winner: higher, loser: lower }
    : { winner: lower, loser: higher };
}

function simulatePlayIn(
  seeds: [number, string][],
  playin: [number, string][],
  netRatings: Record<string, number>,
  config: SimConfig,
  rng: RNG,
  aliases: Record<string, string>,
  aliasesRev: Record<string, string>,
): [string, string] {
  const s7 = seeds.find(([s]) => s === 7)?.[1] ?? "";
  const s8 = seeds.find(([s]) => s === 8)?.[1] ?? "";
  const s9 = playin.find(([s]) => s === 9)?.[1] ?? "";
  const s10 = playin.find(([s]) => s === 10)?.[1] ?? "";

  const g1 = simulatePlayInGame(s7, s8, netRatings, config, rng, aliases, aliasesRev);
  const seed7 = g1.winner;

  const g2 = simulatePlayInGame(s9, s10, netRatings, config, rng, aliases, aliasesRev);

  const g3 = simulatePlayInGame(g1.loser, g2.winner, netRatings, config, rng, aliases, aliasesRev);
  const seed8 = g3.winner;

  return [seed7, seed8];
}

// ─── Main simulation ───────────────────────────────────────────────

export function runTournamentSim(
  data: SimData,
  config: SimConfig,
  onProgress?: (fraction: number) => void,
): SimResults {
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

  const allSeeds = [...bracket.eastSeeds, ...bracket.westSeeds];
  const allPlayin = [...(bracket.eastPlayin ?? []), ...(bracket.westPlayin ?? [])];

  for (let sim = 0; sim < config.sims; sim++) {
    if (onProgress && sim > 0 && sim % 500 === 0) {
      onProgress(sim / config.sims);
    }

    const accum: SeriesPlayerAccum = {
      playerGameCounts: new Map(),
      playerPointsAccum: new Map(),
    };

    // Play-in
    const [east7, east8] = simulatePlayIn(
      bracket.eastSeeds, bracket.eastPlayin ?? [], netRatings, config, rng, aliases, aliasesRev,
    );
    const [west7, west8] = simulatePlayIn(
      bracket.westSeeds, bracket.westPlayin ?? [], netRatings, config, rng, aliases, aliasesRev,
    );

    // R1 matchups
    const eastR1: [string, string][] = [
      [bracket.eastSeeds[0][1], east8],
      [bracket.eastSeeds[3][1], bracket.eastSeeds[4][1]],
      [bracket.eastSeeds[2][1], bracket.eastSeeds[5][1]],
      [bracket.eastSeeds[1][1], east7],
    ];
    const westR1: [string, string][] = [
      [bracket.westSeeds[0][1], west8],
      [bracket.westSeeds[3][1], bracket.westSeeds[4][1]],
      [bracket.westSeeds[2][1], bracket.westSeeds[5][1]],
      [bracket.westSeeds[1][1], west7],
    ];

    // Round 1
    const e1w: string[] = [];
    for (const [h, l] of eastR1) {
      const winner = simulateSeries(h, l, netRatings, rostersByTeam, playoffMinutes, config, rng, 0, accum, playerLookup, bracket.seriesPattern, aliases, aliasesRev);
      r1Counts[winner] = (r1Counts[winner] ?? 0) + 1;
      e1w.push(winner);
    }
    const w1w: string[] = [];
    for (const [h, l] of westR1) {
      const winner = simulateSeries(h, l, netRatings, rostersByTeam, playoffMinutes, config, rng, 0, accum, playerLookup, bracket.seriesPattern, aliases, aliasesRev);
      r1Counts[winner] = (r1Counts[winner] ?? 0) + 1;
      w1w.push(winner);
    }

    // Round 2
    const eastR2: [string, string][] = [
      orderMatchup(e1w[0], e1w[3], allSeeds, allPlayin),
      orderMatchup(e1w[1], e1w[2], allSeeds, allPlayin),
    ];
    const westR2: [string, string][] = [
      orderMatchup(w1w[0], w1w[3], allSeeds, allPlayin),
      orderMatchup(w1w[1], w1w[2], allSeeds, allPlayin),
    ];

    const e2w: string[] = [];
    for (const [h, l] of eastR2) {
      const winner = simulateSeries(h, l, netRatings, rostersByTeam, playoffMinutes, config, rng, 1, accum, playerLookup, bracket.seriesPattern, aliases, aliasesRev);
      r2Counts[winner] = (r2Counts[winner] ?? 0) + 1;
      e2w.push(winner);
    }
    const w2w: string[] = [];
    for (const [h, l] of westR2) {
      const winner = simulateSeries(h, l, netRatings, rostersByTeam, playoffMinutes, config, rng, 1, accum, playerLookup, bracket.seriesPattern, aliases, aliasesRev);
      r2Counts[winner] = (r2Counts[winner] ?? 0) + 1;
      w2w.push(winner);
    }

    // Conference Finals
    const [ecfH, ecfL] = orderMatchup(e2w[0], e2w[1], allSeeds, allPlayin);
    const ecfWinner = simulateSeries(ecfH, ecfL, netRatings, rostersByTeam, playoffMinutes, config, rng, 2, accum, playerLookup, bracket.seriesPattern, aliases, aliasesRev);
    cfCounts[ecfWinner] = (cfCounts[ecfWinner] ?? 0) + 1;

    const [wcfH, wcfL] = orderMatchup(w2w[0], w2w[1], allSeeds, allPlayin);
    const wcfWinner = simulateSeries(wcfH, wcfL, netRatings, rostersByTeam, playoffMinutes, config, rng, 2, accum, playerLookup, bracket.seriesPattern, aliases, aliasesRev);
    cfCounts[wcfWinner] = (cfCounts[wcfWinner] ?? 0) + 1;

    // Finals
    const [finH, finL] = orderMatchup(ecfWinner, wcfWinner, allSeeds, allPlayin);
    const finWinner = simulateSeries(finH, finL, netRatings, rostersByTeam, playoffMinutes, config, rng, 3, accum, playerLookup, bracket.seriesPattern, aliases, aliasesRev);
    finalsCounts[finWinner] = (finalsCounts[finWinner] ?? 0) + 1;
    champCounts[finWinner] = (champCounts[finWinner] ?? 0) + 1;

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
    const rating = getTeamRating(team, netRatings, aliases, aliasesRev);
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

  // Build player projections
  const players: PlayerProjection[] = [];
  for (const [espnId, games] of totalPlayerGames) {
    const p = playerLookup.get(espnId);
    if (!p) continue;
    const pts = totalPlayerPoints.get(espnId) ?? [0, 0, 0, 0];

    players.push({
      espnId,
      name: p.name,
      team: p.team,
      ppg: p.ppg,
      mpg: p.mpg,
      projectedGames: games.reduce((s, g) => s + g, 0) / n,
      projectedPoints: pts.reduce((s, pt) => s + pt, 0) / n,
      projectedPointsByRound: pts.map((pt) => pt / n),
      projectedGamesByRound: games.map((g) => g / n),
    });
  }

  players.sort((a, b) => b.projectedPoints - a.projectedPoints);

  return { teams, players, simMatrix, playerIndex, numSims: n };
}
