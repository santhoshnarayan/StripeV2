"use client";

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

  const sortRows = (rows: TeamExposureRow[]): TeamExposureRow[] => {
    return rows.slice().sort((a, b) => {
      const ao = teamOrder.get(a.team);
      const bo = teamOrder.get(b.team);
      if (!ao && !bo) return a.team.localeCompare(b.team);
      if (!ao) return 1;
      if (!bo) return -1;
      if (ao.conf !== bo.conf) return ao.conf === "east" ? -1 : 1;
      return ao.seed - bo.seed;
    });
  };

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {sorted.map((mp, idx) => {
        const roster = rosters.find((r) => r.userId === mp.userId);
        const rows = sortRows(exposure?.rowsByManager.get(mp.userId) ?? []);
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
                      <TeamExposureRowCells key={row.team} row={row} />
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
  );
}

function TeamExposureRowCells({ row }: { row: TeamExposureRow }) {
  // Drop the "Champ" column: show R1..Finals only (winByRound indices 0..3).
  const cells = row.winByRound.slice(0, 4);
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
        const delta = v != null ? v - row.baseWin : null;
        const cls =
          v == null
            ? "text-white/30"
            : delta! > 0.005
            ? "text-emerald-200 font-semibold"
            : delta! < -0.005
            ? "text-rose-200"
            : "text-white/70";
        return (
          <span key={i} className={cn("text-center tabular-nums text-[10px]", cls)}>
            {v == null ? "–" : `${(v * 100).toFixed(0)}`}
          </span>
        );
      })}
    </>
  );
}
