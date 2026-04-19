"use client";

import { useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TeamLogo, PlayerAvatar } from "@/components/sim/player-avatar";
import {
  computeMask,
  maskCount,
  computeConditionalTeams,
  computeConditionalPlayers,
  computeSlotOptions,
  type ForceMap,
  type SlotKey,
} from "@/lib/sim/whatif";
import type { SimResults } from "@/lib/sim";

interface WhatIfTabProps {
  simResults: SimResults | null;
  simulating: boolean;
  progress: number;
}

interface SlotGroup {
  label: string;
  rows: { key: SlotKey; label: string }[];
}

const SLOT_GROUPS: SlotGroup[] = [
  {
    label: "Play-In",
    rows: [
      { key: "east7", label: "East 7" },
      { key: "east8", label: "East 8" },
      { key: "west7", label: "West 7" },
      { key: "west8", label: "West 8" },
    ],
  },
  {
    label: "Round 1",
    rows: [
      { key: "r1.east.1v8", label: "East 1 vs 8" },
      { key: "r1.east.4v5", label: "East 4 vs 5" },
      { key: "r1.east.3v6", label: "East 3 vs 6" },
      { key: "r1.east.2v7", label: "East 2 vs 7" },
      { key: "r1.west.1v8", label: "West 1 vs 8" },
      { key: "r1.west.4v5", label: "West 4 vs 5" },
      { key: "r1.west.3v6", label: "West 3 vs 6" },
      { key: "r1.west.2v7", label: "West 2 vs 7" },
    ],
  },
  {
    label: "Round 2",
    rows: [
      { key: "r2.east.top", label: "East Top (1/8 vs 4/5)" },
      { key: "r2.east.bot", label: "East Bot (3/6 vs 2/7)" },
      { key: "r2.west.top", label: "West Top (1/8 vs 4/5)" },
      { key: "r2.west.bot", label: "West Bot (3/6 vs 2/7)" },
    ],
  },
  {
    label: "Conf Finals",
    rows: [
      { key: "cf.east", label: "East CF" },
      { key: "cf.west", label: "West CF" },
    ],
  },
  {
    label: "Finals",
    rows: [{ key: "finals", label: "NBA Finals" }],
  },
];

