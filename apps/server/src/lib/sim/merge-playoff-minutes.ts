import { readFile } from "node:fs/promises";
import path from "node:path";

/** Per-game actuals file emitted by `build-playoff-minutes-actual.ts`.
 *  Shape: team → nba_id → availIdx (stringified) → minutes. The engine folds
 *  actuals from slots < G into sim(G)'s minute blend at prepare time. */
export type ActualsByGame = Record<string, Record<string, Record<string, number>>>;

/** Load the per-game actuals JSON if present; return {} if the file doesn't
 *  exist yet (first run, CI env without the script having been executed). */
export async function loadActualsByGame(dataDir: string): Promise<ActualsByGame> {
  const p = path.join(dataDir, "nba-playoff-minutes-actual-2026.json");
  try {
    const raw = await readFile(p, "utf8");
    return JSON.parse(raw) as ActualsByGame;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    throw e;
  }
}
