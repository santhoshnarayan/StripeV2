"use client";

import { useEffect, useRef, useState } from "react";
import { appApiFetch } from "@/lib/app-api";
import { usePolling } from "@/lib/use-polling";
import {
  DEFAULT_SIM_CONFIG,
  getCachedEntry,
  liveGamesFingerprint,
  runTournamentSim,
  setCachedSimResults,
  type SimData,
  type SimResults,
} from "@/lib/sim";

type AutoSimState = {
  simResults: SimResults | null;
  status: "idle" | "loading" | "running" | "rerunning" | "ready" | "error";
  liveFingerprint: string;
};

// Shared across components so a second caller (e.g. Standings mounts while
// Simulator tab is already running a sim) doesn't kick off a duplicate.
const inflight = new Map<string, Promise<SimResults>>();

async function fetchSimInputs(): Promise<SimData> {
  const [data, live] = await Promise.all([
    appApiFetch<SimData>(`/sim-data?v=${Date.now()}`),
    appApiFetch<{ games: SimData["liveGames"] }>(`/nba/sim-live-games`).catch(
      () => ({ games: [] }),
    ),
  ]);
  return { ...data, liveGames: live.games };
}

async function loadAndRun(cacheKey: string): Promise<SimResults> {
  const merged = await fetchSimInputs();
  const fp = liveGamesFingerprint(merged.liveGames);
  const results = await runTournamentSim(
    { ...merged, adjustments: merged.adjustments ?? [] },
    DEFAULT_SIM_CONFIG,
  );
  setCachedSimResults(cacheKey, results, fp);
  return results;
}

// Quick fingerprint check: fetch live-games only, compare against cache, rerun
// full sim if changed. For true per-sim incremental (NCAAM-style), we'd need to
// diff per-series outcomes and re-run only dirty sims — this is the fingerprint
// memoization variant, which skips reruns when nothing meaningfully changed.
async function loadLiveOnly(): Promise<SimData["liveGames"]> {
  try {
    const live = await appApiFetch<{ games: SimData["liveGames"] }>(
      `/nba/sim-live-games`,
    );
    return live.games;
  } catch {
    return [];
  }
}

const ACTIVE_POLL_MS = 120_000;
const IDLE_POLL_MS = 600_000;

/** Returns the cached sim for the league; auto-triggers a run on first mount
 *  if the cache is cold so surfaces like Standings can show Win % without the
 *  user having to visit the Simulator tab first.
 *
 *  Also polls the live-games endpoint and auto-reruns the sim when the live
 *  fingerprint changes (e.g., a game finalizes). Skipped when nothing changed. */
export function useAutoSim(leagueId: string): AutoSimState {
  const cacheKey = `league:${leagueId}`;
  const [state, setState] = useState<AutoSimState>(() => {
    const entry = getCachedEntry(cacheKey);
    return entry
      ? {
          simResults: entry.results,
          status: "ready",
          liveFingerprint: entry.liveFingerprint,
        }
      : { simResults: null, status: "idle", liveFingerprint: "" };
  });
  const triggeredRef = useRef(false);

  useEffect(() => {
    if (triggeredRef.current) return;
    triggeredRef.current = true;
    const entry = getCachedEntry(cacheKey);
    if (entry) {
      setState({
        simResults: entry.results,
        status: "ready",
        liveFingerprint: entry.liveFingerprint,
      });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, status: "loading" }));
    let p = inflight.get(cacheKey);
    if (!p) {
      p = loadAndRun(cacheKey);
      inflight.set(cacheKey, p);
      p.finally(() => {
        if (inflight.get(cacheKey) === p) inflight.delete(cacheKey);
      });
    }
    setState((s) => ({ ...s, status: "running" }));
    p.then((results) => {
      if (cancelled) return;
      const entry2 = getCachedEntry(cacheKey);
      setState({
        simResults: results,
        status: "ready",
        liveFingerprint: entry2?.liveFingerprint ?? "",
      });
    }).catch(() => {
      if (cancelled) return;
      setState({ simResults: null, status: "error", liveFingerprint: "" });
    });
    return () => {
      cancelled = true;
    };
  }, [cacheKey]);

  // Poll live games; if fingerprint changed from the cached one, rerun.
  const hasLive = Boolean(
    state.simResults && state.liveFingerprint && state.liveFingerprint !== "none",
  );
  usePolling(
    async () => {
      if (state.status === "running" || state.status === "rerunning") return;
      const games = await loadLiveOnly();
      const newFp = liveGamesFingerprint(games);
      if (newFp === state.liveFingerprint) return;
      let p = inflight.get(cacheKey);
      if (!p) {
        p = loadAndRun(cacheKey);
        inflight.set(cacheKey, p);
        p.finally(() => {
          if (inflight.get(cacheKey) === p) inflight.delete(cacheKey);
        });
      }
      setState((s) => ({ ...s, status: "rerunning" }));
      try {
        const results = await p;
        const entry2 = getCachedEntry(cacheKey);
        setState({
          simResults: results,
          status: "ready",
          liveFingerprint: entry2?.liveFingerprint ?? newFp,
        });
      } catch {
        setState((s) => ({ ...s, status: "error" }));
      }
    },
    { activeMs: hasLive ? ACTIVE_POLL_MS : IDLE_POLL_MS },
  );

  return state;
}
