import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRACKET_PATH = path.resolve(__dirname, "../../data/nba-bracket-2026.json");

export interface BracketData {
  eastSeeds: [number, string][];
  westSeeds: [number, string][];
  eastPlayin: [number, string][];
  westPlayin: [number, string][];
  playinR1?: {
    east?: { game7v8?: { winner: string; loser: string }; game9v10?: { winner: string; loser: string } };
    west?: { game7v8?: { winner: string; loser: string }; game9v10?: { winner: string; loser: string } };
  };
  playinR2?: {
    east?: { winner: string; loser: string };
    west?: { winner: string; loser: string };
  };
  eliminatedTeams: string[];
  seriesPattern: boolean[];
  teamAliases: Record<string, string>;
  teamFullNames: Record<string, string>;
  // r1/r2/cf/finals results (manual population as games finish)
  r1Results?: Record<string, { winner: string; loser: string }>;
  r2Results?: Record<string, { winner: string; loser: string }>;
  cfResults?: Record<string, { winner: string; loser: string }>;
  finalsResult?: { winner: string; loser: string };
}

let cache: { data: BracketData; mtimeMs: number } | null = null;

export function loadBracket(): BracketData {
  const stat = fs.statSync(BRACKET_PATH);
  if (cache && cache.mtimeMs === stat.mtimeMs) return cache.data;
  const data = JSON.parse(fs.readFileSync(BRACKET_PATH, "utf8")) as BracketData;
  cache = { data, mtimeMs: stat.mtimeMs };
  return data;
}

/** Returns { canonical, aliases } — a set of equivalent abbreviations for a team. */
export function teamEquivalents(abbrev: string, aliases: Record<string, string>): Set<string> {
  const up = abbrev.toUpperCase();
  const set = new Set<string>([up]);
  if (aliases[up]) set.add(aliases[up].toUpperCase());
  for (const [k, v] of Object.entries(aliases)) {
    if (v.toUpperCase() === up) set.add(k.toUpperCase());
  }
  return set;
}

/** Normalize any abbreviation to the bracket's canonical form. */
export function normalizeTeam(abbrev: string, aliases: Record<string, string>): string {
  const up = abbrev.toUpperCase();
  // If ESPN variant maps TO us, reverse-lookup
  for (const [bracketKey, espnKey] of Object.entries(aliases)) {
    if (espnKey.toUpperCase() === up) return bracketKey.toUpperCase();
  }
  return up;
}

export interface SeriesDef {
  key: string; // e.g. "r1.east.1v8"
  round: "r1" | "r2" | "cf" | "finals";
  conference?: "east" | "west";
  higherSeed?: number;
  lowerSeed?: number;
  higher: string;
  lower: string;
  teams: Set<string>;
}

/** Derive the current round-1 series from seeds (using playinR2 winners for #8 seeds). */
export function getRound1Series(bracket: BracketData): SeriesDef[] {
  const series: SeriesDef[] = [];

  for (const conf of ["east", "west"] as const) {
    const seeds = conf === "east" ? bracket.eastSeeds : bracket.westSeeds;
    const seedMap = new Map<number, string>();
    for (const [s, t] of seeds) seedMap.set(s, t);

    // Apply playinR2 winner to 8-seed if present
    const playinR2 = bracket.playinR2?.[conf];
    const eight = playinR2?.winner ?? seedMap.get(8);
    if (eight) seedMap.set(8, eight);

    const pairings: [number, number][] = [
      [1, 8],
      [2, 7],
      [3, 6],
      [4, 5],
    ];
    for (const [h, l] of pairings) {
      const higher = seedMap.get(h);
      const lower = seedMap.get(l);
      if (!higher || !lower) continue;
      series.push({
        key: `r1.${conf}.${h}v${l}`,
        round: "r1",
        conference: conf,
        higherSeed: h,
        lowerSeed: l,
        higher,
        lower,
        teams: new Set([higher.toUpperCase(), lower.toUpperCase()]),
      });
    }
  }
  return series;
}

/** Derive R2 matchups that are known (both R1 winners decided). */
export function getRound2Series(bracket: BracketData): SeriesDef[] {
  const r1 = bracket.r1Results ?? {};
  const out: SeriesDef[] = [];
  for (const conf of ["east", "west"] as const) {
    // R2: winner(1v8) vs winner(4v5), winner(2v7) vs winner(3v6)
    const w18 = r1[`r1.${conf}.1v8`]?.winner;
    const w45 = r1[`r1.${conf}.4v5`]?.winner;
    const w27 = r1[`r1.${conf}.2v7`]?.winner;
    const w36 = r1[`r1.${conf}.3v6`]?.winner;
    if (w18 && w45) {
      out.push({
        key: `r2.${conf}.top`,
        round: "r2",
        conference: conf,
        higher: w18,
        lower: w45,
        teams: new Set([w18.toUpperCase(), w45.toUpperCase()]),
      });
    }
    if (w27 && w36) {
      out.push({
        key: `r2.${conf}.bot`,
        round: "r2",
        conference: conf,
        higher: w27,
        lower: w36,
        teams: new Set([w27.toUpperCase(), w36.toUpperCase()]),
      });
    }
  }
  return out;
}

export function getConferenceFinals(bracket: BracketData): SeriesDef[] {
  const r2 = bracket.r2Results ?? {};
  const out: SeriesDef[] = [];
  for (const conf of ["east", "west"] as const) {
    const wTop = r2[`r2.${conf}.top`]?.winner;
    const wBot = r2[`r2.${conf}.bot`]?.winner;
    if (wTop && wBot) {
      out.push({
        key: `cf.${conf}`,
        round: "cf",
        conference: conf,
        higher: wTop,
        lower: wBot,
        teams: new Set([wTop.toUpperCase(), wBot.toUpperCase()]),
      });
    }
  }
  return out;
}

export function getFinals(bracket: BracketData): SeriesDef[] {
  const cf = bracket.cfResults ?? {};
  const wEast = cf["cf.east"]?.winner;
  const wWest = cf["cf.west"]?.winner;
  if (!wEast || !wWest) return [];
  return [
    {
      key: "finals",
      round: "finals",
      higher: wEast,
      lower: wWest,
      teams: new Set([wEast.toUpperCase(), wWest.toUpperCase()]),
    },
  ];
}

export function getAllActiveSeries(bracket: BracketData): SeriesDef[] {
  return [
    ...getRound1Series(bracket),
    ...getRound2Series(bracket),
    ...getConferenceFinals(bracket),
    ...getFinals(bracket),
  ];
}

/**
 * Given a pair of team abbreviations from an ESPN event, find the matching bracket series.
 * Tries canonical abbreviation first, then falls through teamAliases.
 */
export function matchSeriesForTeams(
  homeAbbrev: string,
  awayAbbrev: string,
  bracket: BracketData,
): SeriesDef | null {
  const home = normalizeTeam(homeAbbrev, bracket.teamAliases);
  const away = normalizeTeam(awayAbbrev, bracket.teamAliases);
  const active = getAllActiveSeries(bracket);
  for (const series of active) {
    if (series.teams.has(home) && series.teams.has(away)) return series;
    // Also check ESPN-side aliases
    const altHome = teamEquivalents(homeAbbrev, bracket.teamAliases);
    const altAway = teamEquivalents(awayAbbrev, bracket.teamAliases);
    for (const h of altHome) {
      for (const a of altAway) {
        if (series.teams.has(h) && series.teams.has(a)) return series;
      }
    }
  }
  return null;
}
