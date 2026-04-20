"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  type ForceMap,
  type SlotKey,
} from "@/lib/sim/whatif";
import { SERIES_KEYS, type SeriesKey, type SimData, type SimResults } from "@/lib/sim";

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

/** A series counts as "real-world decided" when ≥99.5% of baseline sims agree
 *  on the winner — the live-game injector pins the result, so consensus = lock. */
const DECIDED_THRESHOLD = 0.995;

function computeDecidedWinners(results: SimResults): Partial<Record<SeriesKey, number>> {
  const out: Partial<Record<SeriesKey, number>> = {};
  for (const k of SERIES_KEYS) {
    const arr = results.seriesWinners[k];
    if (!arr || arr.length === 0) continue;
    const counts = new Map<number, number>();
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v === 0xff) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    let bestIdx = -1;
    let bestN = 0;
    for (const [idx, n] of counts) {
      if (n > bestN) {
        bestN = n;
        bestIdx = idx;
      }
    }
    if (bestIdx >= 0 && bestN / arr.length >= DECIDED_THRESHOLD) out[k] = bestIdx;
  }
  return out;
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
  placeholderHint,
  ariaLabel,
}: {
  seed: number;
  team: string;
  fullName?: string;
  pct?: number | null;
  forced?: boolean;
  faded?: boolean;
  onClick?: () => void;
  placeholderHint?: string;
  ariaLabel?: string;
}) {
  const isTBD = team === "TBD" || team === "Play-In" || team === "?";
  const interactive = !!onClick && !isTBD;
  const baseClasses = [
    "flex items-center gap-1.5 px-2 transition-colors",
    interactive ? "cursor-pointer" : "cursor-default",
    forced
      ? "bg-emerald-500/20 text-foreground"
      : isTBD
        ? "bg-muted/20 text-muted-foreground/70"
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
      {isTBD ? (
        <span className="truncate text-[11px] italic text-muted-foreground/70">
          {placeholderHint ?? "TBD"}
        </span>
      ) : (
        <span className="truncate text-xs font-medium">{team}</span>
      )}
      {!isTBD && (
        <span className="ml-auto truncate text-[10px] tabular-nums text-muted-foreground">
          {pct != null ? `${pct.toFixed(0)}%` : (fullName ?? "")}
        </span>
      )}
    </button>
  );
}

/** Inline picker shown in place of a "TBD" competitor row. Lists every team
 *  that has ever won `upstreamKey` in the baseline sims, with frequency.
 *  Picking a team forces `upstreamKey` to that team — the slot then fills. */
