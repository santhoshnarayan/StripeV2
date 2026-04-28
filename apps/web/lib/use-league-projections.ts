"use client";

import { useCallback, useEffect, useState } from "react";
import { appApiFetch } from "@/lib/app-api";
import { usePolling } from "@/lib/use-polling";

export type InjuryUpdatePayload = {
  id: string;
  wallclock: string;
  gameId: string | null;
  updates: Record<
    string,
    {
      team: string;
      status: string;
      injury: string;
      availability: number[];
    } | null
  >;
  note: string | null;
};

export type ProjectionEvent = {
  gameId: string;
  sequence: number;
  updatedAtEvent: string;
  kind: "scoring" | "end_of_period" | "end_of_game" | "injury_update";
  actualPoints: Record<string, number>;
  projectedPoints: Record<
    string,
    { mean: number; stddev: number; p10: number; p90: number; winProb: number }
  >;
  eventMeta: {
    text: string | null;
    teamAbbrev: string | null;
    playerIds: string[];
    scoreValue: number | null;
    period: number | null;
    clock: string | null;
    homeScore: number | null;
    awayScore: number | null;
    wallclock: string | null;
    injuryUpdate?: InjuryUpdatePayload | null;
  };
  gamesSnapshot: Array<{
    seriesKey: string;
    gameNum: number;
    status: "pre" | "in" | "post";
    homeTeam: string;
    awayTeam: string;
    homeScore: number;
    awayScore: number;
  }> | null;
  simCount: number;
  computedAt: string;
};

export type ProjectionJobSummary = {
  id: string;
  status: string;
  totalEvents: number | null;
  processedEvents: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  createdAt: string;
};

export type ProjectionsResponse = {
  managers: Array<{ userId: string; name: string }>;
  events: ProjectionEvent[];
  latestJob: ProjectionJobSummary | null;
};

// Module-scoped cache keyed by leagueId. Survives component unmounts, so when
// a user switches between leagues (or flips from Overview → Chart → Overview)
// the previously fetched projections render instantly while a refresh runs in
// the background. Keyed by leagueId to stay correct when a user belongs to
// multiple leagues.
const cache = new Map<string, ProjectionsResponse>();

export function useLeagueProjections(leagueId: string) {
  const [projections, setProjections] = useState<ProjectionsResponse | null>(
    () => cache.get(leagueId) ?? null,
  );

  const refetch = useCallback(async () => {
    try {
      const p = await appApiFetch<ProjectionsResponse>(
        `/leagues/${encodeURIComponent(leagueId)}/projections-timeline`,
      );
      cache.set(leagueId, p);
      setProjections(p);
    } catch {
      // Soft-fail: chart panel falls back to the schedule-derived view when
      // projections are null, so a transient error shouldn't break render.
    }
  }, [leagueId]);

  // Reset local state to whatever the cache has for this leagueId whenever
  // the id changes, then kick off a fresh fetch.
  useEffect(() => {
    setProjections(cache.get(leagueId) ?? null);
    void refetch();
  }, [leagueId, refetch]);

  usePolling(refetch, { activeMs: 15_000 });

  return { projections, refetch };
}
