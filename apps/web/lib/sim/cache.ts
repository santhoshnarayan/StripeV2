import type { SimResults } from "./types";

/**
 * Module-level cache for simulation results keyed by context ID
 * (league ID or "global" for the /bracket page). Persists across
 * React re-renders and tab switches within a session.
 */
const simCache = new Map<string, SimResults>();

export function getCachedSimResults(key: string): SimResults | null {
  return simCache.get(key) ?? null;
}

export function setCachedSimResults(key: string, results: SimResults): void {
  simCache.set(key, results);
}

export function clearCachedSimResults(key: string): void {
  simCache.delete(key);
}
