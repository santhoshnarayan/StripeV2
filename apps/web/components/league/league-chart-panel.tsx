"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { TeamLogo } from "@/components/sim/player-avatar";
import { appApiFetch } from "@/lib/app-api";
import { DEFAULT_CHART_POINT_BUDGET, lttbDownsample } from "@/lib/charts/lttb";
import { useAutoSim } from "@/lib/use-auto-sim";
import { computeManagerProjections } from "@/lib/sim";
import { cn } from "@/lib/utils";

// ─── Types ──────────────────────────────────────────────────────────────────

type Checkpoint = {
  t: string;
  gameId: string;
  seriesKey: string | null;
  gameNum: number | null;
  homeTeam: string | null;
  awayTeam: string | null;
  period: number | null;
  clock: string | null;
  label: "play" | "half" | "end";
  pointsDelta: Record<string, number>;
};

type TimeseriesResponse = {
  managers: Array<{ userId: string; name: string }>;
  checkpoints: Checkpoint[];
};

type ScheduleResponse = {
  series: Record<
    string,
    Array<{
      id: string;
      gameNum: number | null;
      date: string | null;
      startTime: string | null;
      status: string;
      homeScore: number | null;
      awayScore: number | null;
      homeTeam: string | null;
      awayTeam: string | null;
    }>
  >;
};

type LeagueRoster = {
  userId: string;
  name: string;
  players: Array<{ playerId: string; playerName: string; playerTeam: string }>;
};

type ChartMode = "prob" | "pts" | "proj";
type Resolution = "game" | "half" | "scoring";
type Round = "r1" | "r2" | "cf" | "finals";

const MODE_OPTIONS: { key: ChartMode; label: string }[] = [
  { key: "prob", label: "Win %" },
  { key: "pts", label: "Pts" },
  { key: "proj", label: "Proj" },
];

const RES_OPTIONS: { key: Resolution; label: string }[] = [
  { key: "game", label: "Per Game" },
  { key: "half", label: "Per Half" },
  { key: "scoring", label: "Every Score" },
];

const ROUND_OPTIONS: { key: Round; label: string }[] = [
  { key: "r1", label: "R1" },
  { key: "r2", label: "R2" },
  { key: "cf", label: "CF" },
  { key: "finals", label: "Finals" },
];

const COLORS = [
  "#ef4444", "#6d9eeb", "#93c47d", "#f5c842", "#b48bf2",
  "#e06cc0", "#45c9dd", "#f4845f", "#76d7c4", "#84cc16",
  "#f43f5e", "#a855f7",
];

