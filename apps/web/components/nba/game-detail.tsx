"use client";

import { useEffect, useRef, useState } from "react";
import { appApiFetch } from "@/lib/app-api";
import { cn } from "@/lib/utils";
import { TeamLogo } from "@/components/sim/player-avatar";
import { WinProbabilityChart, type WinProbPoint } from "@/components/nba/win-probability-chart";
import { usePolling } from "@/lib/use-polling";

type GameRow = {
  id: string;
  homeTeamAbbrev: string;
  awayTeamAbbrev: string;
  homeScore: number;
  awayScore: number;
  status: "pre" | "in" | "post";
  period: number | null;
  displayClock: string | null;
  startTime: string | null;
  venue: string | null;
  broadcast: string | null;
  seriesKey: string | null;
  gameNum: number | null;
};

type TeamStatsRow = {
  gameId: string;
  teamAbbrev: string;
  quarterScores: number[] | null;
  fgPct: number | null;
  fg3Pct: number | null;
  ftPct: number | null;
  reboundsTotal: number | null;
  assistsTotal: number | null;
  turnoversTotal: number | null;
  largestLead: number | null;
};

type PlayerStatsRow = {
  gameId: string;
  playerId: string;
  teamAbbrev: string;
  playerName: string;
  minutes: number | null;
  points: number;
  rebounds: number;
  assists: number;
  steals: number;
  blocks: number;
  turnovers: number;
  fgm: number;
  fga: number;
  fg3m: number;
  fg3a: number;
  ftm: number;
  fta: number;
  plusMinus: number | null;
  starter: boolean;
  dnp: boolean;
};

type PlayRow = {
  gameId: string;
  sequence: number;
  period: number | null;
  clock: string | null;
  scoringPlay: boolean;
  scoreValue: number | null;
  text: string | null;
  homeScore: number | null;
  awayScore: number | null;
  teamAbbrev: string | null;
};

type WinProbRow = {
  gameId: string;
  sequence: number;
  period: number | null;
  clock: string | null;
  homeWinPct: number | null;
  tiePct: number | null;
};

type GameDetailData = {
  game: GameRow;
  teamStats: TeamStatsRow[];
  playerStats: PlayerStatsRow[];
};

export type RosteredPlayerInfo = {
  managerName: string;
  managerShortName: string;
  managerUserId: string;
  viewerIsManager: boolean;
};

