"use client";

import { useState } from "react";
import { TeamLogo } from "@/components/sim/player-avatar";
import { cn } from "@/lib/utils";
import type {
  ManagerProjection,
  TeamExposureResult,
  TeamExposureRow,
  SimData,
} from "@/lib/sim";

// 4 columns now — "Champ" dropped. What matters is making the finals.
const ROUND_LABELS = ["R1", "R2", "CF", "Finals"] as const;

// Two display modes for the per-team round cells.
//
// - "cumulative": P(team reached round r). Every locked-in 1–6 seed shows
//   100% in the R1 column, so the column reads as "did this team make the
//   bracket at all" and widens with round. teamReachPct is indexed by
//   reach-level [≥1, ≥2, ≥3, ≥4, ≥5]; cumulative reads [0..3].
// - "exact": P(team won round r, i.e. advanced past it). Reads [1..4] — the
//   final column is "won the championship". Numbers strictly decrease
//   across rounds.
//
// The prior mixed display (rostered teams showed a manager-conditional win
// metric while unrostered showed team-advancement) is dropped because the
// two metrics were not comparable across the same column.
export type LeaderboardMode = "cumulative" | "exact";

// Gradient palette ported from NCAAM draft-win-probability — 9 slots cycling.
const GRADIENT_PALETTE = [
  "from-rose-500/70 to-red-700/70",
  "from-sky-500/70 to-blue-700/70",
  "from-emerald-500/70 to-green-700/70",
  "from-amber-500/70 to-yellow-700/70",
  "from-violet-500/70 to-purple-700/70",
  "from-pink-500/70 to-fuchsia-700/70",
  "from-cyan-500/70 to-teal-700/70",
  "from-orange-500/70 to-red-600/70",
  "from-teal-400/70 to-emerald-600/70",
];

