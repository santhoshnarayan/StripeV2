"use client";

import { useMemo } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { InjuryEntry } from "@/lib/sim";

const ROUND_LABELS = ["P1", "P2", "R1", "R1", "R1", "R1", "R1", "R1", "R1", "R2", "R2", "R2", "R2", "R2", "R2", "R2", "CF", "CF", "CF", "CF", "CF", "CF", "CF", "F", "F", "F", "F", "F", "F", "F"];
const ROUND_SHORT = ["PI", "PI", "R1×7", "", "", "", "", "", "", "R2×7", "", "", "", "", "", "", "CF×7", "", "", "", "", "", "", "F×7"];

function statusColor(status: string) {
  switch (status) {
    case "out":
      return "bg-red-500/15 text-red-700 dark:text-red-300";
    case "doubtful":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
    case "questionable":
      return "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300";
    case "probable":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function availColor(prob: number): string {
  if (prob <= 0) return "text-red-700 dark:text-red-300";
  if (prob < 0.3) return "text-red-600 dark:text-red-400";
  if (prob < 0.7) return "text-amber-700 dark:text-amber-300";
  if (prob < 1) return "text-emerald-700 dark:text-emerald-300";
  return "text-foreground";
}

interface InjuriesViewProps {
  injuries: Record<string, InjuryEntry>;
}

export function InjuriesView({ injuries }: InjuriesViewProps) {
  const entries = useMemo(() => {
    const result: Array<{
      name: string;
      team: string;
      status: string;
      injury: string;
      availability: number[];
      avgAvailability: number;
    }> = [];
    for (const [name, entry] of Object.entries(injuries ?? {})) {
      if (name === "_meta") continue;
      const avg =
        entry.availability.length > 0
          ? entry.availability.reduce((s: number, v: number) => s + v, 0) /
            entry.availability.length
          : 1;
      result.push({
        name,
        team: entry.team,
        status: entry.status,
        injury: entry.injury,
        availability: entry.availability,
        avgAvailability: avg,
      });
    }
    result.sort((a, b) => a.avgAvailability - b.avgAvailability);
    return result;
  }, [injuries]);

  if (entries.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          No injury data available.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Injury Report</CardTitle>
        <CardDescription>
          {entries.length} players with injury designations. Per-game
          availability probabilities across play-in and playoff rounds.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-xl border border-border/80">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="sticky left-0 z-10 bg-muted/40 px-3 py-2 text-left font-medium">
                  Player
                </th>
                <th className="px-3 py-2 text-left font-medium">Team</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Avg</th>
                <th className="px-2 py-2 text-center font-medium">PI</th>
                <th className="px-2 py-2 text-center font-medium">R1</th>
                <th className="px-2 py-2 text-center font-medium">R2</th>
                <th className="px-2 py-2 text-center font-medium">CF</th>
                <th className="px-2 py-2 text-center font-medium">Finals</th>
                <th className="px-3 py-2 text-left font-medium">Injury</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                // Summarize availability by round: avg of each round's games
                const piAvg =
                  entry.availability.length >= 2
                    ? (entry.availability[0] + entry.availability[1]) / 2
                    : null;
                const r1Avg = avgSlice(entry.availability, 2, 9);
                const r2Avg = avgSlice(entry.availability, 9, 16);
                const cfAvg = avgSlice(entry.availability, 16, 23);
                const fAvg = avgSlice(entry.availability, 23, 30);

                return (
                  <tr key={entry.name} className="border-t border-border/60">
                    <td className="sticky left-0 z-10 bg-background px-3 py-2 font-medium text-foreground">
                      {entry.name}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {entry.team}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${statusColor(entry.status)}`}
                      >
                        {entry.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <span className={availColor(entry.avgAvailability)}>
                        {(entry.avgAvailability * 100).toFixed(0)}%
                      </span>
                    </td>
                    <AvailCell value={piAvg} />
                    <AvailCell value={r1Avg} />
                    <AvailCell value={r2Avg} />
                    <AvailCell value={cfAvg} />
                    <AvailCell value={fAvg} />
                    <td className="max-w-xs truncate px-3 py-2 text-xs text-muted-foreground">
                      {entry.injury}
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
}

function avgSlice(arr: number[], start: number, end: number): number | null {
  if (arr.length < start) return null;
  const slice = arr.slice(start, Math.min(end, arr.length));
  if (slice.length === 0) return null;
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

function AvailCell({ value }: { value: number | null }) {
  if (value === null) {
    return (
      <td className="px-2 py-2 text-center tabular-nums text-muted-foreground/50">
        —
      </td>
    );
  }
  const pct = Math.round(value * 100);
  return (
    <td className={`px-2 py-2 text-center tabular-nums ${availColor(value)}`}>
      {pct}%
    </td>
  );
}