function formatStatus(g: GameRow): string {
  if (g.status === "in") {
    const q = g.period && g.period > 4 ? `OT${g.period - 4}` : `Q${g.period ?? 1}`;
    return g.displayClock ? `${q} · ${g.displayClock}` : q;
  }
  if (g.status === "post") return "Final";
  if (g.startTime) {
    const d = new Date(g.startTime);
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return "";
}

function TeamBox({
  team,
  opposing,
  players,
  rosteredPlayers,
}: {
  team: string;
  opposing: string;
  players: PlayerStatsRow[];
  rosteredPlayers?: Map<string, RosteredPlayerInfo>;
}) {
  const teamPlayers = players
    .filter((p) => p.teamAbbrev === team && !p.dnp)
    .sort((a, b) => (b.minutes ?? 0) - (a.minutes ?? 0));

  if (teamPlayers.length === 0) {
    return <div className="text-xs text-muted-foreground py-2">No stats yet</div>;
  }

  return (
    <div>
      <div className="flex items-center gap-2 pb-1">
        <TeamLogo team={team} size={16} />
        <span className="text-xs font-bold">{team}</span>
        <span className="text-[10px] text-muted-foreground">vs {opposing}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] tabular-nums">
          <thead className="text-muted-foreground/70">
            <tr>
              <th className="text-left font-medium py-1 pl-1 pr-2">Player</th>
              <th className="text-right font-medium px-1 py-1">MIN</th>
              <th className="text-right font-medium px-1 py-1">PTS</th>
              <th className="text-right font-medium px-1 py-1">REB</th>
              <th className="text-right font-medium px-1 py-1">AST</th>
              <th className="text-right font-medium px-1 py-1">FG</th>
              <th className="text-right font-medium px-1 py-1">3P</th>
              <th className="text-right font-medium px-1 py-1">STL</th>
              <th className="text-right font-medium px-1 py-1">BLK</th>
              <th className="text-right font-medium px-1 py-1">TO</th>
              <th className="text-right font-medium pl-1 pr-1 py-1">+/-</th>
            </tr>
          </thead>
          <tbody>
            {teamPlayers.map((p) => {
              const roster = rosteredPlayers?.get(p.playerId);
              const isViewerPlayer = roster?.viewerIsManager === true;
              return (
              <tr
                key={p.playerId}
                className={cn(
                  "border-t border-border/20",
                  roster && !isViewerPlayer && "bg-primary/5",
                  isViewerPlayer && "bg-primary/15",
                )}
              >
                <td className={cn("py-1 pl-1 pr-2", (p.starter || roster) && "font-semibold")}>
                  <span className="whitespace-nowrap">{p.playerName}</span>
                  {roster ? (
                    <span
                      className={cn(
                        "ml-2 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                        isViewerPlayer
                          ? "bg-primary/20 text-primary"
                          : "bg-muted text-muted-foreground",
                      )}
                      title={`Drafted by ${roster.managerName}`}
                    >
                      {roster.managerShortName}
                    </span>
                  ) : null}
                </td>
                <td className="text-right px-1 py-1 text-muted-foreground">
                  {p.minutes != null ? Math.round(p.minutes) : "-"}
                </td>
                <td className="text-right px-1 py-1 font-semibold">{p.points}</td>
                <td className="text-right px-1 py-1">{p.rebounds}</td>
                <td className="text-right px-1 py-1">{p.assists}</td>
                <td className="text-right px-1 py-1 text-muted-foreground">
                  {p.fgm}-{p.fga}
                </td>
                <td className="text-right px-1 py-1 text-muted-foreground">
                  {p.fg3m}-{p.fg3a}
                </td>
                <td className="text-right px-1 py-1">{p.steals}</td>
                <td className="text-right px-1 py-1">{p.blocks}</td>
                <td className="text-right px-1 py-1">{p.turnovers}</td>
                <td
                  className={cn(
                    "text-right pl-1 pr-1 py-1 tabular-nums",
                    p.plusMinus != null && p.plusMinus > 0 && "text-green-600 dark:text-green-400",
                    p.plusMinus != null && p.plusMinus < 0 && "text-red-600 dark:text-red-400",
                  )}
                >
                  {p.plusMinus ?? "-"}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TeamStatsPanel({ rows, home, away }: { rows: TeamStatsRow[]; home: string; away: string }) {
  const homeRow = rows.find((r) => r.teamAbbrev === home);
  const awayRow = rows.find((r) => r.teamAbbrev === away);
  if (!homeRow && !awayRow) return null;

  // ESPN returns the pct already scaled 0–100 (e.g. "63" for 63%), so don't multiply again.
  const fmtPct = (v: number | null | undefined) => (v == null ? "-" : `${v.toFixed(1)}%`);
  const row = (label: string, a: string | number, h: string | number) => (
    <div className="grid grid-cols-3 gap-2 text-xs py-1 border-t border-border/20">
      <span className="tabular-nums text-right">{a}</span>
      <span className="text-center text-muted-foreground">{label}</span>
      <span className="tabular-nums">{h}</span>
    </div>
  );

  return (
    <div className="rounded-lg border border-border/40 p-2 space-y-0">
      <div className="grid grid-cols-3 gap-2 text-xs font-bold pb-1">
        <span className="text-right">{away}</span>
        <span className="text-center text-muted-foreground font-medium">Team Stats</span>
        <span>{home}</span>
      </div>
      {row("FG%", fmtPct(awayRow?.fgPct), fmtPct(homeRow?.fgPct))}
      {row("3P%", fmtPct(awayRow?.fg3Pct), fmtPct(homeRow?.fg3Pct))}
      {row("FT%", fmtPct(awayRow?.ftPct), fmtPct(homeRow?.ftPct))}
      {row("REB", awayRow?.reboundsTotal ?? "-", homeRow?.reboundsTotal ?? "-")}
      {row("AST", awayRow?.assistsTotal ?? "-", homeRow?.assistsTotal ?? "-")}
      {row("TO", awayRow?.turnoversTotal ?? "-", homeRow?.turnoversTotal ?? "-")}
      {row("Largest lead", awayRow?.largestLead ?? "-", homeRow?.largestLead ?? "-")}
    </div>
  );
}

function PlayByPlay({ plays }: { plays: PlayRow[] }) {
  if (plays.length === 0) {
    return <div className="text-xs text-muted-foreground py-2">No plays yet</div>;
  }
  const recent = [...plays].reverse().slice(0, 80);
  return (
    <div className="text-xs space-y-1 max-h-96 overflow-y-auto">
      {recent.map((p) => (
        <div
          key={p.sequence}
          className={cn(
            "flex gap-2 py-1 border-b border-border/20",
            p.scoringPlay && "bg-primary/5",
          )}
        >
          <span className="text-muted-foreground tabular-nums w-10 shrink-0">
            Q{p.period}
          </span>
          <span className="text-muted-foreground tabular-nums w-12 shrink-0">{p.clock}</span>
          <span className="flex-1">{p.text}</span>
          {p.scoringPlay && (
            <span className="tabular-nums text-[10px] text-muted-foreground shrink-0">
              {p.awayScore}-{p.homeScore}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export function GameDetail({
  eventId,
  onClose,
  rosteredPlayers,
}: {
  eventId: string;
  onClose: () => void;
  rosteredPlayers?: Map<string, RosteredPlayerInfo>;
}) {
  const [data, setData] = useState<GameDetailData | null>(null);
  const [plays, setPlays] = useState<PlayRow[]>([]);
  const [winProb, setWinProb] = useState<WinProbPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"box" | "pbp" | "chart">("box");

  const cancelledRef = useRef(false);
  const loadRef = useRef(async () => {
    try {
      const [d, p, w] = await Promise.all([
        appApiFetch<GameDetailData>(`/nba/games/${encodeURIComponent(eventId)}`),
        appApiFetch<{ plays: PlayRow[] }>(`/nba/games/${encodeURIComponent(eventId)}/pbp`),
        appApiFetch<{ points: WinProbRow[] }>(`/nba/games/${encodeURIComponent(eventId)}/win-probability`),
      ]);
      if (cancelledRef.current) return;
      setData(d);
      setPlays(p.plays ?? []);
      setWinProb(
        (w.points ?? [])
          .filter((pt) => pt.homeWinPct != null)
          .map((pt) => ({
            sequence: String(pt.sequence),
            period: pt.period,
            clock: pt.clock,
            homeWinPct: pt.homeWinPct as number,
          })),
      );
      setError(null);
    } catch (err) {
      if (!cancelledRef.current) setError((err as Error).message);
    }
  });

  useEffect(() => {
    cancelledRef.current = false;
    void loadRef.current();
    return () => {
      cancelledRef.current = true;
    };
  }, [eventId]);

  const isLive = data?.game.status === "in";
  usePolling(() => loadRef.current(), {
    activeMs: isLive ? 60_000 : 300_000,
    enabled: data?.game.status !== "post",
  });

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="absolute inset-x-0 bottom-0 md:inset-y-0 md:right-0 md:left-auto md:w-[480px] bg-background border-t md:border-t-0 md:border-l border-border rounded-t-xl md:rounded-none max-h-[92vh] md:max-h-none overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {!data ? (
          <div className="p-6 text-sm text-muted-foreground">
            {error ? `Error: ${error}` : "Loading…"}
          </div>
        ) : (
          <>
            <div className="sticky top-0 bg-background border-b border-border z-10 px-4 py-3 flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0">
                <TeamLogo team={data.game.awayTeamAbbrev} size={24} />
                <span className="text-lg font-bold tabular-nums">{data.game.awayScore}</span>
                <span className="text-xs text-muted-foreground">@</span>
                <span className="text-lg font-bold tabular-nums">{data.game.homeScore}</span>
                <TeamLogo team={data.game.homeTeamAbbrev} size={24} />
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    "text-xs font-semibold",
                    data.game.status === "in" && "text-red-500",
                  )}
                >
                  {formatStatus(data.game)}
                </span>
                <button
                  type="button"
                  onClick={onClose}
                  className="text-muted-foreground hover:text-foreground text-sm"
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="px-4 pt-3 pb-2 flex gap-1 border-b border-border/60">
              {(["box", "pbp", "chart"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={cn(
                    "text-xs px-2 py-1 rounded-md font-medium",
                    tab === t
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t === "box" ? "Box Score" : t === "pbp" ? "Play-by-Play" : "Win Prob"}
                </button>
              ))}
            </div>

            <div className="p-4 space-y-4">
              {tab === "box" ? (
                <>
                  <TeamStatsPanel
                    rows={data.teamStats}
                    home={data.game.homeTeamAbbrev}
                    away={data.game.awayTeamAbbrev}
                  />
                  <TeamBox
                    team={data.game.awayTeamAbbrev}
                    opposing={data.game.homeTeamAbbrev}
                    players={data.playerStats}
                    rosteredPlayers={rosteredPlayers}
                  />
                  <TeamBox
                    team={data.game.homeTeamAbbrev}
                    opposing={data.game.awayTeamAbbrev}
                    players={data.playerStats}
                    rosteredPlayers={rosteredPlayers}
                  />
                </>
              ) : null}

              {tab === "pbp" ? <PlayByPlay plays={plays} /> : null}

              {tab === "chart" ? (
                <WinProbabilityChart
                  points={winProb}
                  homeTeam={data.game.homeTeamAbbrev}
                  awayTeam={data.game.awayTeamAbbrev}
                />
              ) : null}

              {data.game.broadcast || data.game.venue ? (
                <div className="pt-2 text-[11px] text-muted-foreground border-t border-border/40 space-y-0.5">
                  {data.game.broadcast ? <div>Coverage: {data.game.broadcast}</div> : null}
                  {data.game.venue ? <div>Venue: {data.game.venue}</div> : null}
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
