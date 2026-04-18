"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Line,
  LineChart,
  ReferenceDot,
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

type ProjectionEvent = {
  gameId: string;
  sequence: number;
  updatedAtEvent: string;
  kind: "scoring" | "end_of_half" | "end_of_game";
  actualPoints: Record<string, number>;
  projectedPoints: Record<
    string,
    { mean: number; stddev: number; p10: number; p90: number; winProb: number }
  >;
  eventMeta: {
    text: string | null;
    teamAbbrev: string | null;
    playerIds: string[];
    scoreValue: number | null;
    period: number | null;
    clock: string | null;
    homeScore: number | null;
    awayScore: number | null;
  };
  simCount: number;
  computedAt: string;
};

type ProjectionJobSummary = {
  id: string;
  status: string;
  totalEvents: number | null;
  processedEvents: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  createdAt: string;
};

type ProjectionsResponse = {
  managers: Array<{ userId: string; name: string }>;
  events: ProjectionEvent[];
  latestJob: ProjectionJobSummary | null;
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

// Parse NBA game clock ("12:34", "0:34.5", "34.5") to seconds remaining in the period.
function clockToSecondsRemaining(clock: string | null): number | null {
  if (!clock) return null;
  const parts = clock.split(":");
  if (parts.length === 2) {
    const m = parseInt(parts[0], 10);
    const s = parseFloat(parts[1]);
    if (Number.isFinite(m) && Number.isFinite(s)) return m * 60 + s;
  } else if (parts.length === 1) {
    const s = parseFloat(parts[0]);
    if (Number.isFinite(s)) return s;
  }
  return null;
}

/** Approximate wall-clock time a play occurred: game.startTime + elapsed game time.
 *  Ignores halftime/timeouts/reviews, but is far more useful than the ingest
 *  timestamp (which clumps events by sync batch). */
function synthPlayTime(
  startTime: string | null | undefined,
  period: number | null,
  clock: string | null,
): string | null {
  if (!startTime || period == null) return null;
  const startMs = new Date(startTime).getTime();
  if (!Number.isFinite(startMs)) return null;
  const periodLen = 12 * 60;
  const remaining = clockToSecondsRemaining(clock) ?? periodLen;
  const elapsed = (period - 1) * periodLen + (periodLen - remaining);
  return new Date(startMs + elapsed * 1000).toISOString();
}

// ─── Component ──────────────────────────────────────────────────────────────

export function LeagueChartPanel({
  leagueId,
  rosters,
  viewerEmail,
}: {
  leagueId: string;
  rosters: LeagueRoster[];
  viewerEmail?: string | null;
}) {
  const { simResults, status: simStatus, pendingEvents } = useAutoSim(leagueId);
  const [timeseries, setTimeseries] = useState<TimeseriesResponse | null>(null);
  const [schedule, setSchedule] = useState<ScheduleResponse | null>(null);
  const [projections, setProjections] = useState<ProjectionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<ChartMode>("pts");
  const [resolution, setResolution] = useState<Resolution>("game");
  const [activeRound, setActiveRound] = useState<Round | null>(null);
  const [hoveredGameId, setHoveredGameId] = useState<string | null>(null);
  const [hoveredEventKey, setHoveredEventKey] = useState<string | null>(null);
  const [rebuildBusy, setRebuildBusy] = useState(false);

  const isCommissionerViewer =
    typeof viewerEmail === "string" &&
    viewerEmail.trim().toLowerCase() === "santhoshnarayan@gmail.com";

  const refetchData = useCallback(async () => {
    try {
      const [t, s, p] = await Promise.all([
        appApiFetch<TimeseriesResponse>(
          `/leagues/${encodeURIComponent(leagueId)}/timeseries`,
        ),
        appApiFetch<ScheduleResponse>(`/nba/schedule`),
        appApiFetch<ProjectionsResponse>(
          `/leagues/${encodeURIComponent(leagueId)}/projections-timeline`,
        ).catch(() => null),
      ]);
      setTimeseries(t);
      setSchedule(s);
      setProjections(p);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [leagueId]);

  const triggerRebuild = useCallback(
    async (mode: "full" | "incremental") => {
      if (rebuildBusy) return;
      setRebuildBusy(true);
      try {
        await appApiFetch(`/leagues/${encodeURIComponent(leagueId)}/rebuild-projections`, {
          method: "POST",
          body: JSON.stringify({ mode }),
        });
        await refetchData();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setRebuildBusy(false);
      }
    },
    [leagueId, rebuildBusy, refetchData],
  );

  useEffect(() => {
    void refetchData();
  }, [refetchData]);

  // Re-pull timeseries whenever the sim just finished a live rerun — that's
  // when new game-end checkpoints exist on the server that the chart hasn't
  // yet rendered. Also poll every 60s as a fallback.
  const prevSimStatusRef = useRef(simStatus);
  useEffect(() => {
    if (prevSimStatusRef.current === "rerunning" && simStatus === "ready") {
      void refetchData();
    }
    prevSimStatusRef.current = simStatus;
  }, [simStatus, refetchData]);

  useEffect(() => {
    const id = setInterval(() => void refetchData(), 60_000);
    return () => clearInterval(id);
  }, [refetchData]);

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

  // Projection steps: a time-ordered list of points to add to the running total
  // after the last actual checkpoint, one per future game plus synthetic
  // anchors for any round with no scheduled games yet.
  //
  // Each step has a time `t`, an optional `gameId` (for hover-syncing with the
  // scoreboard), and a per-manager increment. The sum of all increments per
  // manager equals the manager's projected remaining points — so the chart's
  // endpoint Y lands on the sim mean rather than undercounting.
  const projectionSteps = useMemo(() => {
    if (!managerProjections || !simResults) return null;
    const now = Date.now();
    const futureGames = allGames.filter((g) => {
      const t = g.startTime ? new Date(g.startTime).getTime() : 0;
      return g.status === "pre" || (g.status === "in" && t > now);
    });

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

    const gamesByRound = {
      r1: [] as typeof futureGames,
      r2: [] as typeof futureGames,
      cf: [] as typeof futureGames,
      finals: [] as typeof futureGames,
    };
    for (const g of futureGames) gamesByRound[g.round].push(g);

    // Anchor date for rounds with no scheduled games — start from the latest
    // known game time and add a per-round offset (rough NBA postseason pacing).
    const lastKnownT = allGames.reduce((acc, g) => {
      const t = g.startTime ? new Date(g.startTime).getTime() : 0;
      return t > acc ? t : acc;
    }, now);
    const DAY = 24 * 60 * 60 * 1000;
    const roundAnchorOffsetDays: Record<Round, number> = { r1: 3, r2: 14, cf: 28, finals: 42 };

    const steps: Array<{ t: string; gameId?: string; inc: Record<string, number> }> = [];
    for (const r of ["r1", "r2", "cf", "finals"] as const) {
      const gs = gamesByRound[r];
      if (gs.length === 0) {
        // No scheduled games → emit a single anchor for the whole round.
        const t = new Date(lastKnownT + roundAnchorOffsetDays[r] * DAY).toISOString();
        const inc: Record<string, number> = {};
        for (const [userId, rounds] of perManagerPerRound) {
          inc[userId] = rounds[roundIdx[r]];
        }
        steps.push({ t, inc });
      } else {
        for (const g of gs) {
          const t = g.startTime ?? g.date ?? new Date(lastKnownT).toISOString();
          const inc: Record<string, number> = {};
          for (const [userId, rounds] of perManagerPerRound) {
            inc[userId] = rounds[roundIdx[r]] / gs.length;
          }
          steps.push({ t, gameId: g.id, inc });
        }
      }
    }
    steps.sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
    return steps;
  }, [managerProjections, simResults, allGames, rosters]);

  const hasCachedProjections = !!(projections && projections.events.length > 0);

  // Map gameId → startTime so we can synthesize play-time from period + clock.
  const gameStartTimeById = useMemo(() => {
    const m = new Map<string, string>();
    if (!schedule) return m;
    for (const games of Object.values(schedule.series)) {
      for (const g of games) {
        if (g.startTime) m.set(g.id, g.startTime);
      }
    }
    return m;
  }, [schedule]);

  // Final chart series data, depending on `mode`. When cached per-event
  // projections are available, the chart uses them (x-axis = event time,
  // y-axis = actualPoints | projected.mean | winProb*100). Otherwise falls
  // back to the old schedule-derived cumulative view.
  const { chartData, activeManagerIds } = useMemo(() => {
    if (hasCachedProjections && projections) {
      const managerIds = projections.managers.map((m) => m.userId);
      // Filter by resolution: per-game = end_of_game only, per-half = halves +
      // end_of_game, scoring = everything.
      let filtered = projections.events;
      if (resolution === "half") {
        filtered = filtered.filter(
          (ev) => ev.kind === "end_of_half" || ev.kind === "end_of_game",
        );
      } else if (resolution === "game") {
        filtered = filtered.filter((ev) => ev.kind === "end_of_game");
      }
      type Row = {
        t: string;
        values: Record<string, number>;
        gameId: string;
        eventKey: string;
      };
      const rows: Row[] = filtered
        .map((ev) => {
          const values: Record<string, number> = {};
          for (const uid of managerIds) {
            if (mode === "pts") values[uid] = ev.actualPoints[uid] ?? 0;
            else if (mode === "proj") values[uid] = ev.projectedPoints[uid]?.mean ?? 0;
            else values[uid] = (ev.projectedPoints[uid]?.winProb ?? 0) * 100;
          }
          const playT = synthPlayTime(
            gameStartTimeById.get(ev.gameId),
            ev.eventMeta.period,
            ev.eventMeta.clock,
          );
          return {
            t: playT ?? ev.updatedAtEvent,
            values,
            gameId: ev.gameId,
            eventKey: `${ev.gameId}|${ev.sequence}`,
          };
        })
        .sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());

      let kept: Row[] = rows;
      if (kept.length > DEFAULT_CHART_POINT_BUDGET) {
        const idx = lttbDownsample(
          kept,
          DEFAULT_CHART_POINT_BUDGET,
          (r) => managerIds.reduce((s, m) => s + (r.values[m] ?? 0), 0),
        );
        kept = idx.map((i) => rows[i]);
      }
      const flat = kept.map((r) => {
        const out: Record<string, number | string> = {
          t: r.t,
          __gameId: r.gameId,
          __eventKey: r.eventKey,
        };
        for (const uid of managerIds) out[uid] = r.values[uid] ?? 0;
        return out;
      });
      return { chartData: flat, activeManagerIds: managerIds };
    }

    if (!timeseries) {
      return { chartData: [] as Array<Record<string, number | string>>, activeManagerIds: [] as string[] };
    }
    const managerIds = timeseries.managers.map((m) => m.userId);

    if (mode === "prob") {
      const probByUser = new Map<string, number>();
      if (managerProjections) {
        for (const m of managerProjections) probByUser.set(m.userId, m.winProbability * 100);
      }
      const rows: Array<Record<string, number | string>> = [];
      const firstT = cumulative[0]?.t ?? new Date().toISOString();
      const nowT = new Date().toISOString();
      const endT = allGames[allGames.length - 1]?.startTime ?? nowT;
      for (const t of [firstT, nowT, endT]) {
        const row: Record<string, number | string> = { t };
        for (const uid of managerIds) row[uid] = probByUser.get(uid) ?? 0;
        rows.push(row);
      }
      return { chartData: rows, activeManagerIds: managerIds };
    }

    type Row = { t: string; totals: Record<string, number>; gameId?: string };
    const baseRows: Row[] = cumulative.map((r) => ({ t: r.t, totals: r.totals, gameId: r.cp.gameId }));

    if (mode === "proj" && projectionSteps) {
      const lastActual: Record<string, number> = baseRows.length
        ? { ...baseRows[baseRows.length - 1].totals }
        : Object.fromEntries(managerIds.map((u) => [u, 0]));
      const running: Record<string, number> = { ...lastActual };
      for (const step of projectionSteps) {
        for (const [uid, v] of Object.entries(step.inc)) {
          running[uid] = (running[uid] ?? 0) + v;
        }
        baseRows.push({ t: step.t, totals: { ...running }, gameId: step.gameId });
      }
    }

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
      if (r.gameId) out.__gameId = r.gameId;
      for (const uid of managerIds) out[uid] = r.totals[uid] ?? 0;
      return out;
    });
    return { chartData: flat, activeManagerIds: managerIds };
  }, [
    hasCachedProjections,
    projections,
    mode,
    resolution,
    gameStartTimeById,
    timeseries,
    cumulative,
    allGames,
    managerProjections,
    projectionSteps,
  ]);

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

  const displayManagers = useMemo(() => {
    if (hasCachedProjections && projections) return projections.managers;
    return timeseries?.managers ?? [];
  }, [hasCachedProjections, projections, timeseries]);

  const managerColors = useMemo(() => {
    const m = new Map<string, string>();
    displayManagers.forEach((mgr, i) => m.set(mgr.userId, COLORS[i % COLORS.length]));
    return m;
  }, [displayManagers]);

  // Game-end dot positions — one per kept checkpoint labeled "end", placed
  // at a fixed y above the chart area for a NCAAM-style timeline marker row.
  const gameEndDots = useMemo(() => {
    if (!timeseries) return [] as Array<{ t: string; gameId: string; color: string }>;
    const ends = timeseries.checkpoints.filter((c) => c.label === "end");
    // Color each dot by the manager who gained the most points from that game.
    return ends.map((c) => {
      let bestUid: string | null = null;
      let bestDelta = 0;
      for (const [uid, d] of Object.entries(c.pointsDelta)) {
        if (d > bestDelta) { bestDelta = d; bestUid = uid; }
      }
      const color = bestUid ? managerColors.get(bestUid) ?? "#94a3b8" : "#94a3b8";
      return { t: c.t, gameId: c.gameId, color };
    });
  }, [timeseries, managerColors]);

  // Right-edge label list sorted by final value descending.
  const endLabels = useMemo(() => {
    if (!chartData.length) return [] as Array<{ userId: string; name: string; value: number }>;
    const last = chartData[chartData.length - 1];
    return displayManagers
      .map((m) => ({
        userId: m.userId,
        name: m.name,
        value: typeof last[m.userId] === "number" ? (last[m.userId] as number) : 0,
      }))
      .sort((a, b) => b.value - a.value);
  }, [chartData, displayManagers]);

  // Lookup for hover details → map from eventKey to event.
  const eventByKey = useMemo(() => {
    const m = new Map<string, ProjectionEvent>();
    if (projections) {
      for (const ev of projections.events) {
        m.set(`${ev.gameId}|${ev.sequence}`, ev);
      }
    }
    return m;
  }, [projections]);

  const hoveredEvent = hoveredEventKey ? eventByKey.get(hoveredEventKey) ?? null : null;

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
              <LineChart
                data={chartData}
                margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                onMouseMove={(state: unknown) => {
                  const s = state as {
                    activePayload?: Array<{ payload?: { __gameId?: unknown; __eventKey?: unknown } }>;
                  };
                  const p = s?.activePayload?.[0]?.payload;
                  const gid = p && typeof p.__gameId === "string" ? p.__gameId : null;
                  const ek = p && typeof p.__eventKey === "string" ? p.__eventKey : null;
                  setHoveredGameId(gid);
                  setHoveredEventKey(ek);
                }}
                onMouseLeave={() => {
                  setHoveredGameId(null);
                  setHoveredEventKey(null);
                }}
              >
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
                    let base: string;
                    try { base = new Date(t).toLocaleString(); } catch { base = t; }
                    return pendingEvents > 0
                      ? `${base}  ·  +${pendingEvents} queued`
                      : base;
                  }}
                  formatter={(value, key) => {
                    const n = typeof value === "number" ? value : Number(value ?? 0);
                    const mgr = displayManagers.find((m) => m.userId === String(key));
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
                {/* Hovered-game vertical line */}
                {hoveredGameId ? (() => {
                  const row = chartData.find((r) => r.__gameId === hoveredGameId);
                  return row ? (
                    <ReferenceLine
                      x={row.t as string}
                      stroke="hsl(var(--foreground))"
                      strokeOpacity={0.25}
                      strokeWidth={1}
                    />
                  ) : null;
                })() : null}
                {/* Game-end dots above the chart */}
                {mode !== "prob" && gameEndDots.map((d) => (
                  <ReferenceDot
                    key={d.gameId}
                    x={d.t}
                    y={0}
                    r={hoveredGameId === d.gameId ? 5 : 3}
                    fill={d.color}
                    stroke="none"
                    ifOverflow="extendDomain"
                  />
                ))}
                {activeManagerIds.map((uid, i) => (
                  <Line
                    key={uid}
                    type="monotone"
                    dataKey={uid}
                    stroke={managerColors.get(uid) ?? COLORS[i % COLORS.length]}
                    strokeWidth={1.75}
                    dot={false}
                    activeDot={{ r: 3 }}
                    isAnimationActive
                    animationDuration={600}
                    animationEasing="ease-in-out"
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="w-28 shrink-0 flex flex-col text-[11px] overflow-hidden pt-2 pb-2">
            {hoveredEvent ? (() => {
              const g = allGames.find((ag) => ag.id === hoveredEvent.gameId);
              const matchup =
                g && g.awayTeam && g.homeTeam
                  ? `${g.awayTeam} @ ${g.homeTeam}${g.gameNum ? ` G${g.gameNum}` : ""}`
                  : null;
              return (
                <div className="text-[9px] text-muted-foreground leading-tight pb-1.5 mb-1 border-b border-border/40 break-words">
                  {matchup ? (
                    <div className="font-medium text-foreground/80">{matchup}</div>
                  ) : null}
                  <div>{eventLineText(hoveredEvent)}</div>
                </div>
              );
            })() : null}
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
              <ScoreboardCard
                key={g.id}
                g={g}
                highlighted={hoveredGameId === g.id}
                onHoverChange={(v) => setHoveredGameId(v ? g.id : null)}
                hoveredEvent={hoveredGameId === g.id ? hoveredEvent : null}
              />
            ))}
          </div>
        </div>
        {isCommissionerViewer ? (
          <div className="flex items-center justify-between text-[10px] text-muted-foreground -mt-1">
            <span>
              {projections?.latestJob ? (
                <>
                  projections job:{" "}
                  <span className="font-mono">{projections.latestJob.status}</span>
                  {projections.latestJob.totalEvents != null
                    ? ` (${projections.latestJob.processedEvents}/${projections.latestJob.totalEvents})`
                    : ""}
                </>
              ) : hasCachedProjections ? (
                `${projections?.events.length ?? 0} cached events`
              ) : (
                "no cached projections yet"
              )}
            </span>
            <div className="flex gap-1.5">
              <button
                type="button"
                disabled={rebuildBusy}
                onClick={() => triggerRebuild("incremental")}
                className={cn(
                  "px-2 py-0.5 rounded border text-[10px] transition-colors",
                  rebuildBusy
                    ? "border-border text-muted-foreground"
                    : "border-border hover:bg-muted",
                )}
              >
                {rebuildBusy ? "…" : "rebuild (new events)"}
              </button>
              <button
                type="button"
                disabled={rebuildBusy}
                onClick={() => triggerRebuild("full")}
                className={cn(
                  "px-2 py-0.5 rounded border text-[10px] transition-colors",
                  rebuildBusy
                    ? "border-border text-muted-foreground"
                    : "border-destructive/60 hover:bg-destructive/10",
                )}
              >
                rebuild all
              </button>
            </div>
          </div>
        ) : null}
        {simStatus === "rerunning" ? (
          <p className="text-[10px] text-muted-foreground italic text-right -mt-1">
            projections updating{pendingEvents > 0 ? ` (+${pendingEvents} queued)` : ""}…
          </p>
        ) : pendingEvents > 0 ? (
          <p className="text-[10px] text-muted-foreground italic text-right -mt-1">
            {pendingEvents} live update{pendingEvents === 1 ? "" : "s"} queued
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
  highlighted,
  onHoverChange,
  hoveredEvent,
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
  highlighted: boolean;
  onHoverChange: (hovered: boolean) => void;
  hoveredEvent: ProjectionEvent | null;
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

  const showEvent = !!hoveredEvent && hoveredEvent.gameId === g.id;
  const eventLine = showEvent
    ? eventLineText(hoveredEvent!)
    : null;

  return (
    <Link
      href={`/games/${encodeURIComponent(g.id)}`}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
      className={cn(
        "shrink-0 rounded-md border px-2 py-1.5 w-[112px] flex flex-col gap-0.5 text-[10px] transition-colors",
        isLive && "border-red-500/60 bg-red-500/5",
        isFinal && "border-border/60 bg-muted/30",
        isPre && "border-border/50",
        highlighted && "border-red-500 ring-1 ring-red-500/40 bg-red-500/10",
      )}
    >
      <div className="flex items-center justify-between text-[9px] text-muted-foreground">
        <span>{g.gameNum ? `G${g.gameNum}` : ""}</span>
        <span>{isLive ? "LIVE" : timeLabel}</span>
      </div>
      <TeamLine team={g.awayTeam} score={a} isPre={isPre} isWin={awayWin} isLose={isFinal && homeWin} />
      <TeamLine team={g.homeTeam} score={h} isPre={isPre} isWin={homeWin} isLose={isFinal && awayWin} />
      {eventLine ? (
        <div className="text-[9px] text-muted-foreground truncate leading-tight border-t border-border/40 mt-0.5 pt-0.5">
          {eventLine}
        </div>
      ) : null}
    </Link>
  );
}

function eventLineText(ev: ProjectionEvent): string {
  if (ev.kind === "end_of_game") {
    const s = ev.eventMeta;
    if (s.homeScore != null && s.awayScore != null) {
      return `Final · ${s.awayScore}–${s.homeScore}`;
    }
    return "Final";
  }
  if (ev.kind === "end_of_half") {
    const period = ev.eventMeta.period ?? 2;
    return period === 2 ? "End Q2 (half)" : `End Q${period}`;
  }
  // scoring
  const text = ev.eventMeta.text ?? "";
  const short = text.length > 40 ? `${text.slice(0, 38)}…` : text;
  const period = ev.eventMeta.period;
  const clock = ev.eventMeta.clock;
  const prefix = period != null && clock ? `Q${period} ${clock} · ` : "";
  return `${prefix}${short || "scoring play"}`;
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
