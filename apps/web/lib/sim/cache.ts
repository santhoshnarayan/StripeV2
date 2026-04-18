import type { LiveGameState, SimResults } from "./types";

/**
 * Module-level cache for simulation results keyed by context ID
 * (league ID or "global" for the /bracket page). Persists across
 * React re-renders and tab switches within a session.
 *
 * `liveFingerprint` captures the input state that would meaningfully
 * change the sim output — used by the auto-rerun loop to skip work
 * when live-game polling returns an unchanged snapshot.
 */
type CacheEntry = {
  results: SimResults;
  liveFingerprint: string;
};

const simCache = new Map<string, CacheEntry>();

export function getCachedSimResults(key: string): SimResults | null {
  return simCache.get(key)?.results ?? null;
}

export function getCachedEntry(key: string): CacheEntry | null {
  return simCache.get(key) ?? null;
}

export function setCachedSimResults(
  key: string,
  results: SimResults,
  liveFingerprint = "",
): void {
  simCache.set(key, { results, liveFingerprint });
}

export function clearCachedSimResults(key: string): void {
  simCache.delete(key);
}

// Fingerprint of live-game inputs. Two states with the same fingerprint produce
// the same sim output, so we can skip rerunning. Quantize remainingFraction to
// 20ths so a clock tick within the same ~minute doesn't cause churn.
export function liveGamesFingerprint(games: LiveGameState[] | undefined): string {
  if (!games || games.length === 0) return "none";
  const parts = games
    .map((g) => {
      const frac = Math.round(g.remainingFraction * 20);
      const sumPts = Object.values(g.playerPoints ?? {}).reduce(
        (s, v) => s + (Number.isFinite(v) ? Math.round(v) : 0),
        0,
      );
      return `${g.seriesKey}:${g.gameNum}:${g.status}:${g.homeScore}-${g.awayScore}:${frac}:${sumPts}`;
    })
    .sort();
  return parts.join("|");
}