export function WhatIfTab({ simResults, simulating, progress }: WhatIfTabProps) {
  const [forces, setForces] = useState<ForceMap>({});

  const slotOptions = useMemo(
    () => (simResults ? computeSlotOptions(simResults) : null),
    [simResults],
  );
  const mask = useMemo(
    () => (simResults ? computeMask(simResults, forces) : null),
    [simResults, forces],
  );
  const surviving = mask ? maskCount(mask) : 0;
  const condTeams = useMemo(
    () => (simResults && mask ? computeConditionalTeams(simResults, mask) : []),
    [simResults, mask],
  );
  const condPlayers = useMemo(
    () => (simResults && mask ? computeConditionalPlayers(simResults, mask) : []),
    [simResults, mask],
  );

  const sortedTeams = useMemo(
    () =>
      [...condTeams].sort(
        (a, b) =>
          b.cond.finals - a.cond.finals
          || b.cond.cf - a.cond.cf
          || b.cond.r2 - a.cond.r2
          || b.cond.r1 - a.cond.r1,
      ),
    [condTeams],
  );
  const sortedPlayers = useMemo(
    () =>
      [...condPlayers]
        .sort((a, b) => b.conditionalPoints - a.conditionalPoints)
        .slice(0, 200),
    [condPlayers],
  );

  if (!simResults) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        {simulating
          ? `Running simulation... ${Math.round(progress * 100)}%`
          : "Run a simulation to use the What-If conditioning tool."}
      </div>
    );
  }

  const totalSims = simResults.numSims;
  const survivingPct = totalSims > 0 ? (surviving / totalSims) * 100 : 0;
  const forcedCount = Object.keys(forces).filter((k) => forces[k as SlotKey] != null).length;
  const noSurvivors = surviving === 0;

  const updateForce = (key: SlotKey, value: number | null) => {
    setForces((prev) => {
      const next = { ...prev };
      if (value == null) delete next[key];
      else next[key] = value;
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>What-If Bracket Conditioning</CardTitle>
              <CardDescription>
                Force one or more series outcomes. Tables below recompute over the
                surviving sims (no re-simulation required).
              </CardDescription>
            </div>
            <div className="flex flex-col items-end gap-1 text-right">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                Surviving sims
              </div>
              <div
                className={[
                  "text-2xl font-semibold tabular-nums",
                  noSurvivors ? "text-destructive" : "text-foreground",
                ].join(" ")}
              >
                {surviving.toLocaleString()}
                <span className="text-base text-muted-foreground"> / {totalSims.toLocaleString()}</span>
              </div>
              <div className="text-xs text-muted-foreground tabular-nums">
                {survivingPct.toFixed(2)}% • {forcedCount} forced
              </div>
              {forcedCount > 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setForces({})}
                >
                  Reset
                </Button>
              ) : null}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {noSurvivors ? (
            <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              No sims match these constraints. Loosen forces or reset.
            </div>
          ) : null}
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {SLOT_GROUPS.map((group) => (
              <div key={group.label} className="rounded-lg border border-border/80 p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </div>
                <div className="space-y-1.5">
                  {group.rows.map(({ key, label }) => {
                    const opts = slotOptions?.[key] ?? [];
                    const forced = forces[key];
                    return (
                      <div key={key} className="flex items-center gap-2">
                        <label className="w-32 shrink-0 text-xs text-muted-foreground">
                          {label}
                        </label>
                        <select
                          className="h-7 flex-1 appearance-none rounded-md border border-input bg-background px-2 text-xs"
                          value={forced ?? ""}
                          onChange={(e) =>
                            updateForce(
                              key,
                              e.target.value === "" ? null : Number(e.target.value),
                            )
                          }
                        >
                          <option value="">Auto</option>
                          {opts.map((o) => (
                            <option key={o.teamIdx} value={o.teamIdx}>
                              {o.team} ({o.pct.toFixed(1)}%)
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Teams — Conditional Advancement</CardTitle>
            <CardDescription>% of {surviving.toLocaleString()} surviving sims that win each round.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-xl border border-border/80">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Team</th>
                    <th className="px-3 py-2 text-right font-medium">Seed</th>
                    <th className="px-3 py-2 text-right font-medium">R1%</th>
                    <th className="px-3 py-2 text-right font-medium">R2%</th>
                    <th className="px-3 py-2 text-right font-medium">CF%</th>
                    <th className="px-3 py-2 text-right font-medium">Champ%</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedTeams.map((t) => (
                    <tr key={t.team} className="border-t border-border/60">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <TeamLogo team={t.team} size={20} />
                          <span className="font-medium text-foreground">{t.team}</span>
                          <span className="text-xs text-muted-foreground truncate">
                            {t.fullName}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {t.seed ?? "PI"}
                      </td>
                      <CondPctCell cond={t.cond.r1} base={t.base.r1} />
                      <CondPctCell cond={t.cond.r2} base={t.base.r2} />
                      <CondPctCell cond={t.cond.cf} base={t.base.cf} />
                      <CondPctCell cond={t.cond.finals} base={t.base.finals} bold />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Players — Conditional Projected Points</CardTitle>
            <CardDescription>
              Mean fantasy pts over surviving sims vs baseline. Top 200 by conditional points.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-xl border border-border/80">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-right font-medium">#</th>
                    <th className="px-3 py-2 text-left font-medium">Player</th>
                    <th className="px-3 py-2 text-left font-medium">Team</th>
                    <th className="px-3 py-2 text-right font-medium">Base</th>
                    <th className="px-3 py-2 text-right font-medium">Cond</th>
                    <th className="px-3 py-2 text-right font-medium">Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedPlayers.map((p, idx) => (
                    <tr key={p.espnId} className="border-t border-border/60">
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {idx + 1}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <PlayerAvatar espnId={p.espnId} team={p.team} size={24} />
                          <span className="font-medium text-foreground">{p.name}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        <div className="flex items-center gap-1.5">
                          <TeamLogo team={p.team} size={16} />
                          {p.team}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {p.baselinePoints.toFixed(0)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-medium text-foreground">
                        {p.conditionalPoints.toFixed(0)}
                      </td>
                      <DeltaCell delta={p.delta} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function CondPctCell({ cond, base, bold }: { cond: number; base: number; bold?: boolean }) {
  const opacity = Math.min(1, cond / 50);
  const delta = cond - base;
  const showDelta = Math.abs(delta) >= 0.5;
  return (
    <td className="px-3 py-2 text-right tabular-nums">
      <div className="flex items-center justify-end gap-1.5">
        {showDelta ? (
          <span
            className={[
              "text-[10px] tabular-nums",
              delta > 0 ? "text-emerald-500" : "text-red-500",
            ].join(" ")}
          >
            {delta > 0 ? "+" : ""}
            {delta.toFixed(0)}
          </span>
        ) : null}
        <span
          className={[
            "inline-block min-w-[3rem] rounded-md px-1.5 py-0.5",
            bold ? "font-semibold" : "font-normal",
            cond > 0 ? "text-foreground" : "text-muted-foreground/50",
          ].join(" ")}
          style={
            cond > 0
              ? {
                  backgroundColor: `color-mix(in oklch, var(--bid-green-bg), transparent ${Math.round((1 - opacity) * 100)}%)`,
                }
              : undefined
          }
        >
          {cond > 0 ? cond.toFixed(1) : "—"}
        </span>
      </div>
    </td>
  );
}

function DeltaCell({ delta }: { delta: number }) {
  const abs = Math.abs(delta);
  const significant = abs >= 1;
  return (
    <td className="px-3 py-2 text-right tabular-nums">
      <span
        className={[
          "tabular-nums",
          !significant
            ? "text-muted-foreground/50"
            : delta > 0
              ? "text-emerald-500"
              : "text-red-500",
        ].join(" ")}
      >
        {!significant ? "—" : `${delta > 0 ? "+" : ""}${delta.toFixed(0)}`}
      </span>
    </td>
  );
}
