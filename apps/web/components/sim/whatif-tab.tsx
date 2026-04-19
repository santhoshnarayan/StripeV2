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
  computeConditionalManagers,
  computeSlotOptions,
  type ForceMap,
  type SlotKey,
} from "@/lib/sim/whatif";
import type { SeriesKey, SimData, SimResults } from "@/lib/sim";

interface RosterInputLite {
  userId: string;
  name: string;
  playerIds: string[];
}

interface WhatIfTabProps {
  simData: SimData | null;
  simResults: SimResults | null;
  simulating: boolean;
  progress: number;
  rosters?: RosterInputLite[];
  viewerUserId?: string;
}

type WhatIfSubTab = "players" | "teams" | "fantasy";

const TEAM_LOGO_OVERRIDES: Record<string, string> = {
  NY: "nyk",
  SA: "sa",
  GS: "gs",
  PHX: "phx",
};

function teamLogoUrl(team: string): string {
  const abbr = (TEAM_LOGO_OVERRIDES[team] ?? team).toLowerCase();
  return `https://cdn.espn.com/combiner/i?img=/i/teamlogos/nba/500/${abbr}.png&h=40&w=40`;
}

// ── Series-key helpers ────────────────────────────────────────────────

function r1Key(conf: "east" | "west", pair: "1v8" | "4v5" | "3v6" | "2v7"): SeriesKey {
  return `r1.${conf}.${pair}` as SeriesKey;
}

function r2Key(conf: "east" | "west", half: "top" | "bot"): SeriesKey {
  return `r2.${conf}.${half}` as SeriesKey;
}

const TEAMS_PER_SLOT_FALLBACK = 2;

function topTeamsForSlot(
  results: SimResults,
  key: SlotKey,
  excludeTeamIdx: Set<number> | null,
  count: number,
): Array<{ teamIdx: number; team: string; pct: number }> {
  const opts = computeSlotOptions(results)[key] ?? [];
  const filtered = excludeTeamIdx
    ? opts.filter((o) => !excludeTeamIdx.has(o.teamIdx))
    : opts;
  return filtered.slice(0, count);
}

// ── Bracket primitives (clickable) ────────────────────────────────────

const BOX_W = 180;
const CELL_H = 26;
const CONN_W = 16;
const SLOT_H = 76;

function CompetitorRow({
  seed,
  team,
  fullName,
  pct,
  forced,
  faded,
  onClick,
  ariaLabel,
}: {
  seed: number;
  team: string;
  fullName?: string;
  pct?: number | null;
  forced?: boolean;
  faded?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
}) {
  const isTBD = team === "TBD" || team === "Play-In" || team === "?";
  const interactive = !!onClick && !isTBD;
  const baseClasses = [
    "flex items-center gap-1.5 px-2 transition-colors",
    interactive ? "cursor-pointer" : "cursor-default",
    forced
      ? "bg-emerald-500/20 text-foreground"
      : faded
        ? "bg-transparent text-muted-foreground/60"
        : "bg-transparent hover:bg-muted/60 text-foreground",
  ].join(" ");
  return (
    <button
      type="button"
      onClick={interactive ? onClick : undefined}
      className={baseClasses}
      style={{ height: CELL_H, width: "100%" }}
      aria-label={ariaLabel ?? team}
      disabled={!interactive}
    >
      {seed > 0 && (
        <span className="w-4 shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {seed}
        </span>
      )}
      {!isTBD && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={teamLogoUrl(team)} alt="" width={16} height={16} className="shrink-0" />
      )}
      <span className="truncate text-xs font-medium">{team}</span>
      {!isTBD && (
        <span className="ml-auto truncate text-[10px] tabular-nums text-muted-foreground">
          {pct != null ? `${pct.toFixed(0)}%` : (fullName ?? "")}
        </span>
      )}
    </button>
  );
}

