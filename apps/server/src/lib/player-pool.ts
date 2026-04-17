import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type PlayerPoolEntry = {
  rank: number;
  id: string;
  name: string;
  team: string;
  conference: string;
  seed: number | null;
  gamesPlayed: number | null;
  minutesPerGame: number | null;
  pointsPerGame: number | null;
  suggestedValue: number;
  totalPoints: number | null;
  totalGames: number | null;
  // Per-round projected points (used for injury discounting)
  r1Pts: number;
  r2Pts: number;
  cfPts: number;
  finalsPts: number;
};

const PLAYER_FILE_CANDIDATES = [
  path.resolve(process.cwd(), "nba-player-pool-values.csv"),
  path.resolve(process.cwd(), "../../nba-player-pool-values.csv"),
];

let cachedPlayers: PlayerPoolEntry[] | null = null;

function parseCsvLine(line: string) {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === '"') {
      const nextCharacter = line[index + 1];

      if (inQuotes && nextCharacter === '"') {
        current += '"';
        index += 1;
        continue;
      }

      inQuotes = !inQuotes;
      continue;
    }

    if (character === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += character;
  }

  values.push(current);

  return values;
}

function toNullableNumber(value: string | undefined) {
  if (!value) {
    return null;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

async function readPlayersFile() {
  for (const candidate of PLAYER_FILE_CANDIDATES) {
    try {
      await access(candidate);
      return await readFile(candidate, "utf8");
    } catch {
      continue;
    }
  }

  throw new Error("Could not locate nba-player-pool-values.csv");
}

export async function getPlayerPool() {
  if (cachedPlayers) {
    return cachedPlayers;
  }

  const fileContents = await readPlayersFile();
  const lines = fileContents.trim().split(/\r?\n/);
  const [headerLine, ...playerLines] = lines;
  const headers = parseCsvLine(headerLine);

  cachedPlayers = playerLines
    .map((line) => {
      const values = parseCsvLine(line);
      const row = Object.fromEntries(
        headers.map((header, index) => [header, values[index] ?? ""]),
      ) as Record<string, string>;

      return {
        rank: toNullableNumber(row.Rank) ?? 0,
        id: row.ID,
        name: row.Player,
        team: row.Team,
        conference: row.Conf,
        seed: toNullableNumber(row.Seed),
        gamesPlayed: toNullableNumber(row.GP),
        minutesPerGame: toNullableNumber(row.MPG),
        pointsPerGame: toNullableNumber(row.PPG),
        suggestedValue: toNullableNumber(row["$"]) ?? 0,
        totalPoints: toNullableNumber(row["Total Pts"]),
        totalGames: toNullableNumber(row["Total GP"]),
        r1Pts: toNullableNumber(row["R1 Pts"]) ?? 0,
        r2Pts: toNullableNumber(row["R2 Pts"]) ?? 0,
        cfPts: toNullableNumber(row["CF Pts"]) ?? 0,
        finalsPts: toNullableNumber(row["Finals Pts"]) ?? 0,
      } satisfies PlayerPoolEntry;
    })
    .sort((left, right) => {
      if (right.suggestedValue !== left.suggestedValue) {
        return right.suggestedValue - left.suggestedValue;
      }

      return left.rank - right.rank;
    });

  return cachedPlayers;
}

export async function getPlayerPoolMap() {
  const players = await getPlayerPool();
  return new Map(players.map((player) => [player.id, player]));
}

// ---------- Injury-adjusted projections ----------

interface InjuryEntry {
  team: string;
  status: string;
  injury: string;
  availability: number[];
}

const INJURY_FILE_CANDIDATES = [
  path.resolve(process.cwd(), "src/data/nba-injuries-2026.json"),
  path.resolve(process.cwd(), "apps/server/src/data/nba-injuries-2026.json"),
];

let cachedInjuries: Record<string, InjuryEntry> | null = null;

async function loadInjuries(): Promise<Record<string, InjuryEntry>> {
  if (cachedInjuries) return cachedInjuries;
  for (const candidate of INJURY_FILE_CANDIDATES) {
    try {
      await access(candidate);
      const raw = JSON.parse(await readFile(candidate, "utf8"));
      delete raw._meta;
      cachedInjuries = raw as Record<string, InjuryEntry>;
      return cachedInjuries;
    } catch {
      continue;
    }
  }
  return {};
}

/**
 * Discount a player's per-round projected points by their injury availability.
 *
 * Availability array: [P1, P2, R1G1..G7, R2G1..G7, CFG1..G7, FG1..G7]
 * CSV rounds: R1 Pts (games 2-8), R2 Pts (games 9-15), CF Pts (games 16-22), Finals Pts (games 23-29)
 *
 * For each round, the discount = average availability across that round's games.
 * Adjusted totalPoints = R1Pts × avgAvailR1 + R2Pts × avgAvailR2 + ...
 */
function discountByInjury(
  r1Pts: number,
  r2Pts: number,
  cfPts: number,
  fPts: number,
  availability: number[],
): number {
  function avgSlice(arr: number[], start: number, end: number): number {
    const slice = arr.slice(start, end);
    if (slice.length === 0) return 1;
    return slice.reduce((s, v) => s + v, 0) / slice.length;
  }

  const avgR1 = avgSlice(availability, 2, 9);
  const avgR2 = avgSlice(availability, 9, 16);
  const avgCF = avgSlice(availability, 16, 23);
  const avgF = avgSlice(availability, 23, 30);

  return r1Pts * avgR1 + r2Pts * avgR2 + cfPts * avgCF + fPts * avgF;
}

// ---------- Auction value (VORP-based) ----------

export type AuctionConfig = {
  managers: number;
  rosterSize: number;
  budgetPerTeam: number;
  minBid: number;
};

// Default assumption used on the public /players page (and anywhere no
// real league context is available): 8-manager league, 9 picks per team,
// $200 budget, $1 minimum bid.
export const DEFAULT_AUCTION_CONFIG: AuctionConfig = {
  managers: 8,
  rosterSize: 9,
  budgetPerTeam: 200,
  minBid: 1,
};

/**
 * Compute per-player dollar values for a given league configuration using
 * Value Over Replacement Player (VORP).
 *
 * Algorithm:
 *   1. Total draft pool = managers * rosterSize. Sort players by projected
 *      playoff total points descending and take the top `draftPoolSize`.
 *   2. The "replacement player" is the first *undrafted* player — the one
 *      at index `draftPoolSize` in the sorted list. Everyone in the draft
 *      pool has their VORP measured relative to that player's projected
 *      points.
 *   3. Total dollars in play = managers * budgetPerTeam. Each slot costs at
 *      least `minBid`, so the "free" dollars teams can distribute above
 *      the minimum are: managers * (budgetPerTeam - rosterSize * minBid).
 *   4. Each drafted player's value = `minBid + (playerVorp / totalVorp) *
 *      freeDollars`. Players outside the draft pool (and the replacement
 *      player itself) are worth exactly `minBid`.
 *
 * Returns a new array; the input is not mutated. Players outside the draft
 * pool get `suggestedValue = minBid` rather than their raw CSV value, so the
 * league's own economics are always self-consistent.
 */
export function computeAuctionValues<T extends PlayerPoolEntry>(
  players: T[],
  config: AuctionConfig,
): T[] {
  const managers = Math.max(1, Math.floor(config.managers));
  const rosterSize = Math.max(1, Math.floor(config.rosterSize));
  const budgetPerTeam = Math.max(0, Math.floor(config.budgetPerTeam));
  const minBid = Math.max(1, Math.floor(config.minBid));

  const draftPoolSize = Math.min(players.length, managers * rosterSize);
  const totalDollars = managers * budgetPerTeam;
  const minCommitted = managers * rosterSize * minBid;
  const freeDollars = Math.max(0, totalDollars - minCommitted);

  const sortedByPoints = [...players].sort((left, right) => {
    const leftPts = left.totalPoints ?? Number.NEGATIVE_INFINITY;
    const rightPts = right.totalPoints ?? Number.NEGATIVE_INFINITY;
    if (rightPts !== leftPts) {
      return rightPts - leftPts;
    }
    return right.suggestedValue - left.suggestedValue;
  });

  // Replacement = the first player NOT in the draft pool (if the pool is
  // smaller than the player list). If every player is drafted, replacement
  // points fall back to the lowest-scoring player's points so VORP stays
  // non-negative.
  const replacementPlayer =
    sortedByPoints[draftPoolSize] ?? sortedByPoints[sortedByPoints.length - 1];
  const replacementPts = Math.max(0, replacementPlayer?.totalPoints ?? 0);

  const draftPool = sortedByPoints.slice(0, draftPoolSize);
  const vorps = draftPool.map((player) => {
    const pts = player.totalPoints ?? 0;
    return Math.max(0, pts - replacementPts);
  });
  const totalVorp = vorps.reduce((sum, value) => sum + value, 0);

  const valueById = new Map<string, number>();
  draftPool.forEach((player, index) => {
    let value: number;
    if (totalVorp > 0) {
      value = minBid + Math.round((vorps[index] / totalVorp) * freeDollars);
    } else if (draftPoolSize > 0) {
      value = minBid + Math.round(freeDollars / draftPoolSize);
    } else {
      value = minBid;
    }
    valueById.set(player.id, Math.max(minBid, value));
  });

  return players.map((player) => ({
    ...player,
    suggestedValue: valueById.get(player.id) ?? minBid,
  }));
}

/**
 * Load the full player pool and apply auction values for the given config.
 * When no config is passed the default (8 managers × 9 picks × $200) is
 * used — that's what the public /players page shows.
 */
export async function getPlayerPoolForAuction(
  config: AuctionConfig = DEFAULT_AUCTION_CONFIG,
) {
  const players = await getPlayerPool();
  const injuries = await loadInjuries();

  // Discount totalPoints by injury availability before computing VORP
  const adjusted = players.map((player) => {
    const injury = injuries[player.name];
    if (!injury || !injury.availability) return player;

    const adjustedTotal = discountByInjury(
      player.r1Pts,
      player.r2Pts,
      player.cfPts,
      player.finalsPts,
      injury.availability,
    );

    return {
      ...player,
      totalPoints: Math.round(adjustedTotal * 10) / 10,
    };
  });

  return computeAuctionValues(adjusted, config);
}

export async function getPlayerPoolMapForAuction(
  config: AuctionConfig = DEFAULT_AUCTION_CONFIG,
) {
  const players = await getPlayerPoolForAuction(config);
  return new Map(players.map((player) => [player.id, player]));
}

export function auctionConfigFromLeague(league: {
  rosterSize: number;
  budgetPerTeam: number;
  minBid: number;
}, managers: number): AuctionConfig {
  return {
    managers,
    rosterSize: league.rosterSize,
    budgetPerTeam: league.budgetPerTeam,
    minBid: league.minBid,
  };
}
