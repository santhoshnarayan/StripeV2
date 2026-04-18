"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { PlayerHeadshot, TeamLogo } from "@/components/sim/player-avatar";
import { useLiveGames, type TickerGame } from "@/lib/use-live-games";
import { cn } from "@/lib/utils";
import type { RosteredPlayerInfo } from "@/components/nba/game-detail";

export type TickerRoster = {
  userId: string;
  name: string;
  players: Array<{
    playerId: string;
    playerName: string;
    playerTeam: string;
  }>;
};

type RosteredGamePlayer = {
  playerId: string;
  playerName: string;
  playerTeam: string;
  livePoints: number;
  managerShortName: string;
};

/** Short player name: "F. Last" */
function shortPlayerName(displayName: string): string {
  const parts = displayName.split(/\s+/);
  if (parts.length < 2) return displayName;
  return `${parts[0][0]}. ${parts.slice(1).join(" ")}`;
}

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

function RosterRotator({ players }: { players: RosteredGamePlayer[] }) {
  const [idx, setIdx] = useState(0);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (players.length <= 1) return;
    const t = setInterval(() => {
      setFading(true);
      setTimeout(() => {
        setIdx((i) => (i + 1) % players.length);
        setFading(false);
      }, 200);
    }, 4000);
    return () => clearInterval(t);
  }, [players.length]);

  if (players.length === 0) return null;
  const p = players[idx % players.length];

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 transition-opacity duration-200 min-w-0 leading-none",
        fading ? "opacity-0" : "opacity-100",
      )}
    >
      <PlayerHeadshot espnId={p.playerId} size={16} />
      <span className="text-[10px] truncate flex-1 min-w-0 leading-none">
        <span className="font-medium text-foreground/80">{shortPlayerName(p.playerName)}</span>
        <span className="text-muted-foreground/70 tabular-nums"> {Math.round(p.livePoints)}pts</span>
      </span>
      <span className="text-[10px] text-muted-foreground/60 truncate shrink-0 leading-none">
        {p.managerShortName}
      </span>
    </div>
  );
}

function GameCard({
  game,
  rosteredGamePlayers,
}: {
  game: TickerGame;
  rosteredGamePlayers?: RosteredGamePlayer[];
}) {
  const isLive = game.status === "in";
  const isFinal = game.status === "post";
  const isPre = game.status === "pre";
  const homeWin = game.homeScore > game.awayScore;
  const awayWin = game.awayScore > game.homeScore;
  const clock = formatClock(game);

  return (
    <Link
      href={`/games/${encodeURIComponent(game.id)}`}
      className={cn(
        "shrink-0 rounded-lg border px-3 py-2 w-[170px] flex flex-col gap-1 text-left transition-colors",
        isLive && "border-red-500/60 bg-red-500/5 hover:bg-red-500/10",
        isFinal && "bg-muted/40 border-border/60 hover:bg-muted/60",
        isPre && "border-border hover:bg-muted/30",
      )}
    >
      <div className="flex items-center justify-between gap-2 text-[10px]">
        <span className="text-muted-foreground font-medium truncate">
          {[
            game.gameNum ? `G${game.gameNum}` : null,
            game.broadcast,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {isLive ? (
          <span className="text-red-500 font-semibold tabular-nums shrink-0">{clock}</span>
        ) : (
          <span className="text-muted-foreground font-medium shrink-0">{clock}</span>
        )}
      </div>

      <TeamRow
        team={game.awayTeam}
        seed={game.awaySeed}
        score={game.awayScore}
        isPre={isPre}
        isWinning={awayWin}
        isLosing={isFinal && homeWin}
      />
      <TeamRow
        team={game.homeTeam}
        seed={game.homeSeed}
        score={game.homeScore}
        isPre={isPre}
        isWinning={homeWin}
        isLosing={isFinal && awayWin}
      />

      {rosteredGamePlayers && rosteredGamePlayers.length > 0 ? (
        <div className="pt-1 border-t border-border/30 -mx-1 px-1">
          <RosterRotator players={rosteredGamePlayers} />
        </div>
      ) : null}
    </Link>
  );
}

function TeamRow({
  team,
  seed,
  score,
  isPre,
  isWinning,
  isLosing,
}: {
  team: string;
  seed: number | null;
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
        {seed != null ? (
          <span className="text-muted-foreground/70 font-normal mr-1">({seed})</span>
        ) : null}
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
  leagueId: _leagueId,
  rosters,
  livePoints,
}: {
  rosteredPlayers?: Map<string, RosteredPlayerInfo>;
  leagueId?: string;
  rosters?: TickerRoster[];
  livePoints?: Record<string, number>;
} = {}) {
  const { games } = useLiveGames();

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

  // Index rostered players by NBA team abbrev so we can quickly find the set
  // of rostered players involved in a given game.
  const playersByTeam = useMemo(() => {
    const map = new Map<string, RosteredGamePlayer[]>();
    if (!rosters || rosters.length === 0) return map;
    for (const roster of rosters) {
      const managerShortName =
        rosteredPlayers && roster.players[0]
          ? rosteredPlayers.get(roster.players[0].playerId)?.managerShortName ?? roster.name
          : roster.name;
      for (const p of roster.players) {
        const team = p.playerTeam;
        if (!team) continue;
        // Prefer the canonical manager short name from the shared map when available.
        const shortName =
          rosteredPlayers?.get(p.playerId)?.managerShortName ?? managerShortName;
        const entry: RosteredGamePlayer = {
          playerId: p.playerId,
          playerName: p.playerName,
          playerTeam: team,
          livePoints: livePoints?.[p.playerId] ?? 0,
          managerShortName: shortName,
        };
        const arr = map.get(team);
        if (arr) arr.push(entry);
        else map.set(team, [entry]);
      }
    }
    return map;
  }, [rosters, livePoints, rosteredPlayers]);

  if (sorted.length === 0) return null;

  return (
    <div className="overflow-x-auto no-scrollbar -mx-4 px-4 md:-mx-0 md:px-0">
      <div className="flex gap-2">
        {sorted.map((g) => {
          const home = playersByTeam.get(g.homeTeam) ?? [];
          const away = playersByTeam.get(g.awayTeam) ?? [];
          // Sort by points desc so the highest-scoring rostered player shows first.
          const gamePlayers = [...home, ...away].sort(
            (a, b) => b.livePoints - a.livePoints,
          );
          return (
            <GameCard key={g.id} game={g} rosteredGamePlayers={gamePlayers} />
          );
        })}
      </div>
    </div>
  );
}
