"use client";

import { useEffect, useRef, useState } from "react";
import { appApiFetch } from "@/lib/app-api";
import { usePolling } from "@/lib/use-polling";

export type TickerGame = {
  id: string;
  date: string;
  startTime: string | null;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  status: "pre" | "in" | "post";
  period: number | null;
  displayClock: string | null;
  broadcast: string | null;
  seriesKey: string | null;
  gameNum: number | null;
};

const ACTIVE_POLL_MS = 120_000;
const IDLE_POLL_MS = 600_000;

export function useLiveGames(): {
  games: TickerGame[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
} {
  const [games, setGames] = useState<TickerGame[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const gamesRef = useRef<TickerGame[]>([]);

  const fetchNow = async () => {
    try {
      const res = await appApiFetch<{ games: TickerGame[] }>("/nba/live-ticker");
      if (cancelledRef.current) return;
      setGames(res.games ?? []);
      gamesRef.current = res.games ?? [];
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

  // Dynamic pace: faster while any game is in-progress, slower otherwise.
  const hasLive = games.some((g) => g.status === "in");
  usePolling(() => fetchNowRef.current(), {
    activeMs: hasLive ? ACTIVE_POLL_MS : IDLE_POLL_MS,
  });

  return {
    games,
    isLoading,
    error,
    refetch: () => void fetchNowRef.current(),
  };
}
