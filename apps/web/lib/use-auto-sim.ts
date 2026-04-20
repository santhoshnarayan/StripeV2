"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { appApiFetch } from "@/lib/app-api";
import { usePolling } from "@/lib/use-polling";
import {
  DEFAULT_SIM_CONFIG,
  getCachedEntry,
  liveGamesFingerprint,
  setCachedSimResults,
  type SimData,
  type SimResults,
} from "@/lib/sim";
import { runSimAuto } from "@/lib/sim/wasm-engine";

type AutoSimState = {
  simResults: SimResults | null;
  status: "idle" | "loading" | "running" | "rerunning" | "ready" | "error";
  liveFingerprint: string;
  /** # of live-game events observed and queued but not yet flushed into a rerun.
   *  UI can show a "pending update" badge when this is > 0. */
  pendingEvents: number;
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
  const input = { ...merged, adjustments: merged.adjustments ?? [] };
  const results = await runSimAuto(input, DEFAULT_SIM_CONFIG);
  setCachedSimResults(cacheKey, results, fp);
  return results;
}

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

/** Debounce config: wait this long after the last event before rerunning the
 *  sim, so bursty updates (multiple score changes in quick succession) collapse
 *  into one rerun. */
const DEBOUNCE_MS = 30_000;
/** Or flush immediately once the queue depth hits this many events, so we
 *  don't lag indefinitely if events keep arriving. */
const QUEUE_FLUSH_THRESHOLD = 5;

/** Returns the cached sim for the league; auto-triggers a run on first mount
 *  if the cache is cold so surfaces like Standings can show Win % without the
 *  user having to visit the Simulator tab first.
 *
 *  Also polls the live-games endpoint and auto-reruns the sim when the live
 *  fingerprint changes (e.g., a game finalizes). Reruns are debounced with an
 *  event queue so a burst of score changes collapses into one rerun; while a
 *  rerun is in flight, further events queue up and fire after completion. */
export function useAutoSim(leagueId: string): AutoSimState {
  const cacheKey = `league:${leagueId}`;
  const [state, setState] = useState<AutoSimState>(() => {
    const entry = getCachedEntry(cacheKey);
    return entry
      ? {
          simResults: entry.results,
          status: "ready",
          liveFingerprint: entry.liveFingerprint,
          pendingEvents: 0,
        }
      : { simResults: null, status: "idle", liveFingerprint: "", pendingEvents: 0 };
  });
  const triggeredRef = useRef(false);

  // Refs for the debouncer.
  const pendingCountRef = useRef(0);
  const pendingFpRef = useRef<string | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rerunningRef = useRef(false);

  const runRerun = useCallback(
    async (targetFp: string) => {
      rerunningRef.current = true;
      setState((s) => ({ ...s, status: "rerunning" }));
      let p = inflight.get(cacheKey);
      if (!p) {
        p = loadAndRun(cacheKey);
        inflight.set(cacheKey, p);
        p.finally(() => {
          if (inflight.get(cacheKey) === p) inflight.delete(cacheKey);
        });
      }
      try {
        const results = await p;
        const entry = getCachedEntry(cacheKey);
        setState((s) => ({
          ...s,
          simResults: results,
          status: "ready",
          liveFingerprint: entry?.liveFingerprint ?? targetFp,
          pendingEvents: pendingCountRef.current,
        }));
      } catch {
        setState((s) => ({ ...s, status: "error" }));
      } finally {
        rerunningRef.current = false;
      }

      // Drain: if new events arrived during the rerun, schedule another pass.
      if (pendingCountRef.current > 0 && pendingFpRef.current) {
        if (pendingCountRef.current >= QUEUE_FLUSH_THRESHOLD) {
          const fp = pendingFpRef.current;
          pendingCountRef.current = 0;
          pendingFpRef.current = null;
          setState((s) => ({ ...s, pendingEvents: 0 }));
          void runRerun(fp);
        } else {
          if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = setTimeout(() => {
            const fp = pendingFpRef.current;
            pendingCountRef.current = 0;
            pendingFpRef.current = null;
            setState((s) => ({ ...s, pendingEvents: 0 }));
            if (fp) void runRerun(fp);
          }, DEBOUNCE_MS);
        }
      }
    },
    [cacheKey],
  );

  useEffect(() => {
    if (triggeredRef.current) return;
    triggeredRef.current = true;
    const entry = getCachedEntry(cacheKey);
    if (entry) {
      setState({
        simResults: entry.results,
        status: "ready",
        liveFingerprint: entry.liveFingerprint,
        pendingEvents: 0,
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
        pendingEvents: 0,
      });
    }).catch(() => {
      if (cancelled) return;
      setState({ simResults: null, status: "error", liveFingerprint: "", pendingEvents: 0 });
    });
    return () => {
      cancelled = true;
    };
  }, [cacheKey]);

  // Poll live games; if fingerprint changed, enqueue an event. The debouncer
  // decides when to flush to a rerun.
  const hasLive = Boolean(
    state.simResults && state.liveFingerprint && state.liveFingerprint !== "none",
  );
  usePolling(
    async () => {
      const games = await loadLiveOnly();
      const newFp = liveGamesFingerprint(games);
      if (newFp === state.liveFingerprint && pendingFpRef.current === null) return;
      if (newFp === pendingFpRef.current) return; // unchanged since last enqueue

      pendingFpRef.current = newFp;
      pendingCountRef.current += 1;
      setState((s) => ({ ...s, pendingEvents: pendingCountRef.current }));

      // If a rerun is already in flight, just let it drain on completion.
      if (rerunningRef.current) return;
      if (state.status === "running" || state.status === "loading") return;

      // Flush threshold: fire immediately.
      if (pendingCountRef.current >= QUEUE_FLUSH_THRESHOLD) {
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        const fp = pendingFpRef.current;
        pendingCountRef.current = 0;
        pendingFpRef.current = null;
        setState((s) => ({ ...s, pendingEvents: 0 }));
        if (fp) void runRerun(fp);
        return;
      }

      // Otherwise debounce: reset the timer each time a new event arrives.
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        const fp = pendingFpRef.current;
        pendingCountRef.current = 0;
        pendingFpRef.current = null;
        setState((s) => ({ ...s, pendingEvents: 0 }));
        if (fp) void runRerun(fp);
      }, DEBOUNCE_MS);
    },
    { activeMs: hasLive ? ACTIVE_POLL_MS : IDLE_POLL_MS },
  );

  // Clean up pending timer on unmount.
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  return state;
}
