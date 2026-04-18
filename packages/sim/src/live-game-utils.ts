import type { LiveGameState } from "./types";

/** NBA regulation length in minutes. */
export const NBA_REGULATION_MIN = 48;

/** Group live games by seriesKey. */
export function buildLiveGameMap(liveGames: LiveGameState[] | undefined): Map<string, LiveGameState[]> {
  const m = new Map<string, LiveGameState[]>();
  if (!liveGames) return m;
  for (const g of liveGames) {
    if (!g.seriesKey) continue;
    const arr = m.get(g.seriesKey) ?? [];
    arr.push(g);
    m.set(g.seriesKey, arr);
  }
  for (const arr of m.values()) {
    arr.sort((a, b) => a.gameNum - b.gameNum);
  }
  return m;
}

/** Remaining fraction from period/clock. Period 1-4, plus OTs. */
export function computeRemainingFraction(
  status: "pre" | "in" | "post",
  period: number | null | undefined,
  displayClock: string | null | undefined,
): number {
  if (status === "post") return 0;
  if (status === "pre") return 1;
  if (period == null) return 1;

  // Clock format "MM:SS" or "M:SS.T"
  let secondsLeft = 0;
  if (displayClock) {
    const [mm, ss] = displayClock.split(":");
    const m = Number.parseInt(mm ?? "0", 10) || 0;
    const s = Number.parseFloat(ss ?? "0") || 0;
    secondsLeft = m * 60 + s;
  }

  // Each regulation quarter = 12 min = 720 s.
  if (period <= 4) {
    const remainingQuarters = 4 - period;
    const remainingSeconds = remainingQuarters * 720 + secondsLeft;
    return Math.max(0, Math.min(1, remainingSeconds / (NBA_REGULATION_MIN * 60)));
  }
  // In OT — treat as ~minimal remaining fraction (5min OT / 48min reg)
  return Math.max(0, Math.min(0.15, secondsLeft / (NBA_REGULATION_MIN * 60)));
}

/** Series keys are of the form "r1.east.1v8", "r2.west.2v3", "cf.east", "finals". */
export function roundIdxFromSeriesKey(seriesKey: string): number {
  if (seriesKey.startsWith("r1")) return 0;
  if (seriesKey.startsWith("r2")) return 1;
  if (seriesKey.startsWith("cf")) return 2;
  if (seriesKey.startsWith("finals")) return 3;
  return -1;
}
