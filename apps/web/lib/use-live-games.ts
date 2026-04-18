"use client";

import { useEffect, useRef, useState } from "react";
import { appApiFetch } from "@/lib/app-api";

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
const IDLE_TIMEOUT_MS = 3 * 60_000;

export function useLiveGames(): {
  games: TickerGame[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
} {
  const [games, setGames] = useState<TickerGame[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);

  const fetchNow = useRef(async () => {
    try {
      const res = await appApiFetch<{ games: TickerGame[] }>("/nba/live-ticker");
      if (cancelledRef.current) return;
      setGames(res.games ?? []);
      setError(null);
    } catch (err) {
      if (cancelledRef.current) return;
      setError((err as Error).message);
    } finally {
      if (!cancelledRef.current) setIsLoading(false);
    }
  });

  useEffect(() => {
    cancelledRef.current = false;

    const bump = () => {
      lastActivityRef.current = Date.now();
    };
    window.addEventListener("pointermove", bump, { passive: true });
    window.addEventListener("keydown", bump);
    window.addEventListener("touchstart", bump, { passive: true });
    const onVisible = () => {
      if (!document.hidden) {
        bump();
        void fetchNow.current();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    const schedule = () => {
      if (cancelledRef.current) return;
      const hasLive = games.some((g) => g.status === "in");
      const isIdle = Date.now() - lastActivityRef.current > IDLE_TIMEOUT_MS;
      const delay = hasLive && !isIdle ? ACTIVE_POLL_MS : IDLE_POLL_MS;
      timerRef.current = setTimeout(async () => {
        if (document.hidden) {
          schedule();
          return;
        }
        await fetchNow.current();
        schedule();
      }, delay);
    };

    void fetchNow.current().then(schedule);

    return () => {
      cancelledRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      window.removeEventListener("pointermove", bump);
      window.removeEventListener("keydown", bump);
      window.removeEventListener("touchstart", bump);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // We deliberately re-schedule only on mount; reschedule logic reads games via closure every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    games,
    isLoading,
    error,
    refetch: () => void fetchNow.current(),
  };
}
