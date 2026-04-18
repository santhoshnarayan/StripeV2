"use client";

import { useEffect, useRef, useState } from "react";
import { appApiFetch } from "@/lib/app-api";
import { usePolling } from "@/lib/use-polling";

export type ScheduleGame = {
  id: string;
  gameNum: number | null;
  date: string | null;
  status: "pre" | "in" | "post";
  homeScore: number | null;
  awayScore: number | null;
  homeTeam: string | null;
  awayTeam: string | null;
};

export type ScheduleResponse = {
  series: Record<string, ScheduleGame[]>;
};

/** Derived per-series state for a matchup. */
export type SeriesState = {
  /** "r1.east.1v8" → wins keyed by team abbrev. */
  wins: Record<string, number>;
  /** Game currently in-progress, if any. */
  liveGame: ScheduleGame | null;
  /** Next unplayed game (status "pre") for reference. */
  nextGame: ScheduleGame | null;
  /** Most-recently completed game. */
  lastFinal: ScheduleGame | null;
  /** Overall matchup state — whichever is most relevant to surface. */
  headline: "pre" | "in" | "post" | "idle";
};

const ACTIVE_POLL_MS = 120_000;
const IDLE_POLL_MS = 600_000;

export function computeSeriesState(games: ScheduleGame[]): SeriesState {
  const wins: Record<string, number> = {};
  let liveGame: ScheduleGame | null = null;
  let nextGame: ScheduleGame | null = null;
  let lastFinal: ScheduleGame | null = null;
  for (const g of games) {
    if (g.status === "post" && g.homeTeam && g.awayTeam && g.homeScore != null && g.awayScore != null) {
      const winner = g.homeScore > g.awayScore ? g.homeTeam : g.awayTeam;
      wins[winner] = (wins[winner] ?? 0) + 1;
      if (!lastFinal || (g.date ?? "") > (lastFinal.date ?? "")) lastFinal = g;
    }
    if (g.status === "in" && !liveGame) liveGame = g;
    if (g.status === "pre" && !nextGame) nextGame = g;
  }
  const headline: SeriesState["headline"] = liveGame
    ? "in"
    : nextGame
      ? "pre"
      : lastFinal
        ? "post"
        : "idle";
  return { wins, liveGame, nextGame, lastFinal, headline };
}

export function useBracketSchedule(): {
  schedule: Record<string, ScheduleGame[]>;
  isLoading: boolean;
  error: string | null;
} {
  const [schedule, setSchedule] = useState<Record<string, ScheduleGame[]>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const fetchNow = async () => {
    try {
      const res = await appApiFetch<ScheduleResponse>("/nba/schedule");
      if (cancelledRef.current) return;
      setSchedule(res.series ?? {});
      setError(null);
    } catch (err) {
      if (cancelledRef.current) return;
      setError((err as Error).message);
    } finally {
      if (!cancelledRef.current) setIsLoading(false);
    }
  };
  const fetchNowRef = useRef(fetchNow);
  fetchNowRef.current = fetchNow;

  useEffect(() => {
    cancelledRef.current = false;
    void fetchNowRef.current();
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const hasLive = Object.values(schedule).some((games) =>
    games.some((g) => g.status === "in"),
  );
  usePolling(() => fetchNowRef.current(), {
    activeMs: hasLive ? ACTIVE_POLL_MS : IDLE_POLL_MS,
  });

  return { schedule, isLoading, error };
}
