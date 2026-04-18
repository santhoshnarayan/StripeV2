"use client";

import { useEffect, useState } from "react";
import { appApiFetch } from "@/lib/app-api";
import { cn } from "@/lib/utils";
import { TeamLogo } from "@/components/sim/player-avatar";
import { WinProbabilityChart, type WinProbPoint } from "@/components/nba/win-probability-chart";

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
}: {
  team: string;
  opposing: string;
  players: PlayerStatsRow[];
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
            {teamPlayers.map((p) => (
              <tr key={p.playerId} className="border-t border-border/20">
                <td className={cn("py-1 pl-1 pr-2", p.starter && "font-semibold")}>
                  {p.playerName}
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
            ))}
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

  const fmtPct = (v: number | null | undefined) => (v == null ? "-" : `${(v * 100).toFixed(1)}%`);
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

export function GameDetail({ eventId, onClose }: { eventId: string; onClose: () => void }) {
  const [data, setData] = useState<GameDetailData | null>(null);
  const [plays, setPlays] = useState<PlayRow[]>([]);
  const [winProb, setWinProb] = useState<WinProbPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"box" | "pbp" | "chart">("box");

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [d, p, w] = await Promise.all([
          appApiFetch<GameDetailData>(`/nba/games/${encodeURIComponent(eventId)}`),
          appApiFetch<{ plays: PlayRow[] }>(`/nba/games/${encodeURIComponent(eventId)}/pbp`),
          appApiFetch<{ points: WinProbRow[] }>(`/nba/games/${encodeURIComponent(eventId)}/win-probability`),
        ]);
        if (cancelled) return;
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
        if (!cancelled) setError((err as Error).message);
      }
    };

    void load();
    const t = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [eventId]);

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
                  />
                  <TeamBox
                    team={data.game.homeTeamAbbrev}
                    opposing={data.game.awayTeamAbbrev}
                    players={data.playerStats}
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
