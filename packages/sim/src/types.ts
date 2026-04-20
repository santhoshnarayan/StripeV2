// ─── Simulation data (from /api/app/sim-data) ─────────────────────

export interface SimPlayer {
  espn_id: string;
  nba_id: string;
  name: string;
  team: string;
  pos: string;
  mpg: number;
  ppg: number;
  gp: number;
  lebron: number;
  o_lebron: number;
  d_lebron: number;
  war: number;
  autofill?: boolean;
}

export interface PlayerAdjustment {
  espn_id: string;
  name: string;
  team: string;
  o_lebron_delta: number;
  d_lebron_delta: number;
  minutes_override: number | null;
  /** Per-game availability probabilities: 30 values [P1, P2, R1G1..G7, R2G1..G7, CFG1..G7, FG1..G7].
   *  Default: all 1.0 (fully available). */
  availability: number[];
}

export interface InjuryEntry {
  team: string;
  status: string;
  injury: string;
  /** 30 values: [P1, P2, R1G1..G7, R2G1..G7, CFG1..G7, FG1..G7] */
  availability: number[];
}

export interface LiveGameState {
  seriesKey: string;
  gameNum: number;
  status: "pre" | "in" | "post";
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  /** Regulation = 48 min. 0 = post (complete), 1 = pre (not started), 0..1 = in-progress. */
  remainingFraction: number;
  /** espnId → actual points so far in this game */
  playerPoints: Record<string, number>;
}

export interface SimData {
  bracket: {
    eastSeeds: [number, string][];
    westSeeds: [number, string][];
    eastPlayin: [number, string][];
    westPlayin: [number, string][];
    playinR1?: {
      east: {
        game7v8: { winner: string; loser: string };
        game9v10: { winner: string; loser: string };
      };
      west: {
        game7v8: { winner: string; loser: string };
        game9v10: { winner: string; loser: string };
      };
    };
    playinR2?: {
      east?: { winner: string; loser: string };
      west?: { winner: string; loser: string };
    };
    seriesPattern: boolean[];
    teamAliases: Record<string, string>;
    teamFullNames: Record<string, string>;
  };
  netRatings: Record<string, { net_rtg_per100: number; avg_poss: number; net_rtg_per_game: number }>;
  simPlayers: SimPlayer[];
  playoffMinutes: Record<string, Record<string, number>>;
  adjustments: PlayerAdjustment[];
  injuries: Record<string, InjuryEntry>;
  liveGames?: LiveGameState[];
}

// ─── Simulation configuration ──────────────────────────────────────

export interface SimConfig {
  model: "netrtg" | "lebron" | "blend";
  sims: number;
  stdev: number;
  hca: number;
  blendWeight: number;
}

export const DEFAULT_SIM_CONFIG: SimConfig = {
  model: "lebron",
  sims: 10_000,
  stdev: 10,
  hca: 3,
  blendWeight: 0.5,
};

// ─── Simulation results ────────────────────────────────────────────

export interface TeamSimResult {
  team: string;
  fullName: string;
  seed: number | null;
  conference: "E" | "W" | null;
  rating: number;
  r1: number;    // % of sims this team wins R1
  r2: number;
  cf: number;
  finals: number;
  champ: number;
}

export interface PlayerProjection {
  espnId: string;
  name: string;
  team: string;
  ppg: number;
  mpg: number;
  projectedPoints: number;
  projectedGames: number;
  projectedPointsByRound: number[];  // [R1, R2, CF, Finals]
  projectedGamesByRound: number[];
  /** Per-game means, length 28 = 4 rounds × 7 games. Index = round*7 + gameNum.
   *  Indexes G5-G7 stay 0 if no series in that round reached game 5-7. */
  projectedPointsByGame: number[];
  projectedGamesByGame: number[];
  stddev: number;
  p10: number;
  p90: number;
}

/** Stable ordering of structural series slots in `SimResults.seriesWinners`.
 *  R2 pairings are determined by R1 winners (1v8-winner vs 2v7-winner = top,
 *  4v5-winner vs 3v6-winner = bot), so series identity is structural — not
 *  team-pair-based. UI bracket-conditioning logic relies on this list. */
export const SERIES_KEYS = [
  "r1.east.1v8",
  "r1.east.4v5",
  "r1.east.3v6",
  "r1.east.2v7",
  "r1.west.1v8",
  "r1.west.4v5",
  "r1.west.3v6",
  "r1.west.2v7",
  "r2.east.top",
  "r2.east.bot",
  "r2.west.top",
  "r2.west.bot",
  "cf.east",
  "cf.west",
  "finals",
] as const;
export type SeriesKey = (typeof SERIES_KEYS)[number];

/** Stable ordering of play-in seed assignments in `SimResults.playinSeeds`.
 *  Each Uint8Array gives the team idx that landed in that seed slot per sim. */
export const PLAYIN_KEYS = ["east7", "east8", "west7", "west8"] as const;
export type PlayinKey = (typeof PLAYIN_KEYS)[number];

export interface SimResults {
  teams: TeamSimResult[];
  players: PlayerProjection[];
  /** Flat matrix: sims × numPlayers. simMatrix[sim * numPlayers + playerIdx] = total fantasy pts in that sim. */
  simMatrix: Float64Array;
  /** Map from espnId → column index in simMatrix. */
  playerIndex: Map<string, number>;
  numSims: number;
  /** Per-sim max round a team reached. Values:
   *    0 = eliminated in play-in / not in playoffs
   *    1 = reached R1 (lost R1)
   *    2 = won R1, reached R2
   *    3 = won R2, reached Conference Finals
   *    4 = won CF, reached NBA Finals
   *    5 = NBA Champion
   */
  teamRoundReached: Record<string, Uint8Array>;
  /** Canonical team abbreviations indexed 0..teamNames.length-1. The Uint8Array
   *  values in `seriesWinners` and `playinSeeds` are indices into this array. */
  teamNames: string[];
  /** Lookup from any known team alias → idx into `teamNames`. */
  teamIndex: Map<string, number>;
  /** Per-sim winner of each of the 15 structural series slots.
   *  `seriesWinners[seriesKey][sim]` = idx into `teamNames` of the winner. */
  seriesWinners: Record<SeriesKey, Uint8Array>;
  /** Per-sim play-in seed assignment.
   *  `playinSeeds.east7[sim]` = idx into `teamNames` of the team that
   *  ended up as the East 7 seed in that sim. */
  playinSeeds: Record<PlayinKey, Uint8Array>;
}

// ─── Draft optimizer types ─────────────────────────────────────────

export interface ManagerProjection {
  userId: string;
  name: string;
  mean: number;
  stddev: number;
  p10: number;
  p90: number;
  winProbability: number;
}

export interface MarginalValue {
  espnId: string;
  playerName: string;
  team: string;
  projectedPoints: number;
  currentWinProb: number;
  newWinProb: number;
  marginalWinProb: number;
  suggestedBid: number;
}
