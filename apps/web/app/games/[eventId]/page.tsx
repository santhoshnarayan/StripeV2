"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useMemo, useState } from "react";
import { GameDetail } from "@/components/nba/game-detail";
import { appApiFetch } from "@/lib/app-api";
import { cn } from "@/lib/utils";

type ScoreboardGame = {
  id: string;
  homeTeamAbbrev: string;
  awayTeamAbbrev: string;
  startTime: string | null;
  date: string;
};

type ScoreboardResponse = {
  date: string;
  games: ScoreboardGame[];
};

type CurrentGameSummary = {
  id: string;
  homeTeamAbbrev: string;
  awayTeamAbbrev: string;
  startTime: string | null;
};

function toLocalDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatAdjacent(g: ScoreboardGame): string {
  const prefix = `${g.awayTeamAbbrev} at ${g.homeTeamAbbrev}`;
  if (!g.startTime) return prefix;
  const d = new Date(g.startTime);
  const md = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${prefix} · ${md}`;
}

function BackIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function ChevronLeft() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function PageHeaderBar({
  eventId,
  prev,
  next,
}: {
  eventId: string;
  prev: ScoreboardGame | null;
  next: ScoreboardGame | null;
}) {
  const router = useRouter();
  return (
    <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-border/60">
      <button
        type="button"
        onClick={() => router.back()}
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted"
        aria-label="Back"
      >
        <BackIcon />
        <span>Back</span>
      </button>
      <div className="flex items-center gap-1 min-w-0">
        {prev ? (
          <Link
            href={`/games/${encodeURIComponent(prev.id)}`}
            className="inline-flex items-center gap-1 max-w-[45vw] truncate rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted"
            title={formatAdjacent(prev)}
          >
            <ChevronLeft />
            <span className="truncate">{formatAdjacent(prev)}</span>
          </Link>
        ) : (
          <span className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-muted-foreground/40">
            <ChevronLeft />
          </span>
        )}
        {next ? (
          <Link
            href={`/games/${encodeURIComponent(next.id)}`}
            className="inline-flex items-center gap-1 max-w-[45vw] truncate rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted"
            title={formatAdjacent(next)}
          >
            <span className="truncate">{formatAdjacent(next)}</span>
            <ChevronRight />
          </Link>
        ) : (
          <span className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-muted-foreground/40">
            <ChevronRight />
          </span>
        )}
      </div>
    </div>
  );
}

export default function GamePage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = use(params);
  return <GamePageInner eventId={eventId} />;
}

function GamePageInner({ eventId }: { eventId: string }) {
  const [current, setCurrent] = useState<CurrentGameSummary | null>(null);
  const [sameDayGames, setSameDayGames] = useState<ScoreboardGame[]>([]);

  // Load the summary for the current game to know its date for prev/next lookup.
  useEffect(() => {
    let cancelled = false;
    setCurrent(null);
    setSameDayGames([]);
    appApiFetch<{ game: CurrentGameSummary }>(
      `/nba/games/${encodeURIComponent(eventId)}`,
    )
      .then((res) => {
        if (cancelled) return;
        setCurrent(res.game);
      })
      .catch(() => {
        /* handled by GameDetail */
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  // Load same-day scoreboard for prev/next siblings.
  useEffect(() => {
    if (!current?.startTime) return;
    let cancelled = false;
    const dateKey = toLocalDateKey(new Date(current.startTime));
    appApiFetch<ScoreboardResponse>(
      `/nba/scoreboard?date=${encodeURIComponent(dateKey)}`,
    )
      .then((res) => {
        if (cancelled) return;
        setSameDayGames(res.games ?? []);
      })
      .catch(() => {
        if (!cancelled) setSameDayGames([]);
      });
    return () => {
      cancelled = true;
    };
  }, [current?.startTime]);

  const { prev, next } = useMemo(() => {
    if (!current || sameDayGames.length === 0) {
      return { prev: null as ScoreboardGame | null, next: null as ScoreboardGame | null };
    }
    const sorted = [...sameDayGames].sort((a, b) => {
      const ta = a.startTime ? new Date(a.startTime).getTime() : 0;
      const tb = b.startTime ? new Date(b.startTime).getTime() : 0;
      return ta - tb;
    });
    const idx = sorted.findIndex((g) => g.id === current.id);
    if (idx < 0) return { prev: null, next: null };
    return {
      prev: idx > 0 ? sorted[idx - 1] : null,
      next: idx < sorted.length - 1 ? sorted[idx + 1] : null,
    };
  }, [current, sameDayGames]);

  return (
    <main
      className={cn(
        "mx-auto w-full max-w-3xl",
        "px-0 md:px-6 lg:px-8 py-0 md:py-6",
      )}
    >
      <div className="bg-background md:rounded-xl md:border md:border-border/60 md:shadow-sm overflow-hidden">
        <PageHeaderBar eventId={eventId} prev={prev} next={next} />
        <GameDetail eventId={eventId} variant="page" />
      </div>
    </main>
  );
}
