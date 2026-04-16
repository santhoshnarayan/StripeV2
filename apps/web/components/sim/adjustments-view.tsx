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
  const [searchQuery, setSearchQuery] = useState("");

  const adjustmentsByEspnId = useMemo(
    () => new Map(adjustments.map((a) => [a.espn_id, a])),
    [adjustments],
  );

  // Build a merged list: all playoff-team players with their adjustments + injury status
  const playoffTeams = new Set([
    ...simData.bracket.eastSeeds.map(([, t]) => t),
    ...(simData.bracket.eastPlayin ?? []).map(([, t]) => t),
    ...simData.bracket.westSeeds.map(([, t]) => t),
    ...(simData.bracket.westPlayin ?? []).map(([, t]) => t),
  ]);

  const injuryEntries = useMemo(() => {
    const entries: Array<{
      name: string;
      team: string;
      status: string;
      injury: string;
      avgAvailability: number;
    }> = [];
    for (const [name, entry] of Object.entries(injuries)) {
      if (name === "_meta") continue;
      const avg =
        entry.availability.length > 0
          ? entry.availability.reduce((s, v) => s + v, 0) / entry.availability.length
          : 1;
      entries.push({
        name,
        team: entry.team,
        status: entry.status,
        injury: entry.injury,
        avgAvailability: avg,
      });
    }
    entries.sort((a, b) => a.avgAvailability - b.avgAvailability);
    return entries;
  }, [injuries]);

  const adjustedPlayers = useMemo(() => {
    return adjustments.filter(
      (a) => a.o_lebron_delta !== 0 || a.d_lebron_delta !== 0 || a.minutes_override != null,
    );
  }, [adjustments]);

  const query = searchQuery.trim().toLowerCase();

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <CardTitle>Rating Adjustments</CardTitle>
            <CardDescription>
              Playoff LEBRON rating overrides. These deltas are added to the
              player&apos;s base LEBRON for the simulation.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={onResetAdjustments}>
            Reset to Defaults
          </Button>
        </CardHeader>
        <CardContent>
          {adjustedPlayers.length > 0 ? (
            <div className="overflow-x-auto rounded-xl border border-border/80">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Player</th>
                    <th className="px-3 py-2 text-left font-medium">Team</th>
                    <th className="px-3 py-2 text-right font-medium">O-LEB Δ</th>
                    <th className="px-3 py-2 text-right font-medium">D-LEB Δ</th>
                    <th className="px-3 py-2 text-right font-medium">Total Δ</th>
                    <th className="px-3 py-2 text-right font-medium">Mins Override</th>
                  </tr>
                </thead>
                <tbody>
                  {adjustedPlayers.map((adj) => (
                    <tr key={adj.espn_id} className="border-t border-border/60">
                      <td className="px-3 py-2 font-medium text-foreground">
                        {adj.name}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{adj.team}</td>
                      <td className="px-3 py-2 text-right">
                        <Input
                          type="number"
                          step={0.5}
                          value={adj.o_lebron_delta}
                          onChange={(e) =>
                            onUpdateAdjustment(adj.espn_id, "o_lebron_delta", Number(e.target.value))
                          }
                          className="h-7 w-20 text-right tabular-nums ml-auto"
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Input
                          type="number"
                          step={0.5}
                          value={adj.d_lebron_delta}
                          onChange={(e) =>
                            onUpdateAdjustment(adj.espn_id, "d_lebron_delta", Number(e.target.value))
                          }
                          className="h-7 w-20 text-right tabular-nums ml-auto"
                        />
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-medium text-foreground">
                        {(adj.o_lebron_delta + adj.d_lebron_delta) > 0 ? "+" : ""}
                        {(adj.o_lebron_delta + adj.d_lebron_delta).toFixed(1)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {adj.minutes_override ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No rating adjustments configured. All players use base LEBRON ratings.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Injury Report</CardTitle>
          <CardDescription>
            {injuryEntries.length} players with injury designations. Availability
            shows the average per-game probability of playing across all playoff rounds.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {injuryEntries.length > 0 ? (
            <div className="overflow-x-auto rounded-xl border border-border/80">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Player</th>
                    <th className="px-3 py-2 text-left font-medium">Team</th>
                    <th className="px-3 py-2 text-left font-medium">Status</th>
                    <th className="px-3 py-2 text-left font-medium">Injury</th>
                    <th className="px-3 py-2 text-right font-medium">Avg Avail.</th>
                  </tr>
                </thead>
                <tbody>
                  {injuryEntries.map((entry) => (
                    <tr key={entry.name} className="border-t border-border/60">
                      <td className="px-3 py-2 font-medium text-foreground">
                        {entry.name}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{entry.team}</td>
                      <td className="px-3 py-2">
                        <span
                          className={[
                            "inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase",
                            entry.status === "out"
                              ? "bg-red-500/15 text-red-700 dark:text-red-300"
                              : entry.status === "doubtful"
                                ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                                : entry.status === "questionable"
                                  ? "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300"
                                  : "bg-muted text-muted-foreground",
                          ].join(" ")}
                        >
                          {entry.status}
                        </span>
                      </td>
                      <td className="max-w-xs truncate px-3 py-2 text-xs text-muted-foreground">
                        {entry.injury}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <span
                          className={
                            entry.avgAvailability < 0.3
                              ? "font-semibold text-red-700 dark:text-red-300"
                              : entry.avgAvailability < 0.7
                                ? "text-amber-700 dark:text-amber-300"
                                : "text-foreground"
                          }
                        >
                          {(entry.avgAvailability * 100).toFixed(0)}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No injury data available.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