export function SimulatorLeaderboard({
  managerProjections,
  exposure,
  rosters,
  simData,
  viewerUserId,
}: {
  managerProjections: ManagerProjection[];
  exposure: TeamExposureResult | null;
  rosters: Array<{
    userId: string;
    name: string;
    players: Array<{ playerId: string; playerName: string; playerTeam: string; totalPoints: number }>;
  }>;
  simData: SimData | null;
  viewerUserId?: string;
}) {
  const [mode, setMode] = useState<LeaderboardMode>("cumulative");

  const sorted = [...managerProjections].sort(
    (a, b) => b.winProbability - a.winProbability,
  );
  const maxWin = sorted[0]?.winProbability ?? 1;

  // Build team→(conference, seed) lookup so we can sort by conf then seed.
  // Cover both the bracket abbrev (e.g. "NY") and its alias (e.g. "NYK") so
  // lookups work regardless of which form the exposure row carries.
  const teamOrder = (() => {
    const m = new Map<string, { conf: "east" | "west"; seed: number }>();
    if (!simData) return m;
    const aliases = simData.bracket.teamAliases ?? {};
    const put = (team: string, conf: "east" | "west", seed: number) => {
      m.set(team, { conf, seed });
      const aliased = aliases[team];
      if (aliased) m.set(aliased, { conf, seed });
    };
    for (const [seed, team] of simData.bracket.eastSeeds) put(team, "east", seed);
    for (const [seed, team] of simData.bracket.westSeeds) put(team, "west", seed);
    return m;
  })();

  // Build the full playoff team list in display order: East 1→8, then West 1→8.
  // We show ALL teams per manager — teams with zero rostered players display a
  // dash for the round cells. This keeps every manager's card aligned so you
  // can scan conference-by-conference without teams disappearing.
  const allTeamsInOrder: Array<{ team: string; conf: "east" | "west"; seed: number }> = (() => {
    if (!simData) return [];
    const out: Array<{ team: string; conf: "east" | "west"; seed: number }> = [];
    for (const [seed, team] of simData.bracket.eastSeeds) out.push({ team, conf: "east", seed });
    for (const [seed, team] of simData.bracket.westSeeds) out.push({ team, conf: "west", seed });
    return out;
  })();

  const fillRows = (rows: TeamExposureRow[]): TeamExposureRow[] => {
    // Index existing rows by team abbrev (plus aliased form) so exposure rows
    // land on the right seeded slot regardless of which abbrev the sim emits.
    const aliases = simData?.bracket.teamAliases ?? {};
    const byTeam = new Map<string, TeamExposureRow>();
    for (const r of rows) {
      byTeam.set(r.team, r);
      const aliased = aliases[r.team];
      if (aliased) byTeam.set(aliased, r);
    }
    const reachMap = exposure?.teamReachPctByTeam;
    return allTeamsInOrder.map(({ team }) => {
      const existing = byTeam.get(team);
      if (existing) return existing;
      // Unrostered teams still show the team's own advancement probability
      // (P(team reaches round r)) so managers can see how every playoff team is
      // trending, even teams they have no exposure to.
      const reach =
        reachMap?.get(team) ??
        (aliases[team] ? reachMap?.get(aliases[team]) : undefined) ??
        [];
      return {
        team,
        playerCount: 0,
        playerNames: [],
        winByRound: [null, null, null, null, null],
        baseWin: 0,
        teamReachPct: reach,
      };
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-2 text-[11px]">
        <span className="text-gray-500 dark:text-gray-400">Round odds</span>
        <div className="inline-flex rounded-full border border-gray-300 bg-white p-0.5 dark:border-gray-600 dark:bg-gray-800">
          <button
            type="button"
            onClick={() => setMode("cumulative")}
            className={cn(
              "rounded-full px-2.5 py-0.5 transition-colors",
              mode === "cumulative"
                ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900"
                : "text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white",
            )}
            title="P(team reaches this round). Top-6 seeds show 100% in R1."
          >
            Cumulative
          </button>
          <button
            type="button"
            onClick={() => setMode("exact")}
            className={cn(
              "rounded-full px-2.5 py-0.5 transition-colors",
              mode === "exact"
                ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900"
                : "text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white",
            )}
            title="P(team wins this round and advances). Finals column is the championship."
          >
            Exact
          </button>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
      {sorted.map((mp, idx) => {
        const roster = rosters.find((r) => r.userId === mp.userId);
        const rows = fillRows(exposure?.rowsByManager.get(mp.userId) ?? []);
        const isViewer = mp.userId === viewerUserId;
        const gradient = GRADIENT_PALETTE[idx % GRADIENT_PALETTE.length];
        return (
          <div
            key={mp.userId}
            className={cn(
              "rounded-xl bg-gradient-to-br text-white shadow-sm overflow-hidden",
              gradient,
              isViewer && "ring-2 ring-amber-300/80",
            )}
          >
            <div className="p-3 space-y-2">
              {/* Header: rank · name · win% */}
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-bold truncate">
                  {idx + 1}. {mp.name}
                  {isViewer ? " (you)" : ""}
                </span>
                <span className="text-[11px] tabular-nums text-white/80 font-medium shrink-0">
                  {(mp.winProbability * 100).toFixed(1)}%
                </span>
              </div>

              {/* Probability bar (relative to leader so differences are visible) */}
              <div className="h-1.5 rounded-full bg-white/15 overflow-hidden">
                <div
                  className="h-full rounded-full bg-white/60"
                  style={{
                    width: `${Math.max(2, (mp.winProbability / Math.max(maxWin, 0.0001)) * 100)}%`,
                  }}
                />
              </div>

              {/* Summary line */}
              <div className="flex items-center justify-between text-[10px] text-white/70">
                <span>
                  {mp.mean.toFixed(0)} avg · σ {mp.stddev.toFixed(0)}
                </span>
                <span>
                  p10 {mp.p10.toFixed(0)} · p90 {mp.p90.toFixed(0)}
                </span>
              </div>

              {/* Team exposure matrix — ALL teams with exposure, east-first by seed. */}
              {rows.length > 0 ? (
                <div className="pt-1 border-t border-white/15">
                  <div className="grid grid-cols-[auto_auto_repeat(4,minmax(0,1fr))] gap-x-1.5 gap-y-0.5 items-center text-[10px]">
                    <span className="text-white/50 uppercase tracking-wider col-span-2">
                      Team
                    </span>
                    {ROUND_LABELS.map((r) => (
                      <span key={r} className="text-white/50 uppercase text-center">
                        {r}
                      </span>
                    ))}
                    {rows.map((row) => (
                      <TeamExposureRowCells key={row.team} row={row} mode={mode} />
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-[10px] text-white/60 italic">
                  No rostered players on playoff teams.
                </p>
              )}

              {/* Roster list — compact */}
              {roster && roster.players.length > 0 ? (
                <div className="pt-1 border-t border-white/15">
                  <div className="flex flex-wrap gap-1">
                    {roster.players.slice(0, 10).map((p) => (
                      <span
                        key={p.playerId}
                        className="text-[10px] bg-white/10 rounded px-1.5 py-0.5 truncate max-w-[140px]"
                        title={p.playerName}
                      >
                        {p.playerName.split(/\s+/).slice(-1)[0]}
                      </span>
                    ))}
                    {roster.players.length > 10 ? (
                      <span className="text-[10px] text-white/60 py-0.5">
                        +{roster.players.length - 10}
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
}

function TeamExposureRowCells({
  row,
  mode,
}: {
  row: TeamExposureRow;
  mode: LeaderboardMode;
}) {
  // teamReachPct is indexed by reach-level [≥1, ≥2, ≥3, ≥4, ≥5].
  // - cumulative: slice(0, 4) = P(reached round 1..4) — R1 column is 100%
  //   for every locked-in seed, so it reads as "made the bracket".
  // - exact: slice(1, 5) = P(won round 1..4) — the Finals cell is the
  //   championship win probability.
  const unrostered = row.playerCount === 0;
  const cells =
    mode === "cumulative" ? row.teamReachPct.slice(0, 4) : row.teamReachPct.slice(1, 5);
  return (
    <>
      <span className="flex items-center gap-1 min-w-0">
        <TeamLogo team={row.team} size={14} />
      </span>
      <span className="text-[10px] font-medium truncate">
        {row.team}
        <span className="text-white/50 ml-0.5">×{row.playerCount}</span>
      </span>
      {cells.map((v, i) => {
        if (v == null) {
          return (
            <span key={i} className="text-center tabular-nums text-[10px] text-white/30">
              –
            </span>
          );
        }
        const cls = unrostered ? "text-white/40" : "text-white/85 font-medium";
        return (
          <span key={i} className={cn("text-center tabular-nums text-[10px]", cls)}>
            {(v * 100).toFixed(0)}
          </span>
        );
      })}
    </>
  );
}
