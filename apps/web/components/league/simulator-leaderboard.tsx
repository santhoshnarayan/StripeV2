"use client";

import { TeamLogo } from "@/components/sim/player-avatar";
import { cn } from "@/lib/utils";
import type {
  ManagerProjection,
  TeamExposureResult,
} from "@/lib/sim";

const ROUND_LABELS = ["R1", "R2", "CF", "Finals", "Champ"] as const;

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
  viewerUserId,
}: {
  managerProjections: ManagerProjection[];
  exposure: TeamExposureResult | null;
  rosters: Array<{
    userId: string;
    name: string;
    players: Array<{ playerId: string; playerName: string; playerTeam: string; totalPoints: number }>;
  }>;
  viewerUserId?: string;
}) {
  const sorted = [...managerProjections].sort(
    (a, b) => b.winProbability - a.winProbability,
  );
  const maxWin = sorted[0]?.winProbability ?? 1;

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {sorted.map((mp, idx) => {
        const roster = rosters.find((r) => r.userId === mp.userId);
        const rows = exposure?.rowsByManager.get(mp.userId) ?? [];
        const topRows = rows
          .slice()
          .sort((a, b) => b.playerCount - a.playerCount)
          .slice(0, 3);
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

              {/* Team exposure matrix — top 3 teams by player count */}
              {topRows.length > 0 ? (
                <div className="pt-1 border-t border-white/15">
                  <div className="grid grid-cols-[auto_auto_repeat(5,minmax(0,1fr))] gap-x-1.5 gap-y-0.5 items-center text-[10px]">
                    <span className="text-white/50 uppercase tracking-wider col-span-2">
                      Team
                    </span>
                    {ROUND_LABELS.map((r) => (
                      <span key={r} className="text-white/50 uppercase text-center">
                        {r}
                      </span>
                    ))}
                    {topRows.map((row) => (
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

function TeamExposureRowCells({ row }: { row: { team: string; playerCount: number; winByRound: (number | null)[]; baseWin: number } }) {
  return (
    <>
      <span className="flex items-center gap-1 min-w-0">
        <TeamLogo team={row.team} size={14} />
      </span>
      <span className="text-[10px] font-medium truncate">
        {row.team}
        <span className="text-white/50 ml-0.5">×{row.playerCount}</span>
      </span>
      {row.winByRound.map((v, i) => {
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
