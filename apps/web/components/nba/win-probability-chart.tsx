"use client";

import { useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, ReferenceLine, Tooltip, ResponsiveContainer } from "recharts";
import { lttbDownsample, DEFAULT_CHART_POINT_BUDGET } from "@/lib/charts/lttb";

export type WinProbPoint = {
  sequence: string;
  period: number | null;
  clock: string | null;
  homeWinPct: number;
};

export function WinProbabilityChart({
  points,
  homeTeam,
  awayTeam,
}: {
  points: WinProbPoint[];
  homeTeam: string;
  awayTeam: string;
}) {
  const data = useMemo(() => {
    if (points.length === 0) return [];
    const keepIdx = new Set(lttbDownsample(points, DEFAULT_CHART_POINT_BUDGET, (p) => p.homeWinPct));
    return points
      .filter((_, i) => keepIdx.has(i))
      .map((p, i) => ({
        x: i,
        homePct: p.homeWinPct * 100,
        period: p.period,
        clock: p.clock,
      }));
  }, [points]);

  if (data.length === 0) {
    return (
      <div className="h-40 flex items-center justify-center text-xs text-muted-foreground">
        No win probability data yet
      </div>
    );
  }

  return (
    <div className="h-40 w-full">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 6, right: 6, bottom: 6, left: 6 }}>
          <XAxis dataKey="x" hide />
          <YAxis domain={[0, 100]} hide />
          <ReferenceLine y={50} stroke="currentColor" strokeOpacity={0.2} strokeDasharray="3 3" />
          <Tooltip
            cursor={{ stroke: "currentColor", strokeOpacity: 0.1 }}
            contentStyle={{ background: "var(--background)", border: "1px solid var(--border)", fontSize: 11 }}
            formatter={(value) => [`${Number(value).toFixed(1)}% ${homeTeam}`, "Win %"]}
            labelFormatter={(_, payload) => {
              const p = payload?.[0]?.payload as { period: number | null; clock: string | null } | undefined;
              if (!p) return "";
              return `Q${p.period ?? "?"} ${p.clock ?? ""}`;
            }}
          />
          <Line type="monotone" dataKey="homePct" stroke="#ef4444" strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
      <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
        <span>{awayTeam} wins ←</span>
        <span>→ {homeTeam} wins</span>
      </div>
    </div>
  );
}
