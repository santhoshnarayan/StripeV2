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
}

export interface SimData {
  bracket: {
    eastSeeds: [number, string][];
    westSeeds: [number, string][];
    eastPlayin: [number, string][];
    westPlayin: [number, string][];
    seriesPattern: boolean[];
    teamAliases: Record<string, string>;
    teamFullNames: Record<string, string>;
  };
  netRatings: Record<string, { net_rtg_per100: number; avg_poss: number; net_rtg_per_game: number }>;
  simPlayers: SimPlayer[];
  playoffMinutes: Record<string, Record<string, number>>;
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
  model: "netrtg",
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
}

export interface SimResults {
  teams: TeamSimResult[];
  players: PlayerProjection[];
  /** Flat matrix: sims × numPlayers. simMatrix[sim * numPlayers + playerIdx] = total fantasy pts in that sim. */
  simMatrix: Float64Array;
  /** Map from espnId → column index in simMatrix. */
  playerIndex: Map<string, number>;
  numSims: number;
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
