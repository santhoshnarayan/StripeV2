"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PlayerHeadshot, TeamLogo } from "@/components/sim/player-avatar";
import { useLiveGames, type TickerGame, type TickerLeaders } from "@/lib/use-live-games";
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

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function formatClock(t: TickerGame): string {
  if (t.status === "in") {
    const q = t.period && t.period > 4 ? `OT${t.period - 4}` : `Q${t.period ?? 1}`;
    return t.displayClock ? `${q} ${t.displayClock}` : q;
  }
  if (t.status === "post") return "Final";
  if (t.startTime) {
    const d = new Date(t.startTime);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    const h = d.getHours();
    const m = d.getMinutes();
    const ampm = h >= 12 ? "p" : "a";
    const h12 = h % 12 || 12;
    const time = m === 0 ? `${h12}${ampm}` : `${h12}:${m.toString().padStart(2, "0")}${ampm}`;
    return sameDay ? time : `${WEEKDAY_SHORT[d.getDay()]} ${time}`;
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

function LeadersPanel({
  game,
  anchor,
  playerToManager,
  rosteredByTeam,
}: {
  game: TickerGame;
  anchor: DOMRect;
  playerToManager: Map<string, { name: string; playerName: string }>;
  rosteredByTeam: Map<string, Array<{ playerId: string; playerName: string; managerShortName: string }>>;
}) {
  if (!game.leaders) return null;
  const isActual = game.leaders.source === "actual";
  const valueLabel = isActual ? "pts" : "ppg";
  // Position above the card if near viewport bottom, else below.
  const padding = 8;
  const panelWidth = 300;
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1024;
  const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 768;
  let left = anchor.left + anchor.width / 2 - panelWidth / 2;
  left = Math.max(padding, Math.min(viewportWidth - panelWidth - padding, left));
  // Rough heuristic: ~320px tall with two teams × up to ~8 rows each.
  const estHeight = 340;
  const spaceBelow = viewportHeight - anchor.bottom;
  const showAbove = spaceBelow < estHeight && anchor.top > estHeight;
  const style: React.CSSProperties = showAbove
    ? { left, bottom: viewportHeight - anchor.top + padding, width: panelWidth }
    : { left, top: anchor.bottom + padding, width: panelWidth };

  return createPortal(
    <div
      className="fixed z-50 rounded-lg border border-border bg-background shadow-lg p-3 text-sm"
      style={style}
    >
      <div className="flex items-center justify-between pb-1.5 mb-2 border-b border-border/50">
        <span className="font-semibold text-foreground">Key scorers</span>
        <span className="text-[11px] text-muted-foreground uppercase tracking-wider">
          {isActual ? "actual" : "projected"}
        </span>
      </div>
      <div className="flex flex-col gap-2.5">
        <LeadersTeamSection
          team={game.awayTeam}
          seed={game.awaySeed}
          leaders={game.leaders.away}
          valueLabel={valueLabel}
          playerToManager={playerToManager}
          rostered={rosteredByTeam.get(game.awayTeam) ?? []}
        />
        <LeadersTeamSection
          team={game.homeTeam}
          seed={game.homeSeed}
          leaders={game.leaders.home}
          valueLabel={valueLabel}
          playerToManager={playerToManager}
          rostered={rosteredByTeam.get(game.homeTeam) ?? []}
        />
      </div>
    </div>,
    document.body,
  );
}

function LeadersTeamSection({
  team,
  seed,
  leaders,
  valueLabel,
  playerToManager,
  rostered,
}: {
  team: string;
  seed: number | null;
  leaders: TickerLeaders["home"];
  valueLabel: string;
  playerToManager: Map<string, { name: string; playerName: string }>;
  rostered: Array<{ playerId: string; playerName: string; managerShortName: string }>;
}) {
  const rosteredIds = new Set(rostered.map((r) => r.playerId));
  const byId = new Map<string, { playerId: string; playerName: string; value: number }>();
  for (const p of leaders) {
    if (rosteredIds.has(p.playerId)) byId.set(p.playerId, p);
  }
  for (const r of rostered) {
    if (!byId.has(r.playerId)) {
      byId.set(r.playerId, { playerId: r.playerId, playerName: r.playerName, value: 0 });
    }
  }
  const rows = Array.from(byId.values()).sort((a, b) => b.value - a.value);

  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <div className="flex items-center gap-1.5 pb-1 border-b border-border/30">
        <TeamLogo team={team} size={16} />
        <span className="text-xs font-semibold truncate">
          {seed != null ? (
            <span className="text-muted-foreground/70 font-normal mr-0.5">({seed})</span>
          ) : null}
          {team}
        </span>
      </div>
      {rows.length === 0 ? (
        <span className="text-[11px] text-muted-foreground italic py-0.5">—</span>
      ) : (
        rows.map((p) => {
          const mgr = playerToManager.get(p.playerId);
          return (
            <div
              key={p.playerId}
              className={cn(
                "grid grid-cols-[18px_1fr_auto_72px] items-center gap-1.5 min-w-0 py-0.5",
                mgr && "font-medium",
              )}
            >
              <PlayerHeadshot espnId={p.playerId} size={18} />
              <span className="text-[11px] truncate">{shortPlayerName(p.playerName)}</span>
              <span className="text-[11px] tabular-nums shrink-0 text-right">
                {valueLabel === "ppg" ? p.value.toFixed(1) : Math.round(p.value)}
              </span>
              <span className="text-[11px] truncate text-right text-muted-foreground">
                {mgr?.name ?? ""}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}

function GameCard({
  game,
  rosteredGamePlayers,
  playerToManager,
  rosteredByTeam,
}: {
  game: TickerGame;
  rosteredGamePlayers?: RosteredGamePlayer[];
  playerToManager: Map<string, { name: string; playerName: string }>;
  rosteredByTeam: Map<string, Array<{ playerId: string; playerName: string; managerShortName: string }>>;
}) {
  const isLive = game.status === "in";
  const isFinal = game.status === "post";
  const isPre = game.status === "pre";
  const homeWin = game.homeScore > game.awayScore;
  const awayWin = game.awayScore > game.homeScore;
  const clock = formatClock(game);

  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const cardRef = useRef<HTMLAnchorElement | null>(null);

  const handleEnter = () => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(hover: none)").matches) return;
    if (cardRef.current) setHoverRect(cardRef.current.getBoundingClientRect());
  };
  const handleLeave = () => setHoverRect(null);

  return (
    <>
      <Link
        ref={cardRef}
        href={`/games/${encodeURIComponent(game.id)}`}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        onFocus={handleEnter}
        onBlur={handleLeave}
        className={cn(
          "shrink-0 rounded-lg border px-3 py-2 w-[170px] flex flex-col gap-1 text-left transition-colors",
          isLive && "border-red-500/60 bg-red-500/5 hover:bg-red-500/10",
          isFinal && "bg-muted/40 border-border/60 hover:bg-muted/60",
          isPre && "border-border hover:bg-muted/30",
        )}
      >
        <div className="flex items-center justify-between gap-2 text-[10px]">
          <span className="text-muted-foreground font-medium truncate">
            {[game.gameNum ? `G${game.gameNum}` : null, game.broadcast]
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
      {hoverRect && game.leaders ? (
        <LeadersPanel
          game={game}
          anchor={hoverRect}
          playerToManager={playerToManager}
          rosteredByTeam={rosteredByTeam}
        />
      ) : null}
    </>
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

function roundIdxFromSeriesKey(seriesKey: string): number {
  if (seriesKey.startsWith("r1")) return 0;
  if (seriesKey.startsWith("r2")) return 1;
  if (seriesKey.startsWith("cf")) return 2;
  if (seriesKey.startsWith("finals")) return 3;
  return -1;
}

export type SimPlayerProjection = {
  byGamePts: number[];
  byGameProb: number[];
  avgPpg: number;
};

export function LiveGamesTicker({
  rosteredPlayers,
  leagueId: _leagueId,
  rosters,
  livePoints,
  simPlayerProjections,
}: {
  rosteredPlayers?: Map<string, RosteredPlayerInfo>;
  leagueId?: string;
  rosters?: TickerRoster[];
  livePoints?: Record<string, number>;
  /** playerId → per-game sim projection arrays. For upcoming ("pre") games we
   *  derive the conditional expected fantasy points for that specific game
   *  (seriesKey + gameNum → sim index = round*7 + gameNum) instead of an
   *  average PPG across the remaining season. */
  simPlayerProjections?: Record<string, SimPlayerProjection>;
} = {}) {
  const { games } = useLiveGames();

  const gamesWithSimProjection = useMemo(() => {
    if (!simPlayerProjections) return games;
    return games.map((g) => {
      if (g.status !== "pre" || !g.leaders || g.leaders.source !== "projected") {
        return g;
      }
      if (!g.seriesKey || g.gameNum == null) return g;
      const roundIdx = roundIdxFromSeriesKey(g.seriesKey);
      if (roundIdx < 0) return g;
      const gameIdx = roundIdx * 7 + g.gameNum;
      const override = (
        list: TickerLeaders["home"],
      ): TickerLeaders["home"] =>
        list
          .map((p) => {
            const proj = simPlayerProjections[p.playerId];
            if (!proj) return p;
            const pts = proj.byGamePts[gameIdx] ?? 0;
            const prob = proj.byGameProb[gameIdx] ?? 0;
            const perGame = prob > 0 ? pts / prob : proj.avgPpg;
            return { ...p, value: perGame };
          })
          .sort((a, b) => b.value - a.value);
      return {
        ...g,
        leaders: {
          ...g.leaders,
          home: override(g.leaders.home),
          away: override(g.leaders.away),
        },
      };
    });
  }, [games, simPlayerProjections]);

  const sorted = useMemo(() => {
    const order = { in: 0, pre: 1, post: 2 } as const;
    return [...gamesWithSimProjection].sort((a, b) => {
      const sa = order[a.status];
      const sb = order[b.status];
      if (sa !== sb) return sa - sb;
      const ta = a.startTime ? new Date(a.startTime).getTime() : 0;
      const tb = b.startTime ? new Date(b.startTime).getTime() : 0;
      return ta - tb;
    });
  }, [gamesWithSimProjection]);

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

  // playerId → manager short name, for tagging rostered players in the hover panel.
  const playerToManager = useMemo(() => {
    const map = new Map<string, { name: string; playerName: string }>();
    for (const [, arr] of playersByTeam) {
      for (const p of arr) {
        map.set(p.playerId, { name: p.managerShortName, playerName: p.playerName });
      }
    }
    return map;
  }, [playersByTeam]);

  // team abbrev → array of rostered players (for the hover panel to surface
  // drafted bench players who may not be in the top-scorer list).
  const rosteredByTeam = useMemo(() => {
    const map = new Map<
      string,
      Array<{ playerId: string; playerName: string; managerShortName: string }>
    >();
    for (const [team, arr] of playersByTeam) {
      map.set(
        team,
        arr.map((p) => ({
          playerId: p.playerId,
          playerName: p.playerName,
          managerShortName: p.managerShortName,
        })),
      );
    }
    return map;
  }, [playersByTeam]);

  if (sorted.length === 0) return null;

  return (
    <div className="overflow-x-auto no-scrollbar -mx-4 px-4 md:-mx-0 md:px-0">
      <div className="flex gap-2">
        {sorted.map((g) => {
          const home = playersByTeam.get(g.homeTeam) ?? [];
          const away = playersByTeam.get(g.awayTeam) ?? [];
          // Override carousel points with per-game points from the leaders
          // feed so each card shows only what was scored in that specific
          // game, not the career total. Projected leaders are ppg, so only
          // apply when leaders.source is "actual".
          const perGame = new Map<string, number>();
          if (g.leaders?.source === "actual") {
            for (const l of g.leaders.home) perGame.set(l.playerId, l.value);
            for (const l of g.leaders.away) perGame.set(l.playerId, l.value);
          }
          const gamePlayers = [...home, ...away]
            .map((p) => ({ ...p, livePoints: perGame.get(p.playerId) ?? 0 }))
            .sort((a, b) => b.livePoints - a.livePoints);
          return (
            <GameCard
              key={g.id}
              game={g}
              rosteredGamePlayers={gamePlayers}
              playerToManager={playerToManager}
              rosteredByTeam={rosteredByTeam}
            />
          );
        })}
      </div>
    </div>
  );
}
