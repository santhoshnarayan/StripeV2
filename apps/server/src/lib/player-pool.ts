import { access, readFile } from "node:fs/promises";
import path from "node:path";

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

export function getDefaultBidFromSuggestedValue(suggestedValue: number) {
  return Math.max(1, Math.floor(suggestedValue * 0.5));
}
