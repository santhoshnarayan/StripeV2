"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { SimData, PlayerAdjustment, InjuryEntry } from "@/lib/sim";

interface AdjustmentsViewProps {
  simData: SimData;
  adjustments: PlayerAdjustment[];
  injuries: Record<string, InjuryEntry>;
  onUpdateAdjustment: (espnId: string, field: string, value: number | null) => void;
  onResetAdjustments: () => void;
}

export function AdjustmentsView({
  simData,
  adjustments,
  injuries,
  onUpdateAdjustment,
  onResetAdjustments,
}: AdjustmentsViewProps) {
  const [teamFilter, setTeamFilter] = useState("all");

  const adjustmentsByEspnId = useMemo(
    () => new Map(adjustments.map((a) => [a.espn_id, a])),
    [adjustments],
  );

  // Get all playoff teams
  const playoffTeams = useMemo(() => {
    const teams: Array<{ team: string; conference: string; seed: number }> = [];
    for (const [seed, team] of simData.bracket.westSeeds) {
      teams.push({ team, conference: "West", seed });
    }
    for (const [seed, team] of simData.bracket.eastSeeds) {
      teams.push({ team, conference: "East", seed });
    }
    return teams;
  }, [simData.bracket]);

  // Group players by team, filtered
  const playersByTeam = useMemo(() => {
    const grouped: Record<string, typeof simData.simPlayers> = {};
    for (const p of simData.simPlayers) {
      if (!grouped[p.team]) grouped[p.team] = [];
      grouped[p.team].push(p);
    }
    // Sort each team's players by MPG descending
    for (const team of Object.keys(grouped)) {
      grouped[team].sort((a, b) => b.mpg - a.mpg);
    }
    return grouped;
  }, [simData.simPlayers]);

  const visibleTeams =
    teamFilter === "all"
      ? playoffTeams
      : playoffTeams.filter((t) => t.team === teamFilter);

  const activeAdjustmentCount = adjustments.filter(
    (a) => a.o_lebron_delta !== 0 || a.d_lebron_delta !== 0 || a.minutes_override != null,
  ).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select
          className="h-8 appearance-none rounded-lg border border-input bg-background px-3 pr-8 text-sm"
          value={teamFilter}
          onChange={(e) => setTeamFilter(e.target.value)}
        >
          <option value="all">All Teams</option>
          {playoffTeams.map((t) => (
            <option key={t.team} value={t.team}>
              {t.conference} {t.seed} — {t.team}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">
          {activeAdjustmentCount} active adjustments
        </span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={onResetAdjustments}
        >
          Reset to Defaults
        </Button>
      </div>

      {visibleTeams.map((teamInfo) => {
        const players = playersByTeam[teamInfo.team] ?? [];
        if (players.length === 0) return null;

        return (
          <Card key={teamInfo.team}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                {teamInfo.conference} {teamInfo.seed} — {teamInfo.team}{" "}
                <span className="font-normal text-muted-foreground">
                  {simData.bracket.teamFullNames[teamInfo.team] ?? ""}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto rounded-lg border border-border/80">
                <table className="w-full text-left text-sm">
                  <thead className="bg-muted/30 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-3 py-1.5 text-left font-medium">Player</th>
                      <th className="px-3 py-1.5 text-right font-medium">MPG</th>
                      <th className="px-3 py-1.5 text-right font-medium">PPG</th>
                      <th className="px-3 py-1.5 text-right font-medium">LEBRON</th>
                      <th className="px-3 py-1.5 text-right font-medium">O-LEB Δ</th>
                      <th className="px-3 py-1.5 text-right font-medium">D-LEB Δ</th>
                      <th className="px-3 py-1.5 text-right font-medium">Adj Total</th>
                      <th className="px-3 py-1.5 text-right font-medium">Mins Override</th>
                    </tr>
                  </thead>
                  <tbody>
                    {players.map((player) => {
                      const adj = adjustmentsByEspnId.get(player.espn_id);
                      const oDelta = adj?.o_lebron_delta ?? 0;
                      const dDelta = adj?.d_lebron_delta ?? 0;
                      const totalDelta = oDelta + dDelta;
                      const hasAdj = oDelta !== 0 || dDelta !== 0;
                      const injuryInfo = (injuries ?? {})[player.name];

                      return (
                        <tr
                          key={player.espn_id}
                          className={[
                            "border-t border-border/60",
                            hasAdj ? "bg-amber-500/5" : "",
                            injuryInfo ? "opacity-70" : "",
                          ].join(" ")}
                        >
                          <td className="px-3 py-1.5">
                            <span className="font-medium text-foreground">
                              {player.name}
                            </span>
                            {injuryInfo ? (
                              <span className="ml-1.5 text-[10px] text-red-500">
                                {injuryInfo.status}
                              </span>
                            ) : null}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                            {player.mpg.toFixed(1)}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                            {player.ppg.toFixed(1)}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-foreground">
                            {(player.lebron + totalDelta).toFixed(2)}
                          </td>
                          <td className="px-3 py-1.5 text-right">
                            <Input
                              type="number"
                              step={0.5}
                              value={oDelta || ""}
                              placeholder="0"
                              onChange={(e) =>
                                onUpdateAdjustment(
                                  player.espn_id,
                                  "o_lebron_delta",
                                  e.target.value ? Number(e.target.value) : 0,
                                )
                              }
                              className="ml-auto h-6 w-16 text-right tabular-nums text-xs"
                            />
                          </td>
                          <td className="px-3 py-1.5 text-right">
                            <Input
                              type="number"
                              step={0.5}
                              value={dDelta || ""}
                              placeholder="0"
                              onChange={(e) =>
                                onUpdateAdjustment(
                                  player.espn_id,
                                  "d_lebron_delta",
                                  e.target.value ? Number(e.target.value) : 0,
                                )
                              }
                              className="ml-auto h-6 w-16 text-right tabular-nums text-xs"
                            />
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {totalDelta !== 0 ? (
                              <span
                                className={
                                  totalDelta > 0
                                    ? "font-medium text-emerald-700 dark:text-emerald-300"
                                    : "font-medium text-red-700 dark:text-red-300"
                                }
                              >
                                {totalDelta > 0 ? "+" : ""}
                                {totalDelta.toFixed(1)}
                              </span>
                            ) : (
                              <span className="text-muted-foreground/50">—</span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                            {adj?.minutes_override ?? "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
