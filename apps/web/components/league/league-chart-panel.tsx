"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { appApiFetch } from "@/lib/app-api";
import { DEFAULT_CHART_POINT_BUDGET, lttbDownsample } from "@/lib/charts/lttb";
import { useAutoSim } from "@/lib/use-auto-sim";

type ScoringTimelineResponse = {
  managers: Array<{ userId: string; name: string }>;
  points: Array<{ date: string; totals: Record<string, number> }>;
};

type ScheduleResponse = {
  series: Record<
    string,
    Array<{
      id: string;
      gameNum: number | null;
      date: string | null;
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

const COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6",
  "#0ea5e9", "#6366f1", "#a855f7", "#ec4899", "#84cc16",
  "#f43f5e", "#06b6d4",
];

function shortLabel(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return name;
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

function roundFromSeriesKey(key: string): "r1" | "r2" | "cf" | "finals" | null {
  if (key.startsWith("r1.")) return "r1";
  if (key.startsWith("r2.")) return "r2";
  if (key.startsWith("cf.")) return "cf";
  if (key.startsWith("finals")) return "finals";
  return null;
}

const ROUND_IDX: Record<"r1" | "r2" | "cf" | "finals", number> = {
  r1: 0,
  r2: 1,
  cf: 2,
  finals: 3,
};

const ROUND_LABEL: Record<"r1" | "r2" | "cf" | "finals", string> = {
  r1: "R1",
  r2: "R2",
  cf: "CF",
  finals: "F",
};

/** Return the ISO day (YYYY-MM-DD) from a Date or ISO string, in local time. */
function toDay(input: string | Date): string {
  const d = typeof input === "string" ? new Date(input) : input;
  return d.toISOString().slice(0, 10);
}

export function LeagueChartPanel({
  leagueId,
  rosters,
}: {
  leagueId: string;
  rosters: LeagueRoster[];
}) {
  const { simResults, status: simStatus } = useAutoSim(leagueId);
  const [timeline, setTimeline] = useState<ScoringTimelineResponse | null>(null);
  const [schedule, setSchedule] = useState<ScheduleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([
      appApiFetch<ScoringTimelineResponse>(
        `/leagues/${encodeURIComponent(leagueId)}/scoring-timeline`,
      ),
      appApiFetch<ScheduleResponse>(`/nba/schedule`),
    ])
      .then(([t, s]) => {
        if (cancelled) return;
        setTimeline(t);
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

  // Per-manager projected points by round, derived from the sim + rosters.
  const projectedByManager = useMemo(() => {
    if (!simResults) return null;
    const byUser = new Map<string, number[]>(); // userId → [R1, R2, CF, Finals]
    for (const roster of rosters) {
      const totals = [0, 0, 0, 0];
      for (const p of roster.players) {
        const proj = simResults.players.find((x) => x.espnId === p.playerId);
        if (!proj) continue;
        const pr = proj.projectedPointsByRound ?? [];
        for (let i = 0; i < 4; i++) totals[i] += pr[i] ?? 0;
      }
      byUser.set(roster.userId, totals);
    }
    return byUser;
  }, [simResults, rosters]);

  // Dates by round: {r1: [YYYY-MM-DD, ...], r2: [...], ...}
  const datesByRound = useMemo(() => {
    const out: Record<"r1" | "r2" | "cf" | "finals", string[]> = {
      r1: [], r2: [], cf: [], finals: [],
    };
    if (!schedule) return out;
    for (const [key, games] of Object.entries(schedule.series)) {
      const round = roundFromSeriesKey(key);
      if (!round) continue;
      for (const g of games) {
        if (!g.date) continue;
        out[round].push(toDay(g.date));
      }
    }
    for (const r of Object.keys(out) as Array<keyof typeof out>) {
      out[r] = Array.from(new Set(out[r])).sort();
    }
    return out;
  }, [schedule]);

  // Build the full timeline: actual points per day up to today, then linearly
  // distributed projected points across remaining scheduled dates per round.
  const { chartData, managers, today, managerColors } = useMemo(() => {
    if (!timeline || !schedule) {
      return { chartData: [], managers: [], today: null as string | null, managerColors: new Map<string, string>() };
    }
    const tToday = toDay(new Date());
    const colors = new Map<string, string>();
    timeline.managers.forEach((m, i) => colors.set(m.userId, COLORS[i % COLORS.length]));

    // Start with actual points (includes live for today).
    type Row = { date: string; totals: Record<string, number>; isFuture: boolean };
    const rows: Row[] = timeline.points.map((p) => ({
      date: p.date,
      totals: { ...p.totals },
      isFuture: false,
    }));

    const lastActual = rows.length ? rows[rows.length - 1] : null;
    const actualCumulative: Record<string, number> = lastActual
      ? { ...lastActual.totals }
      : Object.fromEntries(timeline.managers.map((m) => [m.userId, 0]));

    // Per-manager per-round points already realized vs projected.
    // Approximation: assume all of actualCumulative came from rounds <= currentRound.
    // For projected forward: find each round's future dates and split projected
    // remaining evenly across them.

    if (projectedByManager) {
      // Figure out per-round totals as fractions of projectedPointsByRound.
      // We don't track actuals by round (timeline sums them), so assume future
      // projected = sum of round totals whose dates are in the future.
      const futureDatesByRound: Record<"r1" | "r2" | "cf" | "finals", string[]> = {
        r1: datesByRound.r1.filter((d) => d > tToday),
        r2: datesByRound.r2.filter((d) => d > tToday),
        cf: datesByRound.cf.filter((d) => d > tToday),
        finals: datesByRound.finals.filter((d) => d > tToday),
      };

      // Flatten future dates with per-manager daily increments.
      const allFutureDates = Array.from(
        new Set([...futureDatesByRound.r1, ...futureDatesByRound.r2, ...futureDatesByRound.cf, ...futureDatesByRound.finals]),
      ).sort();

      // Per-manager per-round per-day share.
      const dayIncrement = new Map<string, Record<string, number>>();
      for (const [userId, rounds] of projectedByManager) {
        for (const round of ["r1", "r2", "cf", "finals"] as const) {
          const dates = futureDatesByRound[round];
          if (dates.length === 0) continue;
          const perDay = rounds[ROUND_IDX[round]] / dates.length;
          for (const day of dates) {
            const bucket = dayIncrement.get(day) ?? {};
            bucket[userId] = (bucket[userId] ?? 0) + perDay;
            dayIncrement.set(day, bucket);
          }
        }
      }

      // Build running totals starting from actualCumulative.
      const running: Record<string, number> = { ...actualCumulative };
      for (const day of allFutureDates) {
        const incs = dayIncrement.get(day) ?? {};
        for (const [userId, inc] of Object.entries(incs)) {
          running[userId] = (running[userId] ?? 0) + inc;
        }
        // snapshot only on actual scheduled future dates; skip days that have
        // a row from the actual timeline already (shouldn't happen since we
        // filtered > tToday).
        rows.push({ date: day, totals: { ...running }, isFuture: true });
      }
    }

    // Downsample to respect the chart point budget if too many rows.
    let finalRows = rows;
    if (rows.length > DEFAULT_CHART_POINT_BUDGET) {
      const indices = lttbDownsample(
        rows,
        DEFAULT_CHART_POINT_BUDGET,
        (r) => timeline.managers.reduce((s, m) => s + (r.totals[m.userId] ?? 0), 0),
      );
      finalRows = indices.map((i) => rows[i]);
    }

    // Flatten to Recharts-friendly rows.
    const flat = finalRows.map((r) => {
      const out: Record<string, number | string | boolean> = {
        date: r.date,
        isFuture: r.isFuture,
      };
      for (const mgr of timeline.managers) out[mgr.userId] = r.totals[mgr.userId] ?? 0;
      return out;
    });

    return {
      chartData: flat,
      managers: timeline.managers,
      today: tToday,
      managerColors: colors,
    };
  }, [timeline, schedule, projectedByManager, datesByRound]);

  // Game-end markers: dates where any game finalized. One reference dot per
  // completed game (may cluster on same day).
  const gameEndDates = useMemo(() => {
    if (!schedule) return [] as Array<{ date: string; label: string }>;
    const markers: Array<{ date: string; label: string }> = [];
    for (const [key, games] of Object.entries(schedule.series)) {
      const round = roundFromSeriesKey(key);
      if (!round) continue;
      for (const g of games) {
        if (g.status !== "post" || !g.date) continue;
        markers.push({
          date: toDay(g.date),
          label: `${ROUND_LABEL[round]} G${g.gameNum ?? "?"}`,
        });
      }
    }
    return markers;
  }, [schedule]);

  if (error) {
    return (
      <Card>
        <CardContent className="flex h-64 items-center justify-center text-sm text-destructive">
          {error}
        </CardContent>
      </Card>
    );
  }
  if (simStatus === "error") {
    return (
      <Card>
        <CardContent className="flex h-64 items-center justify-center text-sm text-destructive">
          Simulation failed to load — projections unavailable.
        </CardContent>
      </Card>
    );
  }
  if (!timeline || !schedule) {
    return (
      <Card>
        <CardContent className="flex h-64 items-center justify-center text-sm text-muted-foreground">
          Loading chart data…
        </CardContent>
      </Card>
    );
  }
  if (chartData.length === 0) {
    return (
      <Card>
        <CardContent className="flex h-64 items-center justify-center text-sm text-muted-foreground">
          No scoring data yet — chart will populate as games finalize.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Scoring Over Time</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Solid = actual cumulative points · Dashed past{" "}
              <span className="italic">now</span> = projected from simulator (
              {simStatus === "rerunning" ? "updating…" : "latest"})
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-96 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border/60" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10 }}
                tickFormatter={(d: string) => d.slice(5)}
                minTickGap={32}
              />
              <YAxis
                tick={{ fontSize: 10 }}
                tickFormatter={(v: number) => v.toLocaleString()}
                width={48}
              />
              <Tooltip
                contentStyle={{
                  fontSize: 11,
                  borderRadius: 6,
                  border: "1px solid hsl(var(--border))",
                  background: "hsl(var(--background))",
                }}
                formatter={(value, key) => {
                  const numeric = typeof value === "number" ? value : Number(value ?? 0);
                  const keyStr = String(key ?? "");
                  const mgr = managers.find((m) => m.userId === keyStr);
                  return [Math.round(numeric).toLocaleString(), mgr?.name ?? keyStr];
                }}
                labelFormatter={(label) => `${String(label ?? "")}`}
                itemSorter={(item) => -(item.value as number)}
              />
              <Legend
                wrapperStyle={{ fontSize: 10, paddingTop: 4 }}
                iconSize={8}
                formatter={(value: string) => {
                  const mgr = managers.find((m) => m.userId === value);
                  return mgr ? shortLabel(mgr.name) : value;
                }}
              />
              {today ? (
                <ReferenceLine
                  x={today}
                  stroke="hsl(var(--foreground))"
                  strokeDasharray="4 4"
                  strokeOpacity={0.4}
                  label={{
                    value: "now",
                    position: "insideTopRight",
                    fontSize: 10,
                    fill: "hsl(var(--muted-foreground))",
                  }}
                />
              ) : null}
              {gameEndDates.slice(0, 40).map((m, i) => (
                <ReferenceLine
                  key={`g-${i}`}
                  x={m.date}
                  stroke="hsl(var(--muted-foreground))"
                  strokeOpacity={0.15}
                  strokeWidth={1}
                />
              ))}
              {managers.map((mgr, i) => (
                <Line
                  key={mgr.userId}
                  type="monotone"
                  dataKey={mgr.userId}
                  stroke={managerColors.get(mgr.userId) ?? COLORS[i % COLORS.length]}
                  strokeWidth={1.75}
                  dot={false}
                  activeDot={{ r: 3 }}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