function SlotBox({
  slotKey,
  higher,
  lower,
  results,
  forces,
  onForce,
  flip,
}: {
  slotKey: SeriesKey;
  higher: { seed: number; team: string };
  lower: { seed: number; team: string };
  results: SimResults | null;
  forces: ForceMap;
  onForce: (slot: SlotKey, teamIdx: number | null) => void;
  flip?: boolean;
}) {
  const forced = forces[slotKey];
  const teamIdx = (team: string): number | null => {
    if (!results) return null;
    const i = results.teamIndex.get(team);
    return i ?? null;
  };
  const higherIdx = teamIdx(higher.team);
  const lowerIdx = teamIdx(lower.team);
  const isHigherForced = forced != null && forced === higherIdx;
  const isLowerForced = forced != null && forced === lowerIdx;

  // Conditional advance % for each team in this slot, computed cheaply from
  // baseline winners array (so the user sees how often each side wins).
  const slotArr = results?.seriesWinners[slotKey];
  const totalSims = results?.numSims ?? 0;
  let higherWins = 0;
  let lowerWins = 0;
  if (slotArr && higherIdx != null && lowerIdx != null) {
    for (let i = 0; i < totalSims; i++) {
      if (slotArr[i] === higherIdx) higherWins++;
      else if (slotArr[i] === lowerIdx) lowerWins++;
    }
  }
  const denom = higherWins + lowerWins;
  const higherPct = denom > 0 ? (higherWins / denom) * 100 : null;
  const lowerPct = denom > 0 ? (lowerWins / denom) * 100 : null;

  return (
    <div
      className="overflow-hidden rounded-md border border-border bg-card"
      style={{ width: BOX_W }}
    >
      <CompetitorRow
        seed={higher.seed}
        team={higher.team}
        pct={higherPct}
        forced={isHigherForced}
        faded={forced != null && !isHigherForced}
        onClick={
          higherIdx != null
            ? () => onForce(slotKey, isHigherForced ? null : higherIdx)
            : undefined
        }
        ariaLabel={`${flip ? "" : ""}force ${higher.team} to win ${slotKey}`}
      />
      <div className="border-t border-border" />
      <CompetitorRow
        seed={lower.seed}
        team={lower.team}
        pct={lowerPct}
        forced={isLowerForced}
        faded={forced != null && !isLowerForced}
        onClick={
          lowerIdx != null
            ? () => onForce(slotKey, isLowerForced ? null : lowerIdx)
            : undefined
        }
        ariaLabel={`force ${lower.team} to win ${slotKey}`}
      />
    </div>
  );
}

function Connectors({
  count,
  slotH,
  flip,
}: {
  count: number;
  slotH: number;
  flip?: boolean;
}) {
  const h = count * slotH;
  const pairs = count / 2;
  const paths: string[] = [];
  for (let i = 0; i < pairs; i++) {
    const topY = (i * 2 + 0.5) * slotH;
    const botY = (i * 2 + 1.5) * slotH;
    const midY = (topY + botY) / 2;
    const hw = CONN_W / 2;
    if (flip) {
      paths.push(`M ${CONN_W} ${topY} H ${hw} V ${midY} H 0`);
      paths.push(`M ${CONN_W} ${botY} H ${hw} V ${midY}`);
    } else {
      paths.push(`M 0 ${topY} H ${hw} V ${midY} H ${CONN_W}`);
      paths.push(`M 0 ${botY} H ${hw} V ${midY}`);
    }
  }
  return (
    <svg width={CONN_W} height={h} className="shrink-0">
      {paths.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke="currentColor"
          className="text-border"
          strokeWidth={1.5}
        />
      ))}
    </svg>
  );
}

// ── Conference + bracket builder ──────────────────────────────────────

interface SeedPair {
  higher: { seed: number; team: string };
  lower: { seed: number; team: string };
}

function pickFromForceOrSlot(
  results: SimResults,
  forcedR1: SeriesKey,
  fallbackSlot: SeriesKey,
  excludeIdx: Set<number>,
  forces: ForceMap,
  defaultPair: SeedPair,
): { seed: number; team: string } {
  const forcedTeamIdx = forces[forcedR1];
  if (forcedTeamIdx != null) {
    const team = results.teamNames[forcedTeamIdx] ?? "?";
    const seed = team === defaultPair.higher.team
      ? defaultPair.higher.seed
      : team === defaultPair.lower.team
        ? defaultPair.lower.seed
        : 0;
    return { seed, team };
  }
  const top = topTeamsForSlot(results, fallbackSlot, excludeIdx, TEAMS_PER_SLOT_FALLBACK)[0];
  if (top) return { seed: 0, team: top.team };
  return { seed: 0, team: "TBD" };
}