function TBDPicker({
  results,
  upstreamKey,
  onPick,
  placeholderHint,
}: {
  results: SimResults;
  upstreamKey: SeriesKey;
  onPick: (teamIdx: number) => void;
  placeholderHint?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const options = useMemo(() => {
    const arr = results.seriesWinners[upstreamKey];
    if (!arr) return [] as Array<{ idx: number; team: string; pct: number }>;
    const counts = new Map<number, number>();
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v === 0xff) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const total = arr.length;
    return [...counts.entries()]
      .map(([idx, n]) => ({ idx, team: results.teamNames[idx] ?? "?", pct: (n / total) * 100 }))
      .sort((a, b) => b.pct - a.pct);
  }, [results, upstreamKey]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative" style={{ width: "100%" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2 transition-colors cursor-pointer bg-muted/20 text-muted-foreground/80 hover:bg-muted/60"
        style={{ height: CELL_H }}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="w-4 shrink-0" />
        <span className="truncate text-[11px] italic">{placeholderHint ?? "Pick team…"}</span>
        <span className="ml-auto text-[10px] text-muted-foreground">▾</span>
      </button>
      {open ? (
        <div
          className="absolute left-0 top-full z-50 mt-0.5 max-h-64 overflow-y-auto rounded-md border border-border bg-popover shadow-lg"
          style={{ width: BOX_W }}
          role="listbox"
        >
          {options.length === 0 ? (
            <div className="px-2 py-1.5 text-[11px] italic text-muted-foreground">
              No eligible teams
            </div>
          ) : (
            options.map((o) => (
              <button
                key={o.idx}
                type="button"
                role="option"
                className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-muted/60"
                onClick={() => {
                  onPick(o.idx);
                  setOpen(false);
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={teamLogoUrl(o.team)} alt="" width={14} height={14} className="shrink-0" />
                <span className="truncate font-medium text-foreground">{o.team}</span>
                <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">
                  {o.pct.toFixed(0)}%
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function SlotBox({
  slotKey,
  higher,
  lower,
  higherUpstreamKey,
  lowerUpstreamKey,
  results,
  forces,
  decided,
  mask,
  onForce,
}: {
  slotKey: SeriesKey;
  higher: { seed: number; team: string } | null;
  lower: { seed: number; team: string } | null;
  /** Series whose winner fills the higher position. When null, this is an R1
   *  slot whose competitors are seeded directly (no upstream — TBD impossible). */
  higherUpstreamKey?: SeriesKey;
  lowerUpstreamKey?: SeriesKey;
  results: SimResults | null;
  forces: ForceMap;
  decided: Partial<Record<SeriesKey, number>>;
  mask: Uint8Array | null;
  onForce: (slot: SlotKey, teamIdx: number | null) => void;
}) {
  const decidedIdx = decided[slotKey];
  const isDecided = decidedIdx != null;
  // A "decided" slot is locked — show the real-world winner, no override.
  const forced = forces[slotKey];
  const effectiveForced = isDecided ? decidedIdx : forced;

  const teamIdx = (team: string): number | null => {
    if (!results) return null;
    const i = results.teamIndex.get(team);
    return i ?? null;
  };

  const higherShown = higher ?? { seed: 0, team: "TBD" };
  const lowerShown = lower ?? { seed: 0, team: "TBD" };
  const higherIdx = higher ? teamIdx(higher.team) : null;
  const lowerIdx = lower ? teamIdx(lower.team) : null;
  const isHigherForced = effectiveForced != null && effectiveForced === higherIdx;
  const isLowerForced = effectiveForced != null && effectiveForced === lowerIdx;

  // Conditional pct: % of *surviving* (mask) sims where each team won this
  // slot. Uses mask so values reflect current force constraints — not baseline.
  const slotArr = results?.seriesWinners[slotKey];
  const totalSims = results?.numSims ?? 0;
  let higherWins = 0;
  let lowerWins = 0;
  let surviving = 0;
  if (slotArr && mask) {
    for (let i = 0; i < totalSims; i++) {
      if (!mask[i]) continue;
      surviving++;
      if (higherIdx != null && slotArr[i] === higherIdx) higherWins++;
      else if (lowerIdx != null && slotArr[i] === lowerIdx) lowerWins++;
    }
  }
  // Display pct as fraction of surviving sims (so "DET 75% / CLE 5%" tells you
  // 20% of the time the matchup wasn't even DET vs CLE).
  const higherPct = higherIdx != null && surviving > 0 ? (higherWins / surviving) * 100 : null;
  const lowerPct = lowerIdx != null && surviving > 0 ? (lowerWins / surviving) * 100 : null;

  return (
    <div
      className="overflow-visible rounded-md border border-border bg-card"
      style={{ width: BOX_W }}
    >
      {higher == null && higherUpstreamKey && results ? (
        <TBDPicker
          results={results}
          upstreamKey={higherUpstreamKey}
          onPick={(idx) => onForce(higherUpstreamKey, idx)}
          placeholderHint="Click to pick"
        />
      ) : (
        <CompetitorRow
          seed={higherShown.seed}
          team={higherShown.team}
          pct={higherPct}
          forced={isHigherForced}
          faded={effectiveForced != null && !isHigherForced}
          onClick={
            !isDecided && higherIdx != null
              ? () => onForce(slotKey, isHigherForced ? null : higherIdx)
              : undefined
          }
          ariaLabel={`force ${higherShown.team} to win ${slotKey}`}
        />
      )}
      <div className="border-t border-border" />
      {lower == null && lowerUpstreamKey && results ? (
        <TBDPicker
          results={results}
          upstreamKey={lowerUpstreamKey}
          onPick={(idx) => onForce(lowerUpstreamKey, idx)}
          placeholderHint="Click to pick"
        />
      ) : (
        <CompetitorRow
          seed={lowerShown.seed}
          team={lowerShown.team}
          pct={lowerPct}
          forced={isLowerForced}
          faded={effectiveForced != null && !isLowerForced}
          onClick={
            !isDecided && lowerIdx != null
              ? () => onForce(slotKey, isLowerForced ? null : lowerIdx)
              : undefined
          }
          ariaLabel={`force ${lowerShown.team} to win ${slotKey}`}
        />
      )}
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

/** Returns the team that won an upstream series — only if the user forced it
 *  or it's already real-world decided. Otherwise null (downstream slot stays
 *  blank until the user advances something). */
function derivedWinner(
  results: SimResults,
  upstreamKey: SeriesKey,
  forces: ForceMap,
  decided: Partial<Record<SeriesKey, number>>,
  defaultPair: SeedPair,
): { seed: number; team: string } | null {
  const idx = decided[upstreamKey] ?? forces[upstreamKey];
  if (idx == null) return null;
  const team = results.teamNames[idx] ?? "?";
  const seed = team === defaultPair.higher.team
    ? defaultPair.higher.seed
    : team === defaultPair.lower.team
      ? defaultPair.lower.seed
      : 0;
  return { seed, team };
}

/** Same shape as derivedWinner but for slots whose own winner could already
 *  be decided/forced (used for CF→Finals derivation where defaultPair is just
 *  the cf box content). */
function derivedSlotWinner(
  results: SimResults,
  key: SeriesKey,
  forces: ForceMap,
  decided: Partial<Record<SeriesKey, number>>,
): { seed: number; team: string } | null {
  const idx = decided[key] ?? forces[key];
  if (idx == null) return null;
  return { seed: 0, team: results.teamNames[idx] ?? "?" };
}

function ConferenceBracket({
  conf,
  seeds,
  results,
  forces,
  decided,
  mask,
  onForce,
  flip,
}: {
  conf: "east" | "west";
  seeds: [number, string][];
  results: SimResults | null;
  forces: ForceMap;
  decided: Partial<Record<SeriesKey, number>>;
  mask: Uint8Array | null;
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

  // R2 derives strictly from forced/decided R1 winners — blank otherwise.
  // Standard NBA bracket halves (matches engine: top=1v8×4v5, bot=2v7×3v6).
  // Top half: r1.1v8 (top) vs r1.4v5 (bottom).
  // Bot half: r1.3v6 (top) vs r1.2v7 (bottom) — keeps R1 column visually 1,4,3,2.
  const r2TopHigherKey = r1Pairs[0].key; // r1.1v8
  const r2TopLowerKey = r1Pairs[1].key;  // r1.4v5
  const r2BotHigherKey = r1Pairs[2].key; // r1.3v6
  const r2BotLowerKey = r1Pairs[3].key;  // r1.2v7
  const r2Top = results
    ? {
        higher: derivedWinner(results, r2TopHigherKey, forces, decided, r1Pairs[0].pair),
        lower: derivedWinner(results, r2TopLowerKey, forces, decided, r1Pairs[1].pair),
      }
    : { higher: null, lower: null };
  const r2Bot = results
    ? {
        higher: derivedWinner(results, r2BotHigherKey, forces, decided, r1Pairs[2].pair),
        lower: derivedWinner(results, r2BotLowerKey, forces, decided, r1Pairs[3].pair),
      }
    : { higher: null, lower: null };

  // CF derives from R2 top/bot winners (each may be forced, decided, or blank).
  const cfHigher = results ? derivedSlotWinner(results, r2Key(conf, "top"), forces, decided) : null;
  const cfLower = results ? derivedSlotWinner(results, r2Key(conf, "bot"), forces, decided) : null;

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
            decided={decided}
            mask={mask}
            onForce={onForce}
          />
        </div>
      ))}
    </div>
  );

  const r2Col = (
    <div className="flex flex-col justify-around" style={{ height: totalH }}>
      {[
        { key: r2Key(conf, "top"), pair: r2Top, hKey: r2TopHigherKey, lKey: r2TopLowerKey },
        { key: r2Key(conf, "bot"), pair: r2Bot, hKey: r2BotHigherKey, lKey: r2BotLowerKey },
      ].map(({ key, pair, hKey, lKey }) => (
        <div key={key} className="flex items-center" style={{ height: SLOT_H * 2 }}>
          <SlotBox
            slotKey={key}
            higher={pair.higher}
            lower={pair.lower}
            higherUpstreamKey={hKey}
            lowerUpstreamKey={lKey}
            results={results}
            forces={forces}
            decided={decided}
            mask={mask}
            onForce={onForce}
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
          higherUpstreamKey={r2Key(conf, "top")}
          lowerUpstreamKey={r2Key(conf, "bot")}
          results={results}
          forces={forces}
          decided={decided}
          mask={mask}
          onForce={onForce}
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

  const decidedWinners = useMemo(
    () => (simResults ? computeDecidedWinners(simResults) : {}),
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
                decided={decidedWinners}
                mask={mask}
                onForce={updateForce}
              />
              <FinalsColumn
                results={simResults}
                forces={forces}
                decided={decidedWinners}
                mask={mask}
                onForce={updateForce}
                champion={champTeam}
              />
              <ConferenceBracket
                conf="east"
                seeds={simData.bracket.eastSeeds}
                results={simResults}
                forces={forces}
                decided={decidedWinners}
                mask={mask}
                onForce={updateForce}
                flip
              />
            </div>
          </div>
          {/* Play-in dropdowns intentionally omitted: by the time the user
              opens the Simulator the play-in is finished and 7/8 seeds are
              baked into bracket.eastSeeds/westSeeds. */}
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
  decided,
  mask,
  onForce,
  champion,
}: {
  results: SimResults;
  forces: ForceMap;
  decided: Partial<Record<SeriesKey, number>>;
  mask: Uint8Array | null;
  onForce: (slot: SlotKey, teamIdx: number | null) => void;
  champion: string | null;
}) {
  // Finals matchup: derived strictly from cf.east + cf.west winners.
  // Blank until each conference final is forced or decided.
  const westTeam = derivedSlotWinner(results, "cf.west" as SeriesKey, forces, decided);
  const eastTeam = derivedSlotWinner(results, "cf.east" as SeriesKey, forces, decided);

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
        higher={westTeam}
        lower={eastTeam}
        higherUpstreamKey={"cf.west" as SeriesKey}
        lowerUpstreamKey={"cf.east" as SeriesKey}
        results={results}
        forces={forces}
        decided={decided}
        mask={mask}
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
