"use client";

import { useMemo, useState } from "react";
import { TeamLogo } from "@/components/sim/player-avatar";
import { useLiveGames, type TickerGame } from "@/lib/use-live-games";
import { cn } from "@/lib/utils";
import { GameDetail, type RosteredPlayerInfo } from "@/components/nba/game-detail";

function formatClock(t: TickerGame): string {
  if (t.status === "in") {
    const q = t.period && t.period > 4 ? `OT${t.period - 4}` : `Q${t.period ?? 1}`;
    return t.displayClock ? `${q} ${t.displayClock}` : q;
  }
  if (t.status === "post") return "Final";
  if (t.startTime) {
    const d = new Date(t.startTime);
    const h = d.getHours();
    const m = d.getMinutes();
    const ampm = h >= 12 ? "p" : "a";
    const h12 = h % 12 || 12;
    return m === 0 ? `${h12}${ampm}` : `${h12}:${m.toString().padStart(2, "0")}${ampm}`;
  }
  return "";
}

function GameCard({ game, onClick }: { game: TickerGame; onClick?: () => void }) {
  const isLive = game.status === "in";
  const isFinal = game.status === "post";
  const isPre = game.status === "pre";
  const homeWin = game.homeScore > game.awayScore;
  const awayWin = game.awayScore > game.homeScore;
  const clock = formatClock(game);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "shrink-0 rounded-lg border px-3 py-2 w-[170px] flex flex-col gap-1 text-left transition-colors",
        isLive && "border-red-500/60 bg-red-500/5 hover:bg-red-500/10",
        isFinal && "bg-muted/40 border-border/60 hover:bg-muted/60",
        isPre && "border-border hover:bg-muted/30",
      )}
    >
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-muted-foreground font-medium">
          {game.seriesKey ? `${game.seriesKey.split(".").slice(-1)[0]}${game.gameNum ? ` · G${game.gameNum}` : ""}` : ""}
        </span>
        {isLive ? (
          <span className="text-red-500 font-semibold tabular-nums">{clock}</span>
        ) : (
          <span className="text-muted-foreground font-medium">{clock}</span>
        )}
      </div>

      <TeamRow team={game.awayTeam} score={game.awayScore} isPre={isPre} isWinning={awayWin} isLosing={isFinal && homeWin} />
      <TeamRow team={game.homeTeam} score={game.homeScore} isPre={isPre} isWinning={homeWin} isLosing={isFinal && awayWin} />

      {game.broadcast ? (
        <div className="text-[9px] text-muted-foreground/60 truncate">{game.broadcast}</div>
      ) : null}
    </button>
  );
}

function TeamRow({
  team,
  score,
  isPre,
  isWinning,
  isLosing,
}: {
  team: string;
  score: number;
  isPre: boolean;
  isWinning: boolean;
  isLosing: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <TeamLogo team={team} size={16} />
      <span
        className={cn(
          "text-xs truncate flex-1",
          isLosing && "text-muted-foreground",
          isWinning && "font-semibold",
        )}
      >
        {team}
      </span>
      {!isPre && (
        <span
          className={cn(
            "text-xs tabular-nums font-medium shrink-0",
            isLosing && "text-muted-foreground",
            isWinning && "font-bold",
          )}
        >
          {score}
        </span>
      )}
    </div>
  );
}

export function LiveGamesTicker({
  rosteredPlayers,
}: {
  rosteredPlayers?: Map<string, RosteredPlayerInfo>;
} = {}) {
  const { games } = useLiveGames();
  const [openEventId, setOpenEventId] = useState<string | null>(null);

  const sorted = useMemo(() => {
    const order = { in: 0, pre: 1, post: 2 } as const;
    return [...games].sort((a, b) => {
      const sa = order[a.status];
      const sb = order[b.status];
      if (sa !== sb) return sa - sb;
      const ta = a.startTime ? new Date(a.startTime).getTime() : 0;
      const tb = b.startTime ? new Date(b.startTime).getTime() : 0;
      return ta - tb;
    });
  }, [games]);

  if (sorted.length === 0) return null;

  return (
    <>
      <div className="overflow-x-auto no-scrollbar -mx-4 px-4 md:-mx-0 md:px-0">
        <div className="flex gap-2">
          {sorted.map((g) => (
            <GameCard key={g.id} game={g} onClick={() => setOpenEventId(g.id)} />
          ))}
        </div>
      </div>
      {openEventId ? (
        <GameDetail
          eventId={openEventId}
          onClose={() => setOpenEventId(null)}
          rosteredPlayers={rosteredPlayers}
        />
      ) : null}
    </>
  );
}