function ConferenceBracket({
  conf,
  seeds,
  results,
  forces,
  onForce,
  flip,
}: {
  conf: "east" | "west";
  seeds: [number, string][];
  results: SimResults | null;
  forces: ForceMap;
  onForce: (slot: SlotKey, teamIdx: number | null) => void;
  flip?: boolean;
}) {
  const seed7: [number, string] = [7, seeds.find(([s]) => s === 7)?.[1] ?? "Play-In"];
  const seed8: [number, string] = [8, seeds.find(([s]) => s === 8)?.[1] ?? "Play-In"];

  const r1Pairs: Array<{ key: SeriesKey; pair: SeedPair }> = [
    {
      key: r1Key(conf, "1v8"),
      pair: { higher: { seed: seeds[0][0], team: seeds[0][1] }, lower: { seed: seed8[0], team: seed8[1] } },
    },
    {
      key: r1Key(conf, "4v5"),
      pair: { higher: { seed: seeds[3][0], team: seeds[3][1] }, lower: { seed: seeds[4][0], team: seeds[4][1] } },
    },
    {
      key: r1Key(conf, "3v6"),
      pair: { higher: { seed: seeds[2][0], team: seeds[2][1] }, lower: { seed: seeds[5][0], team: seeds[5][1] } },
    },
    {
      key: r1Key(conf, "2v7"),
      pair: { higher: { seed: seeds[1][0], team: seeds[1][1] }, lower: { seed: seed7[0], team: seed7[1] } },
    },
  ];

  // R2 derived: top half = (1v8 winner) vs (4v5 winner); bot half = (3v6 winner) vs (2v7 winner)
  const r2Top = results
    ? {
        higher: pickFromForceOrSlot(
          results,
          r1Pairs[0].key,
          r2Key(conf, "top"),
          new Set(),
          forces,
          r1Pairs[0].pair,
        ),
        lower: pickFromForceOrSlot(
          results,
          r1Pairs[1].key,
          r2Key(conf, "top"),
          new Set(),
          forces,
          r1Pairs[1].pair,
        ),
      }
    : { higher: { seed: 0, team: "TBD" }, lower: { seed: 0, team: "TBD" } };
  const r2Bot = results
    ? {
        higher: pickFromForceOrSlot(
          results,
          r1Pairs[2].key,
          r2Key(conf, "bot"),
          new Set(),
          forces,
          r1Pairs[2].pair,
        ),
        lower: pickFromForceOrSlot(
          results,
          r1Pairs[3].key,
          r2Key(conf, "bot"),
          new Set(),
          forces,
          r1Pairs[3].pair,
        ),
      }
    : { higher: { seed: 0, team: "TBD" }, lower: { seed: 0, team: "TBD" } };

  // CF derived: r2.top winner vs r2.bot winner.
  const cfHigher = results
    ? pickFromForceOrSlot(results, r2Key(conf, "top"), `cf.${conf}` as SeriesKey, new Set(), forces, r2Top)
    : { seed: 0, team: "TBD" };
  const cfLower = results
    ? pickFromForceOrSlot(results, r2Key(conf, "bot"), `cf.${conf}` as SeriesKey, new Set(), forces, r2Bot)
    : { seed: 0, team: "TBD" };

  const totalH = r1Pairs.length * SLOT_H;

  const r1Col = (
    <div className="flex flex-col justify-around" style={{ height: totalH }}>
      {r1Pairs.map(({ key, pair }) => (
        <div key={key} className="flex items-center" style={{ height: SLOT_H }}>
          <SlotBox
            slotKey={key}
            higher={pair.higher}
            lower={pair.lower}
            results={results}
            forces={forces}
            onForce={onForce}
            flip={flip}
          />
        </div>
      ))}
    </div>
  );

  const r2Col = (
    <div className="flex flex-col justify-around" style={{ height: totalH }}>
      {[
        { key: r2Key(conf, "top"), pair: r2Top },
        { key: r2Key(conf, "bot"), pair: r2Bot },
      ].map(({ key, pair }) => (
        <div key={key} className="flex items-center" style={{ height: SLOT_H * 2 }}>
          <SlotBox
            slotKey={key}
            higher={pair.higher}
            lower={pair.lower}
            results={results}
            forces={forces}
            onForce={onForce}
            flip={flip}
          />
        </div>
      ))}
    </div>
  );

  const cfCol = (
    <div className="flex flex-col justify-around" style={{ height: totalH }}>
      <div className="flex items-center" style={{ height: SLOT_H * 4 }}>
        <SlotBox
          slotKey={`cf.${conf}` as SeriesKey}
          higher={cfHigher}
          lower={cfLower}
          results={results}
          forces={forces}
          onForce={onForce}
          flip={flip}
        />
      </div>
    </div>
  );

  const cols: React.ReactNode[] = [];
  cols.push(<div key="r1">{r1Col}</div>);
  cols.push(
    <Connectors key="c1" count={4} slotH={SLOT_H} flip={flip} />,
  );
  cols.push(<div key="r2">{r2Col}</div>);
  cols.push(
    <Connectors key="c2" count={2} slotH={SLOT_H * 2} flip={flip} />,
  );
  cols.push(<div key="cf">{cfCol}</div>);

  return (
    <div>
      <div className="mb-2 text-sm font-semibold text-foreground">
        {conf === "east" ? "Eastern" : "Western"} Conference
      </div>
      <div className={`flex items-stretch ${flip ? "flex-row-reverse" : ""}`}>{cols}</div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────

export function WhatIfTab({
  simData,
  simResults,
  simulating,
  progress,
  rosters,
  viewerUserId,
}: WhatIfTabProps) {
  const [forces, setForces] = useState<ForceMap>({});
  const [subTab, setSubTab] = useState<WhatIfSubTab>("teams");

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
  const condManagers = useMemo(
    () =>
      simResults && mask && rosters && rosters.length > 0
        ? computeConditionalManagers(simResults, mask, rosters)
        : [],
    [simResults, mask, rosters],
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
  const sortedManagers = useMemo(
    () => [...condManagers].sort((a, b) => b.conditionalWinPct - a.conditionalWinPct),
    [condManagers],
  );

  if (!simResults || !simData) {
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

  // Champion (Finals winner) — derived from r2.top vs r2.bot of each conf, then finals.
  const finalsForced = forces["finals"];
  const champTeam = finalsForced != null ? simResults.teamNames[finalsForced] : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>What-If Bracket Conditioning</CardTitle>
              <CardDescription>
                Click a team in any matchup to force them to win that series. Tables below
                recompute over the surviving sims (no re-simulation required).
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

          {/* Bracket */}
          <div className="overflow-x-auto pb-2">
            <div className="flex min-w-[1000px] items-start justify-center gap-6">
              <ConferenceBracket
                conf="west"
                seeds={simData.bracket.westSeeds}
                results={simResults}
                forces={forces}
                onForce={updateForce}
              />
              <FinalsColumn
                results={simResults}
                forces={forces}
                onForce={updateForce}
                champion={champTeam}
              />
              <ConferenceBracket
                conf="east"
                seeds={simData.bracket.eastSeeds}
                results={simResults}
                forces={forces}
                onForce={updateForce}
                flip
              />
            </div>
          </div>

          {/* Play-In selectors (kept compact since the play-in is a 4-team
              double-elimination — clickable matchup boxes don't map cleanly). */}
          {slotOptions ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {(["east7", "east8", "west7", "west8"] as const).map((k) => (
                <PlayInSelect
                  key={k}
                  slotKey={k}
                  label={
                    k === "east7" ? "East 7 seed"
                      : k === "east8" ? "East 8 seed"
                        : k === "west7" ? "West 7 seed"
                          : "West 8 seed"
                  }
                  options={slotOptions[k] ?? []}
                  forced={forces[k]}
                  onForce={updateForce}
                />
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Sub-tab nav */}
      <div className="flex flex-nowrap gap-1 overflow-x-auto">
        {([
          { id: "teams", label: "Teams" },
          { id: "players", label: "Players" },
          ...(rosters && rosters.length > 0
            ? [{ id: "fantasy" as WhatIfSubTab, label: "Fantasy Teams" }]
            : []),
        ] as const).map((t) => (
          <button
            key={t.id}
            type="button"
            className={[
              "shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
              subTab === t.id
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground",
            ].join(" ")}
            onClick={() => setSubTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subTab === "teams" ? (
        <Card>
          <CardHeader>
            <CardTitle>Teams — Conditional Advancement</CardTitle>
            <CardDescription>
              % of {surviving.toLocaleString()} surviving sims that win each round.
            </CardDescription>
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
      ) : null}

      {subTab === "players" ? (
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
      ) : null}

      {subTab === "fantasy" ? (
        <Card>
          <CardHeader>
            <CardTitle>Fantasy Teams — Conditional Win %</CardTitle>
            <CardDescription>
              How each manager&apos;s win probability and projected points shift under the
              forced bracket outcomes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {sortedManagers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No rostered players found for any manager.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border/80">
                <table className="w-full text-left text-sm">
                  <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-right font-medium">#</th>
                      <th className="px-3 py-2 text-left font-medium">Manager</th>
                      <th className="px-3 py-2 text-right font-medium">Base Win%</th>
                      <th className="px-3 py-2 text-right font-medium">Cond Win%</th>
                      <th className="px-3 py-2 text-right font-medium">Δ Win</th>
                      <th className="px-3 py-2 text-right font-medium">Base Pts</th>
                      <th className="px-3 py-2 text-right font-medium">Cond Pts</th>
                      <th className="px-3 py-2 text-right font-medium">Δ Pts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedManagers.map((m, idx) => {
                      const isViewer = m.userId === viewerUserId;
                      return (
                        <tr
                          key={m.userId}
                          className={[
                            "border-t border-border/60",
                            isViewer ? "bg-amber-50/50 dark:bg-amber-900/10" : "",
                          ].join(" ")}
                        >
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                            {idx + 1}
                          </td>
                          <td className="px-3 py-2 font-medium text-foreground">
                            {m.name}{isViewer ? " (you)" : ""}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                            {m.baselineWinPct.toFixed(1)}%
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums font-semibold text-foreground">
                            {m.conditionalWinPct.toFixed(1)}%
                          </td>
                          <DeltaCell delta={m.winDelta} suffix="pp" />
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                            {m.baselineMean.toFixed(0)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums font-medium text-foreground">
                            {m.conditionalMean.toFixed(0)}
                          </td>
                          <DeltaCell delta={m.meanDelta} />
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

// ── Finals column ─────────────────────────────────────────────────────

function FinalsColumn({
  results,
  forces,
  onForce,
  champion,
}: {
  results: SimResults;
  forces: ForceMap;
  onForce: (slot: SlotKey, teamIdx: number | null) => void;
  champion: string | null;
}) {
  // Finals matchup: cf.east winner vs cf.west winner. Use forces if present,
  // otherwise top-1 from each conference's CF series.
  const eastForced = forces["cf.east" as SeriesKey];
  const westForced = forces["cf.west" as SeriesKey];
  const eastTeam = eastForced != null
    ? results.teamNames[eastForced]
    : (topTeamsForSlot(results, "cf.east" as SeriesKey, null, 1)[0]?.team ?? "TBD");
  const westTeam = westForced != null
    ? results.teamNames[westForced]
    : (topTeamsForSlot(results, "cf.west" as SeriesKey, null, 1)[0]?.team ?? "TBD");

  return (
    <div
      className="flex flex-col items-center justify-center"
      style={{ height: SLOT_H * 4, paddingTop: SLOT_H * 1.25 }}
    >
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Finals
      </div>
      <SlotBox
        slotKey={"finals" as SeriesKey}
        higher={{ seed: 0, team: westTeam }}
        lower={{ seed: 0, team: eastTeam }}
        results={results}
        forces={forces}
        onForce={onForce}
      />
      <div className="mt-3 text-center">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Champion
        </div>
        <div
          className="rounded-md border-2 border-amber-400 bg-amber-50 px-4 py-2 text-sm font-bold text-foreground dark:bg-amber-900/20"
          style={{ width: BOX_W }}
        >
          {champion ?? "Click finals matchup to lock"}
        </div>
      </div>
    </div>
  );
}

// ── Play-In selector ──────────────────────────────────────────────────

function PlayInSelect({
  slotKey,
  label,
  options,
  forced,
  onForce,
}: {
  slotKey: SlotKey;
  label: string;
  options: Array<{ teamIdx: number; team: string; pct: number }>;
  forced?: number;
  onForce: (slot: SlotKey, teamIdx: number | null) => void;
}) {
  return (
    <div className="rounded-lg border border-border/80 p-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <select
        className="h-8 w-full appearance-none rounded-md border border-input bg-background px-2 text-xs"
        value={forced ?? ""}
        onChange={(e) =>
          onForce(slotKey, e.target.value === "" ? null : Number(e.target.value))
        }
      >
        <option value="">Auto (any team)</option>
        {options.map((o) => (
          <option key={o.teamIdx} value={o.teamIdx}>
            {o.team} ({o.pct.toFixed(1)}%)
          </option>
        ))}
      </select>
    </div>
  );
}

// ── Cell helpers ──────────────────────────────────────────────────────

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

function DeltaCell({ delta, suffix }: { delta: number; suffix?: string }) {
  const abs = Math.abs(delta);
  const significant = abs >= (suffix === "pp" ? 0.1 : 1);
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
        {!significant
          ? "—"
          : `${delta > 0 ? "+" : ""}${delta.toFixed(suffix === "pp" ? 1 : 0)}${suffix ?? ""}`}
      </span>
    </td>
  );
}