function shortLabel(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return name;
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

function roundFromSeriesKey(key: string | null): Round | null {
  if (!key) return null;
  if (key.startsWith("r1.")) return "r1";
  if (key.startsWith("r2.")) return "r2";
  if (key.startsWith("cf.")) return "cf";
  if (key.startsWith("finals")) return "finals";
  return null;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function LeagueChartPanel({
  leagueId,
  rosters,
}: {
  leagueId: string;
  rosters: LeagueRoster[];
}) {
  const { simResults, status: simStatus } = useAutoSim(leagueId);
  const [timeseries, setTimeseries] = useState<TimeseriesResponse | null>(null);
  const [schedule, setSchedule] = useState<ScheduleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<ChartMode>("pts");
  const [resolution, setResolution] = useState<Resolution>("game");
  const [activeRound, setActiveRound] = useState<Round | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([
      appApiFetch<TimeseriesResponse>(
        `/leagues/${encodeURIComponent(leagueId)}/timeseries`,
      ),
      appApiFetch<ScheduleResponse>(`/nba/schedule`),
    ])
      .then(([t, s]) => {
        if (cancelled) return;
        setTimeseries(t);
        setSchedule(s);
      })
      .catch((e) => {
        if (cancelled) return;
        setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [leagueId]);

  // Per-manager projection totals (mean + win prob) from the sim.
  const managerProjections = useMemo(() => {
    if (!simResults) return null;
    const rosterInputs = rosters.map((r) => ({
      userId: r.userId,
      name: r.name,
      playerIds: r.players.map((p) => p.playerId),
    }));
    return computeManagerProjections(simResults, rosterInputs);
  }, [simResults, rosters]);

  // Filter checkpoints by resolution.
  const filteredCheckpoints = useMemo(() => {
    if (!timeseries) return [] as Checkpoint[];
    const cps = timeseries.checkpoints;
    if (resolution === "scoring") return cps;
    if (resolution === "half")
      return cps.filter((c) => c.label === "half" || c.label === "end");
    return cps.filter((c) => c.label === "end");
  }, [timeseries, resolution]);

  // Build cumulative totals per checkpoint.
  const cumulative = useMemo(() => {
    if (!timeseries) return [] as Array<{ t: string; totals: Record<string, number>; cp: Checkpoint }>;
    const allCps = timeseries.checkpoints; // use ALL checkpoints for running sum
    const keep = new Set(filteredCheckpoints.map((c) => c.t + ":" + c.gameId));
    const running: Record<string, number> = Object.fromEntries(
      timeseries.managers.map((m) => [m.userId, 0]),
    );
    const rows: Array<{ t: string; totals: Record<string, number>; cp: Checkpoint }> = [];
    for (const c of allCps) {
      for (const [uid, delta] of Object.entries(c.pointsDelta)) {
        running[uid] = (running[uid] ?? 0) + delta;
      }
      if (keep.has(c.t + ":" + c.gameId)) {
        rows.push({ t: c.t, totals: { ...running }, cp: c });
      }
    }
    return rows;
  }, [timeseries, filteredCheckpoints]);

  // Scheduled game list, flat + chronological.
  const allGames = useMemo(() => {
    if (!schedule) return [] as Array<{
      id: string;
      round: Round;
      gameNum: number | null;
      startTime: string | null;
      date: string | null;
      status: string;
      homeTeam: string | null;
      awayTeam: string | null;
      homeScore: number | null;
      awayScore: number | null;
      seriesKey: string;
    }>;
    const out: Array<{
      id: string;
      round: Round;
      gameNum: number | null;
      startTime: string | null;
      date: string | null;
      status: string;
      homeTeam: string | null;
      awayTeam: string | null;
      homeScore: number | null;
      awayScore: number | null;
      seriesKey: string;
    }> = [];
    for (const [seriesKey, games] of Object.entries(schedule.series)) {
      const round = roundFromSeriesKey(seriesKey);
      if (!round) continue;
      for (const g of games) {
        out.push({
          id: g.id,
          round,
          gameNum: g.gameNum,
          startTime: g.startTime,
          date: g.date,
          status: g.status,
          homeTeam: g.homeTeam,
          awayTeam: g.awayTeam,
          homeScore: g.homeScore,
          awayScore: g.awayScore,
          seriesKey,
        });
      }
    }
    return out.sort((a, b) => {
      const ta = a.startTime ? new Date(a.startTime).getTime() : a.date ? new Date(a.date).getTime() : 0;
      const tb = b.startTime ? new Date(b.startTime).getTime() : b.date ? new Date(b.date).getTime() : 0;
      return ta - tb;
    });
  }, [schedule]);

  // Projected remaining points per manager, spread across future games.
  const projectedRemainingByDate = useMemo(() => {
    if (!managerProjections || !simResults) return null;
    const now = Date.now();
    const futureGames = allGames.filter((g) => {
      const t = g.startTime ? new Date(g.startTime).getTime() : 0;
      return g.status === "pre" || (g.status === "in" && t > now);
    });
    if (futureGames.length === 0) return null;

    // Per round: mean projected remaining per manager (approx: use sim result's
    // projectedPointsByRound summed over roster, assumed to still be upcoming).
    const roundIdx = { r1: 0, r2: 1, cf: 2, finals: 3 };
    const perManagerPerRound = new Map<string, number[]>();
    for (const r of rosters) {
      const totals = [0, 0, 0, 0];
      for (const p of r.players) {
        const pr = simResults.players.find((x) => x.espnId === p.playerId);
        if (!pr) continue;
        const arr = pr.projectedPointsByRound ?? [];
        for (let i = 0; i < 4; i++) totals[i] += arr[i] ?? 0;
      }
      perManagerPerRound.set(r.userId, totals);
    }

    // Bucket future games by round.
    const gamesByRound = { r1: [] as typeof futureGames, r2: [] as typeof futureGames, cf: [] as typeof futureGames, finals: [] as typeof futureGames };
    for (const g of futureGames) gamesByRound[g.round].push(g);

    // Per-game increment per manager.
    const byGameId = new Map<string, Record<string, number>>();
    for (const r of ["r1", "r2", "cf", "finals"] as const) {
      const gs = gamesByRound[r];
      if (gs.length === 0) continue;
      for (const g of gs) {
        const inc: Record<string, number> = {};
        for (const [userId, rounds] of perManagerPerRound) {
          inc[userId] = rounds[roundIdx[r]] / gs.length;
        }
        byGameId.set(g.id, inc);
      }
    }
    return byGameId;
  }, [managerProjections, simResults, allGames, rosters]);

  // Final chart series data, depending on `mode`.
  const { chartData, yLabel, activeManagerIds } = useMemo(() => {
    if (!timeseries) {
      return { chartData: [] as Array<Record<string, number | string>>, yLabel: "", activeManagerIds: [] as string[] };
    }
    const managerIds = timeseries.managers.map((m) => m.userId);

    if (mode === "prob") {
      // Win % — v1 shows the current sim's win probability as a flat line back
      // in time. Until we wire per-checkpoint sim replays, this at least shows
      // rank ordering and current standing.
      const probByUser = new Map<string, number>();
      if (managerProjections) {
        for (const m of managerProjections) probByUser.set(m.userId, m.winProbability * 100);
      }
      const rows: Array<Record<string, number | string>> = [];
      // Leading anchor.
      const firstT = cumulative[0]?.t ?? new Date().toISOString();
      const nowT = new Date().toISOString();
      const endT = allGames[allGames.length - 1]?.startTime ?? nowT;
      for (const t of [firstT, nowT, endT]) {
        const row: Record<string, number | string> = { t };
        for (const uid of managerIds) row[uid] = probByUser.get(uid) ?? 0;
        rows.push(row);
      }
      return { chartData: rows, yLabel: "Win %", activeManagerIds: managerIds };
    }

    // Base rows from actual cumulative at each kept checkpoint.
    type Row = { t: string; totals: Record<string, number>; gameId?: string };
    const baseRows: Row[] = cumulative.map((r) => ({ t: r.t, totals: r.totals, gameId: r.cp.gameId }));

    if (mode === "proj" && projectedRemainingByDate) {
      const lastActual: Record<string, number> = baseRows.length ? { ...baseRows[baseRows.length - 1].totals } : Object.fromEntries(managerIds.map((u) => [u, 0]));
      const running: Record<string, number> = { ...lastActual };
      const nowMs = Date.now();
      const futureGames = allGames.filter((g) => {
        const t = g.startTime ? new Date(g.startTime).getTime() : 0;
        return g.status === "pre" || (g.status === "in" && t > nowMs);
      });
      for (const g of futureGames) {
        const inc = projectedRemainingByDate.get(g.id);
        if (!inc) continue;
        for (const [uid, v] of Object.entries(inc)) running[uid] = (running[uid] ?? 0) + v;
        baseRows.push({ t: g.startTime ?? new Date(nowMs).toISOString(), totals: { ...running }, gameId: g.id });
      }
    }

    // Downsample if needed.
    let rows: Row[] = baseRows;
    if (rows.length > DEFAULT_CHART_POINT_BUDGET) {
      const idx = lttbDownsample(
        rows,
        DEFAULT_CHART_POINT_BUDGET,
        (r) => managerIds.reduce((s, m) => s + (r.totals[m] ?? 0), 0),
      );
      rows = idx.map((i) => baseRows[i]);
    }

    const flat = rows.map((r) => {
      const out: Record<string, number | string> = { t: r.t };
      for (const uid of managerIds) out[uid] = r.totals[uid] ?? 0;
      return out;
    });
    return { chartData: flat, yLabel: mode === "proj" ? "Points" : "Points", activeManagerIds: managerIds };
  }, [timeseries, cumulative, mode, allGames, managerProjections, projectedRemainingByDate]);

  // Zoom to the active round's time window.
  const zoomDomain = useMemo(() => {
    if (!activeRound) return null;
    const rounds = allGames.filter((g) => g.round === activeRound);
    if (rounds.length === 0) return null;
    const ts = rounds
      .map((g) => (g.startTime ? new Date(g.startTime).getTime() : null))
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b);
    if (ts.length === 0) return null;
    return [new Date(ts[0]).toISOString(), new Date(ts[ts.length - 1] + 4 * 60 * 60 * 1000).toISOString()] as const;
  }, [activeRound, allGames]);

  const managerColors = useMemo(() => {
    const m = new Map<string, string>();
    timeseries?.managers.forEach((mgr, i) => m.set(mgr.userId, COLORS[i % COLORS.length]));
    return m;
  }, [timeseries]);

  // Right-edge label list sorted by final value descending.
  const endLabels = useMemo(() => {
    if (!chartData.length) return [] as Array<{ userId: string; name: string; value: number }>;
    const last = chartData[chartData.length - 1];
    const managers = timeseries?.managers ?? [];
    return managers
      .map((m) => ({
        userId: m.userId,
        name: m.name,
        value: typeof last[m.userId] === "number" ? (last[m.userId] as number) : 0,
      }))
      .sort((a, b) => b.value - a.value);
  }, [chartData, timeseries]);

  if (error) {
    return (
      <Card>
        <CardContent className="flex h-64 items-center justify-center text-sm text-destructive">
          {error}
        </CardContent>
      </Card>
    );
  }
  if (!timeseries || !schedule) {
    return (
      <Card>
        <CardContent className="flex h-64 items-center justify-center text-sm text-muted-foreground">
          Loading chart data…
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-3 space-y-3">
        {/* Controls row */}
        <div className="flex flex-wrap items-center gap-2 justify-between">
          <Segmented
            options={MODE_OPTIONS}
            value={mode}
            onChange={setMode}
          />
          <Segmented
            options={RES_OPTIONS}
            value={resolution}
            onChange={setResolution}
          />
        </div>

        {/* Chart + right-edge labels */}
        <div className="flex gap-3 items-stretch">
          <div className="flex-1 min-w-0 h-80">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <XAxis
                  dataKey="t"
                  type="category"
                  tick={{ fontSize: 10 }}
                  tickFormatter={(t: string) => {
                    try {
                      const d = new Date(t);
                      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                    } catch {
                      return t.slice(5, 10);
                    }
                  }}
                  minTickGap={48}
                  domain={zoomDomain ? [zoomDomain[0], zoomDomain[1]] : ["auto", "auto"]}
                />
                <YAxis
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v: number) => mode === "prob" ? `${Math.round(v)}%` : v.toLocaleString()}
                  width={40}
                  domain={mode === "prob" ? [0, 100] : ["auto", "auto"]}
                />
                <Tooltip
                  contentStyle={{
                    fontSize: 11,
                    borderRadius: 6,
                    border: "1px solid hsl(var(--border))",
                    background: "hsl(var(--background))",
                  }}
                  labelFormatter={(label) => {
                    const t = String(label ?? "");
                    try { return new Date(t).toLocaleString(); } catch { return t; }
                  }}
                  formatter={(value, key) => {
                    const n = typeof value === "number" ? value : Number(value ?? 0);
                    const mgr = timeseries.managers.find((m) => m.userId === String(key));
                    const label = mode === "prob" ? `${n.toFixed(1)}%` : Math.round(n).toLocaleString();
                    return [label, mgr?.name ?? String(key)];
                  }}
                  itemSorter={(item) => -(item.value as number)}
                />
                {/* Vertical "now" marker */}
                <ReferenceLine
                  x={new Date().toISOString()}
                  stroke="hsl(var(--foreground))"
                  strokeDasharray="3 3"
                  strokeOpacity={0.35}
                  label={{ value: "now", position: "insideTopLeft", fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                />
                {activeManagerIds.map((uid, i) => (
                  <Line
                    key={uid}
                    type="monotone"
                    dataKey={uid}
                    stroke={managerColors.get(uid) ?? COLORS[i % COLORS.length]}
                    strokeWidth={1.75}
                    dot={false}
                    activeDot={{ r: 3 }}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="w-28 shrink-0 flex flex-col text-[11px] overflow-hidden pt-2 pb-2">
            {endLabels.slice(0, 12).map((e) => (
              <div key={e.userId} className="flex items-center gap-1.5 leading-tight py-0.5 min-w-0">
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: managerColors.get(e.userId) }}
                />
                <span className="truncate flex-1">{shortLabel(e.name)}</span>
                <span className="tabular-nums text-muted-foreground">
                  {mode === "prob" ? `${e.value.toFixed(0)}%` : Math.round(e.value)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Round filter */}
        <div className="grid grid-cols-4 gap-1">
          {ROUND_OPTIONS.map((r) => {
            const isActive = activeRound === r.key;
            return (
              <button
                key={r.key}
                type="button"
                onClick={() => setActiveRound(isActive ? null : r.key)}
                className={cn(
                  "py-1 text-[11px] rounded-md transition-colors border",
                  isActive
                    ? "bg-foreground text-background border-foreground"
                    : "border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                {r.label}
              </button>
            );
          })}
        </div>

        {/* Scoreboard of games (past + future) */}
        <div className="-mx-3 px-3 overflow-x-auto no-scrollbar">
          <div className="flex gap-1.5">
            {allGames.map((g) => (
              <ScoreboardCard key={g.id} g={g} />
            ))}
          </div>
        </div>
        {simStatus === "rerunning" ? (
          <p className="text-[10px] text-muted-foreground italic text-right -mt-1">
            projections updating…
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ key: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-0.5 bg-muted/60 rounded-lg p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={cn(
            "px-2.5 py-1 text-[11px] rounded-md transition-colors",
            value === o.key
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ScoreboardCard({
  g,
}: {
  g: {
    id: string;
    status: string;
    gameNum: number | null;
    startTime: string | null;
    date: string | null;
    homeTeam: string | null;
    awayTeam: string | null;
    homeScore: number | null;
    awayScore: number | null;
  };
}) {
  const isLive = g.status === "in";
  const isFinal = g.status === "post";
  const isPre = g.status === "pre";
  const h = g.homeScore ?? 0;
  const a = g.awayScore ?? 0;
  const homeWin = h > a;
  const awayWin = a > h;
  const timeLabel = g.startTime
    ? new Date(g.startTime).toLocaleDateString("en-US", { month: "numeric", day: "numeric" })
    : "";

  return (
    <Link
      href={`/games/${encodeURIComponent(g.id)}`}
      className={cn(
        "shrink-0 rounded-md border px-2 py-1.5 w-[92px] flex flex-col gap-0.5 text-[10px]",
        isLive && "border-red-500/60 bg-red-500/5",
        isFinal && "border-border/60 bg-muted/30",
        isPre && "border-border/50",
      )}
    >
      <div className="flex items-center justify-between text-[9px] text-muted-foreground">
        <span>{g.gameNum ? `G${g.gameNum}` : ""}</span>
        <span>{isLive ? "LIVE" : timeLabel}</span>
      </div>
      <TeamLine team={g.awayTeam} score={a} isPre={isPre} isWin={awayWin} isLose={isFinal && homeWin} />
      <TeamLine team={g.homeTeam} score={h} isPre={isPre} isWin={homeWin} isLose={isFinal && awayWin} />
    </Link>
  );
}

function TeamLine({
  team,
  score,
  isPre,
  isWin,
  isLose,
}: {
  team: string | null;
  score: number;
  isPre: boolean;
  isWin: boolean;
  isLose: boolean;
}) {
  return (
    <div className="flex items-center gap-1">
      {team ? <TeamLogo team={team} size={12} /> : <span className="w-3 h-3" />}
      <span className={cn("flex-1 truncate text-[10px]", isLose && "text-muted-foreground", isWin && "font-semibold")}>
        {team ?? "TBD"}
      </span>
      {!isPre && (
        <span className={cn("tabular-nums text-[10px] shrink-0", isLose && "text-muted-foreground", isWin && "font-bold")}>
          {score}
        </span>
      )}
    </div>
  );
}
