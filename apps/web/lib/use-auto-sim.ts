"use client";

import { useEffect, useRef, useState } from "react";
import { appApiFetch } from "@/lib/app-api";
import {
  DEFAULT_SIM_CONFIG,
  getCachedSimResults,
  runTournamentSim,
  setCachedSimResults,
  type SimData,
  type SimResults,
} from "@/lib/sim";

type AutoSimState = {
  simResults: SimResults | null;
  status: "idle" | "loading" | "running" | "ready" | "error";
};

// Shared across components so a second caller (e.g. Standings mounts while
// Simulator tab is already running a sim) doesn't kick off a duplicate.
const inflight = new Map<string, Promise<SimResults>>();

async function loadAndRun(cacheKey: string, leagueId: string): Promise<SimResults> {
  void leagueId; // reserved for future per-league endpoints
  const [data, live] = await Promise.all([
    appApiFetch<SimData>(`/sim-data?v=${Date.now()}`),
    appApiFetch<{ games: SimData["liveGames"] }>(`/nba/sim-live-games`).catch(
      () => ({ games: [] }),
    ),
  ]);
  const merged: SimData = { ...data, liveGames: live.games };
  const results = await runTournamentSim(
    { ...merged, adjustments: merged.adjustments ?? [] },
    DEFAULT_SIM_CONFIG,
  );
  setCachedSimResults(cacheKey, results);
  return results;
}

/** Returns the cached sim for the league; auto-triggers a run on first mount
 *  if the cache is cold so surfaces like Standings can show Win % without the
 *  user having to visit the Simulator tab first. */
export function useAutoSim(leagueId: string): AutoSimState {
  const cacheKey = `league:${leagueId}`;
  const [state, setState] = useState<AutoSimState>(() => {
    const cached = getCachedSimResults(cacheKey);
    return cached
      ? { simResults: cached, status: "ready" }
      : { simResults: null, status: "idle" };
  });
  const triggeredRef = useRef(false);

  useEffect(() => {
    if (triggeredRef.current) return;
    triggeredRef.current = true;
    const cached = getCachedSimResults(cacheKey);
    if (cached) {
      setState({ simResults: cached, status: "ready" });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, status: "loading" }));
    let p = inflight.get(cacheKey);
    if (!p) {
      p = loadAndRun(cacheKey, leagueId);
      inflight.set(cacheKey, p);
      p.finally(() => {
        if (inflight.get(cacheKey) === p) inflight.delete(cacheKey);
      });
    }
    setState((s) => ({ ...s, status: "running" }));
    p.then((results) => {
      if (cancelled) return;
      setState({ simResults: results, status: "ready" });
    }).catch(() => {
      if (cancelled) return;
      setState({ simResults: null, status: "error" });
    });
    return () => {
      cancelled = true;
    };
  }, [cacheKey, leagueId]);

  return state;
}
