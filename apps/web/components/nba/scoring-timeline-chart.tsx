"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { appApiFetch } from "@/lib/app-api";
import { DEFAULT_CHART_POINT_BUDGET, lttbDownsample } from "@/lib/charts/lttb";

type ScoringTimelineResponse = {
  managers: Array<{ userId: string; name: string }>;
  points: Array<{ date: string; totals: Record<string, number> }>;
};

const COLORS = [
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#14b8a6", // teal
  "#0ea5e9", // sky
  "#6366f1", // indigo
  "#a855f7", // violet
  "#ec4899", // pink
  "#84cc16", // lime
  "#f43f5e", // rose
  "#06b6d4", // cyan
];

function shortLabel(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return name;
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

export function ScoringTimelineChart({ leagueId }: { leagueId: string }) {
  const [data, setData] = useState<ScoringTimelineResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    appApiFetch<ScoringTimelineResponse>(
      `/leagues/${encodeURIComponent(leagueId)}/scoring-timeline`,
    )
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [leagueId]);

  const { chartData, managers } = useMemo(() => {
    if (!data) return { chartData: [], managers: [] };
    // Build flat rows with one numeric column per manager.
    const rows = data.points.map((p) => {
      const row: Record<string, number | string> = { date: p.date };
      for (const mgr of data.managers) {
        row[mgr.userId] = p.totals[mgr.userId] ?? 0;
      }
      return row;
    });
    // Downsample by total league points (sum across managers) as the value axis.
    if (rows.length > DEFAULT_CHART_POINT_BUDGET) {
      const indices = lttbDownsample(
        rows,
        DEFAULT_CHART_POINT_BUDGET,
        (r) =>
          data.managers.reduce(
            (sum, m) => sum + ((r[m.userId] as number) ?? 0),
            0,
          ),
      );
      return {
        chartData: indices.map((i) => rows[i]),
        managers: data.managers,
      };
    }
    return { chartData: rows, managers: data.managers };
  }, [data]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        Loading scoring timeline…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (chartData.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        No completed games yet — chart will populate as the postseason progresses.
      </div>
    );
  }

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border/60" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10 }}
            tickFormatter={(d: string) => d.slice(5)}
            minTickGap={24}
          />
          <YAxis
            tick={{ fontSize: 10 }}
            tickFormatter={(v: number) => v.toLocaleString()}
            width={40}
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
            labelFormatter={(label) => `Date: ${String(label ?? "")}`}
          />
          <Legend
            wrapperStyle={{ fontSize: 10, paddingTop: 4 }}
            iconSize={8}
            formatter={(value: string) => {
              const mgr = managers.find((m) => m.userId === value);
              return mgr ? shortLabel(mgr.name) : value;
            }}
          />
          {managers.map((mgr, i) => (
            <Line
              key={mgr.userId}
              type="monotone"
              dataKey={mgr.userId}
              stroke={COLORS[i % COLORS.length]}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3 }}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
