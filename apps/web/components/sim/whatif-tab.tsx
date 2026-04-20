"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type ConditionalPlayerRow,
  type ForceMap,
  type SlotKey,
} from "@/lib/sim/whatif";
import {
  PLAYIN_KEYS,
  SERIES_KEYS,
  type LiveGameState,
  type PlayinKey,
  type PlayerAdjustment,
  type SeriesKey,
  type SimData,
  type SimResults,
} from "@/lib/sim";
import { AdjustmentsTab as ExploreAdjustmentsTab } from "@/components/sim/adjustments-tab-explore";
import { InjuriesView } from "@/components/sim/injuries-view";
import type { SimPlayer } from "@/lib/sim";

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
  // Adjustments editing context
  teamPlayers?: Record<string, SimPlayer[]>;
  adjustments?: Record<string, PlayerAdjustment>;
  defaultAdjustments?: Record<string, PlayerAdjustment>;
  playoffMpgByEspnId?: Record<string, number>;
  onUpdateAdjustment?: (espnId: string, update: Partial<PlayerAdjustment>) => void;
  onLoadAdjustments?: (adjs: Record<string, PlayerAdjustment>) => void;
  onResetAdjustments?: () => void;
  onRunSim?: () => void;
  adjustmentsDirty?: boolean;
}

type WhatIfSubTab = "players" | "teams" | "fantasy" | "ratings" | "adjustments" | "injuries";
type PlayerView = "simple" | "round" | "game";

const ROUND_LABELS = ["R1", "R2", "CF", "Finals"] as const;

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

/** A series counts as "real-world decided" only when a team has actually won
 *  4 games in the live data — i.e. the series is mathematically over in the
 *  real playoffs. We don't use a sim-consensus heuristic here because a big
 *  rating gap can push the sim to 99%+ on a series that's only 1-0, which
 *  would incorrectly auto-advance the favorite. */
const LEAGUE_AVG_RTG = 114;
type ScenarioId = "full" | "out" | "doubtful" | "questionable";
const SCENARIOS: { id: ScenarioId; label: string; excludesStatuses: Set<string> }[] = [
  { id: "full", label: "Full strength", excludesStatuses: new Set() },
  { id: "out", label: "Out", excludesStatuses: new Set(["out"]) },
  { id: "doubtful", label: "+ Doubtful", excludesStatuses: new Set(["out", "doubtful"]) },
  { id: "questionable", label: "+ Questionable", excludesStatuses: new Set(["out", "doubtful", "questionable"]) },
];

interface TeamRating {
  ortg: number;
  drtg: number;
  net: number;
}

function computeTeamRatingForScenario(
  teamPlayers: SimPlayer[],
  baselineMpgByNbaId: Record<string, number>,
  excludedNamesLower: Set<string>,
): TeamRating {
  const active = teamPlayers.filter((p) => !excludedNamesLower.has(p.name.toLowerCase()));
  let totalBase = 0;
  for (const p of active) {
    totalBase += baselineMpgByNbaId[p.nba_id] ?? p.mpg ?? 0;
  }
  if (totalBase <= 0) return { ortg: LEAGUE_AVG_RTG, drtg: LEAGUE_AVG_RTG, net: 0 };
  const scale = 240 / totalBase;
  let oAdj = 0;
  let dAdj = 0;
  for (const p of active) {
    const mins = (baselineMpgByNbaId[p.nba_id] ?? p.mpg ?? 0) * scale;
    oAdj += (p.o_lebron * mins) / 48;
    dAdj += (p.d_lebron * mins) / 48;
  }
  const ortg = LEAGUE_AVG_RTG + oAdj;
  const drtg = LEAGUE_AVG_RTG - dAdj;
  return { ortg, drtg, net: ortg - drtg };
}

function computeDecidedWinners(
  results: SimResults,
  liveGames: LiveGameState[] | undefined,
): Partial<Record<SeriesKey, number>> {
  const out: Partial<Record<SeriesKey, number>> = {};
  if (!liveGames || liveGames.length === 0) return out;
  // tally postgame wins per (seriesKey, team)
  const winsByKey = new Map<string, Map<string, number>>();
  for (const g of liveGames) {
    if (g.status !== "post") continue;
    const winner = g.homeScore > g.awayScore ? g.homeTeam : g.awayTeam;
    let inner = winsByKey.get(g.seriesKey);
    if (!inner) {
      inner = new Map();
      winsByKey.set(g.seriesKey, inner);
    }
    inner.set(winner, (inner.get(winner) ?? 0) + 1);
  }
  for (const [seriesKey, inner] of winsByKey) {
    if (!SERIES_KEYS.includes(seriesKey as SeriesKey)) continue;
    for (const [team, wins] of inner) {
      if (wins < 4) continue;
      const idx = results.teamIndex.get(team);
      if (idx != null) out[seriesKey as SeriesKey] = idx;
      break;
    }
  }
  return out;
}

/** Play-in is locked at the engine level (when bracket.playinR2 is complete)
 *  → 100% of sims will have the same team in each play-in slot. Detect that
 *  here so sims with a different play-in seed get masked out. */
function computeDecidedPlayin(results: SimResults): Partial<Record<PlayinKey, number>> {
  const out: Partial<Record<PlayinKey, number>> = {};
  for (const k of PLAYIN_KEYS) {
    const arr = results.playinSeeds[k];
    if (!arr || arr.length === 0) continue;
    const first = arr[0];
    if (first === 0xff) continue;
    let allSame = true;
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] !== first) {
        allSame = false;
        break;
      }
    }
    if (allSame) out[k] = first;
  }
  return out;
}

/** "Real-world consistent" mask — sims where every decided series + decided
 *  play-in matches consensus. This is the correct denominator for "true odds"
 *  computations: stale paths (e.g. Orlando winning play-in when PHI actually
 *  did) get excluded so they can't show up as picker options or skew %s. */
function computeDecidedMask(
  results: SimResults,
  decidedSeries: Partial<Record<SeriesKey, number>>,
  decidedPlayin: Partial<Record<PlayinKey, number>>,
): Uint8Array {
  const N = results.numSims;
  const mask = new Uint8Array(N).fill(1);
  for (const k of SERIES_KEYS) {
    const want = decidedSeries[k];
    if (want == null) continue;
    const arr = results.seriesWinners[k];
    if (!arr) continue;
    for (let i = 0; i < N; i++) if (mask[i] && arr[i] !== want) mask[i] = 0;
  }
  for (const k of PLAYIN_KEYS) {
    const want = decidedPlayin[k];
    if (want == null) continue;
    const arr = results.playinSeeds[k];
    if (!arr) continue;
    for (let i = 0; i < N; i++) if (mask[i] && arr[i] !== want) mask[i] = 0;
  }
  return mask;
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
  endReserve,
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
  /** Reserve ~22px on the right so an overlaid SwapButton doesn't collide
   *  with the % cell. Set when SlotBox renders a ▾ swap affordance. */
  endReserve?: boolean;
}) {
  const isTBD = team === "TBD" || team === "Play-In" || team === "?";
  const interactive = !!onClick && !isTBD;
  const baseClasses = [
    "flex items-center gap-1.5 transition-colors",
    endReserve ? "pl-2 pr-6" : "px-2",
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

/** Bracket-structural list of every team that COULD reach `seriesKey`
 *  (regardless of sim probability). For example cf.west = all 8 west seeds,
 *  even if some never won the conference in 10k sims. */
function eligibleTeamsForSeries(simData: SimData, key: SeriesKey): string[] {
  const east = simData.bracket.eastSeeds.map(([, t]) => t);
  const west = simData.bracket.westSeeds.map(([, t]) => t);
  const seedT = (conf: "east" | "west", n: number) =>
    (conf === "east" ? east : west)[n - 1];
  const r1Teams = (conf: "east" | "west", pair: string) => {
    if (pair === "1v8") return [seedT(conf, 1), seedT(conf, 8)];
    if (pair === "4v5") return [seedT(conf, 4), seedT(conf, 5)];
    if (pair === "3v6") return [seedT(conf, 3), seedT(conf, 6)];
    if (pair === "2v7") return [seedT(conf, 2), seedT(conf, 7)];
    return [];
  };
  // r1.east.1v8 → east 1,8 ; r2.east.top → east 1,4,5,8 ; etc.
  if (key.startsWith("r1.")) {
    const [, conf, pair] = key.split(".");
    return r1Teams(conf as "east" | "west", pair);
  }
  if (key.startsWith("r2.")) {
    const [, conf, half] = key.split(".");
    const c = conf as "east" | "west";
    return half === "top"
      ? [...r1Teams(c, "1v8"), ...r1Teams(c, "4v5")]
      : [...r1Teams(c, "3v6"), ...r1Teams(c, "2v7")];
  }
  if (key === "cf.east") return east;
  if (key === "cf.west") return west;
  if (key === "finals") return [...east, ...west];
  return [];
}

/** Picker options for `upstreamKey`: every team that could reach the slot
 *  (from bracket structure), annotated with their baseline win % over the
 *  decided-mask sims. Teams that never won in any decided sim still appear
 *  with pct=0 — the user may want to force them anyway. */
function useUpstreamOptions(
  results: SimResults,
  simData: SimData,
  upstreamKey: SeriesKey,
  decidedMask: Uint8Array | null,
) {
  return useMemo(() => {
    const eligible = eligibleTeamsForSeries(simData, upstreamKey);
    const arr = results.seriesWinners[upstreamKey];
    const counts = new Map<number, number>();
    let total = 0;
    if (arr) {
      for (let i = 0; i < arr.length; i++) {
        if (decidedMask && !decidedMask[i]) continue;
        const v = arr[i];
        if (v === 0xff) continue;
        counts.set(v, (counts.get(v) ?? 0) + 1);
        total++;
      }
    }
    const opts: Array<{ idx: number; team: string; pct: number }> = [];
    for (const team of eligible) {
      const idx = results.teamIndex.get(team);
      if (idx == null) continue;
      const pct = total > 0 ? ((counts.get(idx) ?? 0) / total) * 100 : 0;
      opts.push({ idx, team, pct });
    }
    opts.sort((a, b) => b.pct - a.pct);
    return opts;
  }, [results, simData, upstreamKey, decidedMask]);
}

function PickerDropdown({
  options,
  currentIdx,
  onPick,
  onClear,
  onClose,
}: {
  options: Array<{ idx: number; team: string; pct: number }>;
  currentIdx: number | null;
  onPick: (idx: number) => void;
  /** When provided, renders a "Reset" item at the top of the dropdown that
   *  clears the underlying force on the upstream slot. */
  onClear?: () => void;
  onClose: () => void;
}) {
  // Viewport-aware: flip upward when there's not enough room below; clamp
  // max-h to whichever side has more space so the list stays scrollable
  // instead of being clipped by the page edge.
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ flip: boolean; maxH: number }>({
    flip: false,
    maxH: 256,
  });
  useEffect(() => {
    const el = ref.current;
    const trigger = el?.parentElement;
    if (!el || !trigger) return;
    const compute = () => {
      const rect = trigger.getBoundingClientRect();
      const vh = window.innerHeight;
      const spaceBelow = vh - rect.bottom - 8;
      const spaceAbove = rect.top - 8;
      const flip = spaceBelow < 200 && spaceAbove > spaceBelow;
      const maxH = Math.max(120, Math.min(384, flip ? spaceAbove : spaceBelow));
      setPlacement({ flip, maxH });
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, []);
  return (
    <div
      ref={ref}
      className={[
        "absolute left-0 z-50 overflow-y-auto rounded-md border border-border bg-popover shadow-lg",
        placement.flip ? "bottom-full mb-0.5" : "top-full mt-0.5",
      ].join(" ")}
      style={{ width: BOX_W, maxHeight: placement.maxH }}
      role="listbox"
    >
      {onClear ? (
        <button
          type="button"
          className="flex w-full items-center gap-1.5 border-b border-border/60 px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          onClick={() => {
            onClear();
            onClose();
          }}
        >
          <span className="w-3.5 shrink-0 text-center text-[11px]">×</span>
          <span className="truncate italic">Reset</span>
        </button>
      ) : null}
      {options.length === 0 ? (
        <div className="px-2 py-1.5 text-[11px] italic text-muted-foreground">
          No eligible teams
        </div>
      ) : (
        options.map((o) => {
          const isCurrent = currentIdx === o.idx;
          return (
            <button
              key={o.idx}
              type="button"
              role="option"
              aria-selected={isCurrent}
              className={[
                "flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-muted/60",
                isCurrent ? "bg-emerald-500/15 text-foreground" : "",
              ].join(" ")}
              onClick={() => {
                onPick(o.idx);
                onClose();
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={teamLogoUrl(o.team)} alt="" width={14} height={14} className="shrink-0" />
              <span className="truncate font-medium text-foreground">{o.team}</span>
              <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">
                {o.pct.toFixed(0)}%
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}

function TBDPicker({
  results,
  simData,
  upstreamKey,
  decidedMask,
  onPick,
  placeholderHint,
}: {
  results: SimResults;
  simData: SimData;
  upstreamKey: SeriesKey;
  decidedMask: Uint8Array | null;
  onPick: (teamIdx: number) => void;
  placeholderHint?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const options = useUpstreamOptions(results, simData, upstreamKey, decidedMask);

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
        <PickerDropdown
          options={options}
          currentIdx={null}
          onPick={onPick}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

/** Tiny ▾ icon overlaid on a filled CompetitorRow. Click opens a picker
 *  listing all teams eligible for `upstreamKey`; selecting one forces that
 *  upstream → swaps the team into this slot. Lets the user change a filled
 *  slot in a single click instead of toggle-off → re-pick. */
function SwapButton({
  results,
  simData,
  upstreamKey,
  decidedMask,
  currentIdx,
  hasForce,
  onPick,
  onClear,
}: {
  results: SimResults;
  simData: SimData;
  upstreamKey: SeriesKey;
  decidedMask: Uint8Array | null;
  currentIdx: number | null;
  /** Whether the upstream slot is currently user-forced. Reset is only
   *  meaningful when there's a force to clear. */
  hasForce: boolean;
  onPick: (teamIdx: number) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const options = useUpstreamOptions(results, simData, upstreamKey, decidedMask);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="absolute right-0 top-0">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="flex h-[26px] w-5 items-center justify-center text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/40"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="swap team"
      >
        ▾
      </button>
      {open ? (
        <PickerDropdown
          options={options}
          currentIdx={currentIdx}
          onPick={onPick}
          onClear={hasForce ? onClear : undefined}
          onClose={() => setOpen(false)}
        />
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
  simData,
  forces,
  decided,
  decidedMask,
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
  simData: SimData;
  forces: ForceMap;
  decided: Partial<Record<SeriesKey, number>>;
  /** Mask of sims that match real-world decided state (series + play-in).
   *  Used as denominator for slot pct so stale paths don't dilute the odds. */
  decidedMask: Uint8Array | null;
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

  // "True odds" pct: % of real-world-consistent sims (decidedMask) where each
  // team won this slot. Independent of user forces — but DOES exclude sims
  // that contradict play-in / live-game outcomes already in the books, so
  // teams that can no longer reach this slot don't appear here at all.
  const slotArr = results?.seriesWinners[slotKey];
  const N = results?.numSims ?? 0;
  let higherWins = 0;
  let lowerWins = 0;
  let denom = 0;
  if (slotArr) {
    for (let i = 0; i < N; i++) {
      if (decidedMask && !decidedMask[i]) continue;
      denom++;
      if (higherIdx != null && slotArr[i] === higherIdx) higherWins++;
      else if (lowerIdx != null && slotArr[i] === lowerIdx) lowerWins++;
    }
  }
  const higherPct = higherIdx != null && denom > 0 ? (higherWins / denom) * 100 : null;
  const lowerPct = lowerIdx != null && denom > 0 ? (lowerWins / denom) * 100 : null;

  return (
    <div
      className="overflow-visible rounded-md border border-border bg-card"
      style={{ width: BOX_W }}
    >
      {higher == null && higherUpstreamKey && results ? (
        <TBDPicker
          results={results}
          simData={simData}
          upstreamKey={higherUpstreamKey}
          decidedMask={decidedMask}
          onPick={(idx) => onForce(higherUpstreamKey, idx)}
          placeholderHint="Click to pick"
        />
      ) : (
        <div className="relative">
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
            endReserve={!isDecided && higher != null && !!higherUpstreamKey}
          />
          {!isDecided && higher != null && higherUpstreamKey && results ? (
            <SwapButton
              results={results}
              simData={simData}
              upstreamKey={higherUpstreamKey}
              decidedMask={decidedMask}
              currentIdx={higherIdx}
              hasForce={forces[higherUpstreamKey] != null}
              onPick={(idx) => onForce(higherUpstreamKey, idx)}
              onClear={() => onForce(higherUpstreamKey, null)}
            />
          ) : null}
        </div>
      )}
      <div className="border-t border-border" />
      {lower == null && lowerUpstreamKey && results ? (
        <TBDPicker
          results={results}
          simData={simData}
          upstreamKey={lowerUpstreamKey}
          decidedMask={decidedMask}
          onPick={(idx) => onForce(lowerUpstreamKey, idx)}
          placeholderHint="Click to pick"
        />
      ) : (
        <div className="relative">
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
            endReserve={!isDecided && lower != null && !!lowerUpstreamKey}
          />
          {!isDecided && lower != null && lowerUpstreamKey && results ? (
            <SwapButton
              results={results}
              simData={simData}
              upstreamKey={lowerUpstreamKey}
              decidedMask={decidedMask}
              currentIdx={lowerIdx}
              hasForce={forces[lowerUpstreamKey] != null}
              onPick={(idx) => onForce(lowerUpstreamKey, idx)}
              onClear={() => onForce(lowerUpstreamKey, null)}
            />
          ) : null}
        </div>
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
  simData,
  forces,
  decided,
  decidedMask,
  mask,
  onForce,
  flip,
}: {
  conf: "east" | "west";
  seeds: [number, string][];
  results: SimResults | null;
  simData: SimData;
  forces: ForceMap;
  decided: Partial<Record<SeriesKey, number>>;
  decidedMask: Uint8Array | null;
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
            simData={simData}
            forces={forces}
            decided={decided}
            decidedMask={decidedMask}
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
            simData={simData}
            forces={forces}
            decided={decided}
            decidedMask={decidedMask}
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
          simData={simData}
          forces={forces}
          decided={decided}
          decidedMask={decidedMask}
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

// ── Bracket path helpers (for upstream auto-fill) ─────────────────────

function seedToR1Pair(seed: number): "1v8" | "4v5" | "3v6" | "2v7" | null {
  if (seed === 1 || seed === 8) return "1v8";
  if (seed === 4 || seed === 5) return "4v5";
  if (seed === 3 || seed === 6) return "3v6";
  if (seed === 2 || seed === 7) return "2v7";
  return null;
}

function r1PairToR2Half(pair: "1v8" | "4v5" | "3v6" | "2v7"): "top" | "bot" {
  // Per engine: top=1v8×4v5 (Half A), bot=2v7×3v6 (Half B).
  return pair === "1v8" || pair === "4v5" ? "top" : "bot";
}

function findTeamConfAndSeed(
  team: string,
  simData: SimData,
): { conf: "east" | "west"; seed: number } | null {
  for (const [seed, t] of simData.bracket.eastSeeds) {
    if (t === team) return { conf: "east", seed };
  }
  for (const [seed, t] of simData.bracket.westSeeds) {
    if (t === team) return { conf: "west", seed };
  }
  return null;
}

/** All series upstream of `targetKey` that this team must also win to reach
 *  `targetKey` (excludes targetKey). Used by updateForce to auto-fill the
 *  prerequisite chain when the user picks a team for a downstream slot. */
function upstreamSeriesChain(
  team: string,
  targetKey: SeriesKey,
  simData: SimData,
): SeriesKey[] {
  const tcs = findTeamConfAndSeed(team, simData);
  if (!tcs) return [];
  const { conf, seed } = tcs;
  const pair = seedToR1Pair(seed);
  if (!pair) return [];
  const half = r1PairToR2Half(pair);
  const fullPath: SeriesKey[] = [
    `r1.${conf}.${pair}` as SeriesKey,
    `r2.${conf}.${half}` as SeriesKey,
    `cf.${conf}` as SeriesKey,
    "finals" as SeriesKey,
  ];
  const idx = fullPath.indexOf(targetKey);
  if (idx === -1) return [];
  return fullPath.slice(0, idx);
}

// ── Main component ────────────────────────────────────────────────────

export function WhatIfTab({
  simData,
  simResults,
  simulating,
  progress,
  rosters,
  viewerUserId,
  teamPlayers,
  adjustments,
  defaultAdjustments,
  playoffMpgByEspnId,
  onUpdateAdjustment,
  onLoadAdjustments,
  onResetAdjustments,
  onRunSim,
  adjustmentsDirty,
}: WhatIfTabProps) {
  const [forces, setForces] = useState<ForceMap>({});
  const [subTab, setSubTab] = useState<WhatIfSubTab>("teams");
  const [playerView, setPlayerView] = useState<PlayerView>("simple");
  const [teamsMode, setTeamsMode] = useState<"cumulative" | "exact">("cumulative");
  const [playerMetric, setPlayerMetric] = useState<"total" | "ppg" | "pplay">("total");
  const [playerProTeamFilter, setPlayerProTeamFilter] = useState<string>("all");
  const [playerManagerFilter, setPlayerManagerFilter] = useState<string>("all");
  type PlayerSortKey =
    | "cond"
    | "base"
    | "delta"
    | "r0"
    | "r1"
    | "r2"
    | "r3"
    | "total";
  const [playerSortKey, setPlayerSortKey] = useState<PlayerSortKey>("cond");
  const [playerSortDir, setPlayerSortDir] = useState<"asc" | "desc">("desc");
  const togglePlayerSort = useCallback(
    (key: PlayerSortKey) => {
      setPlayerSortKey((prev) => {
        if (prev === key) {
          setPlayerSortDir((d) => (d === "desc" ? "asc" : "desc"));
          return prev;
        }
        setPlayerSortDir("desc");
        return key;
      });
    },
    [],
  );

  const decidedWinners = useMemo(
    () =>
      simResults
        ? computeDecidedWinners(simResults, simData?.liveGames)
        : {},
    [simResults, simData?.liveGames],
  );
  const decidedPlayin = useMemo(
    () => (simResults ? computeDecidedPlayin(simResults) : {}),
    [simResults],
  );
  const decidedMask = useMemo(
    () =>
      simResults
        ? computeDecidedMask(simResults, decidedWinners, decidedPlayin)
        : null,
    [simResults, decidedWinners, decidedPlayin],
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
  const playerToManager = useMemo(() => {
    const map = new Map<string, { userId: string; name: string }>();
    if (!rosters) return map;
    for (const r of rosters) {
      for (const pid of r.playerIds) {
        map.set(pid, { userId: r.userId, name: r.name });
      }
    }
    return map;
  }, [rosters]);

  const proTeamOptions = useMemo(() => {
    const set = new Set<string>();
    for (const p of condPlayers) set.add(p.team);
    return Array.from(set).sort();
  }, [condPlayers]);

  const managerOptions = useMemo(() => {
    if (!rosters) return [];
    return rosters.map((r) => ({ userId: r.userId, name: r.name }));
  }, [rosters]);

  const filteredPlayers = useMemo(() => {
    return condPlayers.filter((p) => {
      if (playerProTeamFilter !== "all" && p.team !== playerProTeamFilter) return false;
      if (playerManagerFilter !== "all") {
        const mgr = playerToManager.get(p.espnId);
        if (playerManagerFilter === "none") {
          if (mgr) return false;
        } else if (mgr?.userId !== playerManagerFilter) return false;
      }
      return true;
    });
  }, [condPlayers, playerProTeamFilter, playerManagerFilter, playerToManager]);

  const sortedPlayers = useMemo(() => {
    const rate = (pts: number, games: number) => (games > 0 ? pts / games : 0);
    const sumArr = (a: number[]) => a.reduce((s, x) => s + x, 0);
    // Per-view sort: the key space covers all tables (simple: base/cond/delta;
    // round/game: r0..r3/total). For keys that don't apply to the current
    // metric, fall back to conditionalPoints desc.
    const roundPoints = (p: ConditionalPlayerRow, r: number): number => {
      if (playerMetric === "total") return p.conditionalPointsByRound[r] ?? 0;
      if (playerMetric === "ppg") {
        return rate(p.baselinePointsByRound[r] ?? 0, p.baselineGamesByRound[r] ?? 0);
      }
      return (p.teamReachProb[r] ?? 0) * 100;
    };
    const totalMetric = (p: ConditionalPlayerRow): number => {
      if (playerMetric === "total") return p.conditionalPoints;
      const games = sumArr(p.conditionalGamesByRound);
      if (playerMetric === "ppg") return rate(p.conditionalPoints, games);
      return games;
    };
    const keyValue = (p: ConditionalPlayerRow): number => {
      switch (playerSortKey) {
        case "base": {
          if (playerMetric === "total") return p.baselinePoints;
          if (playerMetric === "ppg") {
            return rate(p.baselinePoints, sumArr(p.baselineGamesByRound));
          }
          return sumArr(p.baselineGamesByRound);
        }
        case "delta":
          return totalMetric(p) - (playerMetric === "total"
            ? p.baselinePoints
            : playerMetric === "ppg"
              ? rate(p.baselinePoints, sumArr(p.baselineGamesByRound))
              : sumArr(p.baselineGamesByRound));
        case "r0":
          return roundPoints(p, 0);
        case "r1":
          return roundPoints(p, 1);
        case "r2":
          return roundPoints(p, 2);
        case "r3":
          return roundPoints(p, 3);
        case "total":
          return totalMetric(p);
        case "cond":
        default:
          return p.conditionalPoints;
      }
    };
    const sign = playerSortDir === "desc" ? -1 : 1;
    return [...filteredPlayers]
      .sort((a, b) => sign * (keyValue(a) - keyValue(b)))
      .slice(0, 200);
  }, [filteredPlayers, playerSortKey, playerSortDir, playerMetric]);
  const sortedManagers = useMemo(
    () => [...condManagers].sort((a, b) => b.conditionalWinPct - a.conditionalWinPct),
    [condManagers],
  );

  const teamRatings = useMemo(() => {
    if (!simData) return [];
    const playersByTeam = new Map<string, SimPlayer[]>();
    for (const p of simData.simPlayers) {
      if (!playersByTeam.has(p.team)) playersByTeam.set(p.team, []);
      playersByTeam.get(p.team)!.push(p);
    }
    const statusByNameLower = new Map<string, string>();
    for (const [name, entry] of Object.entries(simData.injuries ?? {})) {
      if (name === "_meta") continue;
      statusByNameLower.set(name.toLowerCase(), entry.status.toLowerCase());
    }
    const teamList: {
      team: string;
      fullName: string;
      seed: number | null;
      scenarios: Record<ScenarioId, TeamRating>;
    }[] = [];
    const seen = new Set<string>();
    const bracketTeams: { team: string; seed: number | null }[] = [
      ...simData.bracket.eastSeeds.map(([s, t]) => ({ team: t, seed: s })),
      ...(simData.bracket.eastPlayin ?? []).map(([s, t]) => ({ team: t, seed: s })),
      ...simData.bracket.westSeeds.map(([s, t]) => ({ team: t, seed: s })),
      ...(simData.bracket.westPlayin ?? []).map(([s, t]) => ({ team: t, seed: s })),
    ];
    for (const { team, seed } of bracketTeams) {
      if (seen.has(team)) continue;
      seen.add(team);
      const tp = playersByTeam.get(team) ?? [];
      const baselineMpg = simData.playoffMinutes[team] ?? {};
      const scenarios = {} as Record<ScenarioId, TeamRating>;
      for (const sc of SCENARIOS) {
        const excludeNames = new Set<string>();
        for (const p of tp) {
          const st = statusByNameLower.get(p.name.toLowerCase());
          if (st && sc.excludesStatuses.has(st)) {
            excludeNames.add(p.name.toLowerCase());
          }
        }
        scenarios[sc.id] = computeTeamRatingForScenario(tp, baselineMpg, excludeNames);
      }
      teamList.push({
        team,
        fullName: simData.bracket.teamFullNames[team] ?? team,
        seed,
        scenarios,
      });
    }
    teamList.sort((a, b) => b.scenarios.full.net - a.scenarios.full.net);
    return teamList;
  }, [simData]);

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
      const isSeriesKey = SERIES_KEYS.includes(key as SeriesKey);

      if (value == null) {
        // Clearing this slot. Also clear DOWNSTREAM forces for the same team —
        // if they no longer win this round, they can't have won later rounds.
        const teamIdx = prev[key];
        delete next[key];
        if (isSeriesKey && teamIdx != null && simData) {
          const team = simResults.teamNames[teamIdx];
          // Build the full path; everything strictly downstream of `key` that
          // is currently forced to this team should also clear.
          const tcs = findTeamConfAndSeed(team, simData);
          if (tcs) {
            const pair = seedToR1Pair(tcs.seed);
            if (pair) {
              const half = r1PairToR2Half(pair);
              const fullPath: SeriesKey[] = [
                `r1.${tcs.conf}.${pair}` as SeriesKey,
                `r2.${tcs.conf}.${half}` as SeriesKey,
                `cf.${tcs.conf}` as SeriesKey,
                "finals" as SeriesKey,
              ];
              const idx = fullPath.indexOf(key as SeriesKey);
              if (idx >= 0) {
                for (const downKey of fullPath.slice(idx + 1)) {
                  if (next[downKey] === teamIdx) delete next[downKey];
                }
              }
            }
          }
        }
        return next;
      }

      next[key] = value;
      // Setting a team to win series X → also force every prerequisite series
      // on their bracket path so they can actually reach X.
      if (isSeriesKey && simData) {
        const team = simResults.teamNames[value];
        for (const upKey of upstreamSeriesChain(team, key as SeriesKey, simData)) {
          next[upKey] = value;
        }

        // Cascade-invalidate: any other forced series whose required upstream
        // path is now blocked by THIS pick gets cleared. e.g. forcing OKC to
        // win r1.west.1v8 invalidates a prior force that PHX wins r2.west.top.
        for (const otherKey of Object.keys(next) as SeriesKey[]) {
          if (otherKey === key) continue;
          if (!SERIES_KEYS.includes(otherKey)) continue;
          const otherIdx = next[otherKey];
          if (otherIdx == null || otherIdx === value) continue;
          const otherTeam = simResults.teamNames[otherIdx];
          const otherChain = upstreamSeriesChain(otherTeam, otherKey, simData);
          // If `key` lies on otherTeam's path AND we just forced a different
          // team to win it, otherTeam can't reach otherKey anymore.
          if (otherChain.includes(key as SeriesKey)) {
            delete next[otherKey];
          }
        }
      }
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

          {/* Bracket — desktop: 3 columns side-by-side with one outer scroll;
              mobile: stack vertically with each conference scrolling on its own. */}
          <div className="md:overflow-x-auto md:pb-2">
            <div className="flex flex-col items-stretch gap-4 md:min-w-[1000px] md:flex-row md:items-start md:justify-center md:gap-6">
              <div className="w-full overflow-x-auto pb-2 md:w-auto md:overflow-visible md:pb-0">
                <ConferenceBracket
                  conf="west"
                  seeds={simData.bracket.westSeeds}
                  results={simResults}
                  simData={simData}
                  forces={forces}
                  decided={decidedWinners}
                  decidedMask={decidedMask}
                  mask={mask}
                  onForce={updateForce}
                />
              </div>
              <div className="flex justify-center md:block">
                <FinalsColumn
                  results={simResults}
                  simData={simData}
                  forces={forces}
                  decided={decidedWinners}
                  decidedMask={decidedMask}
                  mask={mask}
                  onForce={updateForce}
                  champion={champTeam}
                />
              </div>
              <div className="w-full overflow-x-auto pb-2 md:w-auto md:overflow-visible md:pb-0">
                <ConferenceBracket
                  conf="east"
                  seeds={simData.bracket.eastSeeds}
                  results={simResults}
                  simData={simData}
                  forces={forces}
                  decided={decidedWinners}
                  decidedMask={decidedMask}
                  mask={mask}
                  onForce={updateForce}
                  flip
                />
              </div>
            </div>
          </div>
          {/* Play-in dropdowns intentionally omitted: by the time the user
              opens the Simulator the play-in is finished and 7/8 seeds are
              baked into bracket.eastSeeds/westSeeds. */}
        </CardContent>
      </Card>

      {/* Sub-tab nav */}
      <div className="flex flex-nowrap items-center gap-1 overflow-x-auto">
        {([
          { id: "teams" as WhatIfSubTab, label: "Teams" },
          { id: "players" as WhatIfSubTab, label: "Players" },
          ...(rosters && rosters.length > 0
            ? [{ id: "fantasy" as WhatIfSubTab, label: "Fantasy Teams" }]
            : []),
          { id: "ratings" as WhatIfSubTab, label: "Team Ratings" },
          ...(teamPlayers
            ? [
                { id: "adjustments" as WhatIfSubTab, label: "Adjustments" },
                { id: "injuries" as WhatIfSubTab, label: "Injuries" },
              ]
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
        {onRunSim && adjustmentsDirty ? (
          <div className="ml-auto flex items-center gap-2 pl-2">
            <span className="text-xs text-amber-600 dark:text-amber-400">
              Unapplied edits
            </span>
            <Button
              size="sm"
              onClick={onRunSim}
              disabled={simulating}
            >
              {simulating ? `${Math.round(progress * 100)}%` : "Re-run sim"}
            </Button>
          </div>
        ) : null}
      </div>

      {subTab === "adjustments" && simData && teamPlayers && adjustments && defaultAdjustments && playoffMpgByEspnId && onUpdateAdjustment && onLoadAdjustments && onResetAdjustments ? (
        <ExploreAdjustmentsTab
          teamPlayers={teamPlayers}
          adjustments={adjustments}
          defaultAdjustments={defaultAdjustments}
          playoffMinutes={simData.playoffMinutes}
          playoffMpgByEspnId={playoffMpgByEspnId}
          onUpdateAdjustment={onUpdateAdjustment}
          onLoadAdjustments={onLoadAdjustments}
          onResetAdjustments={onResetAdjustments}
        />
      ) : null}

      {subTab === "injuries" && simData ? (
        <InjuriesView injuries={simData.injuries ?? {}} />
      ) : null}

      {subTab === "teams" ? (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle>Teams — Conditional Advancement</CardTitle>
                <CardDescription>
                  {teamsMode === "cumulative"
                    ? `% of ${surviving.toLocaleString()} surviving sims that reach each round.`
                    : `% of ${surviving.toLocaleString()} surviving sims where team wins that round. Finals = championship.`}
                </CardDescription>
              </div>
              <div className="flex shrink-0 gap-1 rounded-lg bg-muted/40 p-0.5">
                {([
                  { id: "cumulative", label: "Cumulative" },
                  { id: "exact", label: "Exact" },
                ] as const).map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    className={[
                      "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                      teamsMode === v.id
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    ].join(" ")}
                    onClick={() => setTeamsMode(v.id)}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
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
                    <th className="px-3 py-2 text-right font-medium">Finals%</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedTeams.map((t) => {
                    const cells = teamsMode === "cumulative"
                      ? [
                          { cond: t.cond.r0, base: t.base.r0 },
                          { cond: t.cond.r1, base: t.base.r1 },
                          { cond: t.cond.r2, base: t.base.r2 },
                          { cond: t.cond.cf, base: t.base.cf },
                        ]
                      : [
                          { cond: t.cond.r1, base: t.base.r1 },
                          { cond: t.cond.r2, base: t.base.r2 },
                          { cond: t.cond.cf, base: t.base.cf },
                          { cond: t.cond.finals, base: t.base.finals },
                        ];
                    return (
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
                        {cells.map((c, i) => (
                          <CondPctCell
                            key={i}
                            cond={c.cond}
                            base={c.base}
                            bold={i === cells.length - 1}
                          />
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {subTab === "players" ? (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle>Players — Conditional Projected Points</CardTitle>
                <CardDescription>
                  {playerMetric === "total"
                    ? "Mean fantasy pts over surviving sims vs baseline."
                    : playerMetric === "ppg"
                      ? "Per-game scoring rate assuming the team plays (baseline pts ÷ baseline games)."
                      : "Probability the player's team reaches each round."}{" "}
                  Top 200 by conditional points.
                </CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="h-7 rounded-md border border-border/60 bg-background px-2 text-xs"
                  value={playerProTeamFilter}
                  onChange={(e) => setPlayerProTeamFilter(e.target.value)}
                >
                  <option value="all">All teams</option>
                  {proTeamOptions.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                {managerOptions.length > 0 ? (
                  <select
                    className="h-7 rounded-md border border-border/60 bg-background px-2 text-xs"
                    value={playerManagerFilter}
                    onChange={(e) => setPlayerManagerFilter(e.target.value)}
                  >
                    <option value="all">All managers</option>
                    <option value="none">Undrafted</option>
                    {managerOptions.map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                ) : null}
                <div className="flex shrink-0 gap-1 rounded-lg bg-muted/40 p-0.5">
                  {([
                    { id: "total", label: "Total" },
                    { id: "ppg", label: "PPG" },
                    { id: "pplay", label: "P(play)" },
                  ] as const).map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      className={[
                        "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                        playerMetric === v.id
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      ].join(" ")}
                      onClick={() => setPlayerMetric(v.id)}
                    >
                      {v.label}
                    </button>
                  ))}
                </div>
                <div className="flex shrink-0 gap-1 rounded-lg bg-muted/40 p-0.5">
                  {([
                    { id: "simple", label: "Simple" },
                    { id: "round", label: "Round" },
                    { id: "game", label: "Game" },
                  ] as const).map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      className={[
                        "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                        playerView === v.id
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      ].join(" ")}
                      onClick={() => setPlayerView(v.id)}
                    >
                      {v.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-xl border border-border/80">
              {playerView === "simple" ? (
                <PlayersSimpleTable
                  players={sortedPlayers}
                  metric={playerMetric}
                  playerToManager={playerToManager}
                  sortKey={playerSortKey}
                  sortDir={playerSortDir}
                  onSort={togglePlayerSort}
                />
              ) : playerView === "round" ? (
                <PlayersRoundTable
                  players={sortedPlayers}
                  metric={playerMetric}
                  playerToManager={playerToManager}
                  sortKey={playerSortKey}
                  sortDir={playerSortDir}
                  onSort={togglePlayerSort}
                />
              ) : (
                <PlayersGameTable
                  players={sortedPlayers}
                  playerToManager={playerToManager}
                  sortKey={playerSortKey}
                  sortDir={playerSortDir}
                  onSort={togglePlayerSort}
                />
              )}
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

      {subTab === "ratings" ? (
        <Card>
          <CardHeader>
            <CardTitle>Team Ratings — Lineup Scenarios</CardTitle>
            <CardDescription>
              Minute-weighted LEBRON ratings. League avg = {LEAGUE_AVG_RTG}. Scenarios drop
              players based on current injury status and redistribute minutes proportionally.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-xl border border-border/80">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr className="border-b border-border/40">
                    <th rowSpan={2} className="px-3 py-2 text-left font-medium">Team</th>
                    <th rowSpan={2} className="px-3 py-2 text-right font-medium">Seed</th>
                    {SCENARIOS.map((sc) => (
                      <th
                        key={sc.id}
                        colSpan={3}
                        className="px-2 py-2 text-center font-semibold border-x border-border/40"
                      >
                        {sc.label}
                      </th>
                    ))}
                  </tr>
                  <tr>
                    {SCENARIOS.map((sc) => (
                      <Fragment key={sc.id}>
                        <th className="px-2 py-1 text-right font-medium">ORtg</th>
                        <th className="px-2 py-1 text-right font-medium">DRtg</th>
                        <th className="px-2 py-1 text-right font-medium border-r border-border/40">Net</th>
                      </Fragment>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {teamRatings.map((t) => (
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
                      {SCENARIOS.map((sc) => {
                        const r = t.scenarios[sc.id];
                        const fullNet = t.scenarios.full.net;
                        const netDelta = r.net - fullNet;
                        return (
                          <Fragment key={sc.id}>
                            <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                              {r.ortg.toFixed(1)}
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                              {r.drtg.toFixed(1)}
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums font-semibold text-foreground border-r border-border/40">
                              {r.net >= 0 ? "+" : ""}{r.net.toFixed(1)}
                              {sc.id !== "full" && Math.abs(netDelta) > 0.05 ? (
                                <span
                                  className={`ml-1 text-[10px] font-normal ${
                                    netDelta >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
                                  }`}
                                >
                                  ({netDelta >= 0 ? "+" : ""}{netDelta.toFixed(1)})
                                </span>
                              ) : null}
                            </td>
                          </Fragment>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

// ── Finals column ─────────────────────────────────────────────────────

function FinalsColumn({
  results,
  simData,
  forces,
  decided,
  decidedMask,
  mask,
  onForce,
  champion,
}: {
  results: SimResults;
  simData: SimData;
  forces: ForceMap;
  decided: Partial<Record<SeriesKey, number>>;
  decidedMask: Uint8Array | null;
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
        simData={simData}
        forces={forces}
        decided={decided}
        decidedMask={decidedMask}
        mask={mask}
        onForce={onForce}
      />
      <div className="mt-3 text-center">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Champion
        </div>
        <ChampionPicker
          results={results}
          champion={champion}
          hasForce={forces["finals"] != null}
          onPick={(idx) => onForce("finals" as SeriesKey, idx)}
          onClear={() => onForce("finals" as SeriesKey, null)}
        />
      </div>
    </div>
  );
}

/** Click-to-pick Champion box. Opens a dropdown of every playoff team (sorted
 *  by baseline champion %) — selecting one forces "finals" to that team, which
 *  cascades up to fill r1/r2/cf along their path. */
function ChampionPicker({
  results,
  champion,
  hasForce,
  onPick,
  onClear,
}: {
  results: SimResults;
  champion: string | null;
  hasForce: boolean;
  onPick: (teamIdx: number) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const options = useMemo(() => {
    return results.teams
      .map((t) => ({
        idx: results.teamIndex.get(t.team) ?? -1,
        team: t.team,
        pct: t.champ,
      }))
      .filter((o) => o.idx >= 0)
      .sort((a, b) => b.pct - a.pct);
  }, [results]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  const currentIdx = champion != null ? results.teamIndex.get(champion) ?? null : null;

  return (
    <div ref={ref} className="relative" style={{ width: BOX_W }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-center gap-1.5 rounded-md border-2 border-amber-400 bg-amber-50 px-4 py-2 text-sm font-bold text-foreground hover:bg-amber-100 dark:bg-amber-900/20 dark:hover:bg-amber-900/30"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {champion ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={teamLogoUrl(champion)} alt="" width={18} height={18} />
            <span>{champion}</span>
          </>
        ) : (
          <span className="italic text-muted-foreground">Pick a champion ▾</span>
        )}
      </button>
      {open ? (
        <PickerDropdown
          options={options}
          currentIdx={currentIdx}
          onPick={onPick}
          onClear={hasForce ? onClear : undefined}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

// ── Player tables (3 views) ────────────────────────────────────────────

type PlayerSortKeyLocal =
  | "cond"
  | "base"
  | "delta"
  | "r0"
  | "r1"
  | "r2"
  | "r3"
  | "total";

function SortArrow({ active, dir }: { active: boolean; dir: "asc" | "desc" }) {
  if (!active) return <span className="ml-1 text-muted-foreground/30">↕</span>;
  return <span className="ml-1 text-foreground/70">{dir === "desc" ? "↓" : "↑"}</span>;
}

function SortableTh({
  label,
  sortKey,
  currentKey,
  currentDir,
  onSort,
  className,
}: {
  label: React.ReactNode;
  sortKey: PlayerSortKeyLocal;
  currentKey: PlayerSortKeyLocal;
  currentDir: "asc" | "desc";
  onSort: (k: PlayerSortKeyLocal) => void;
  className?: string;
}) {
  const active = currentKey === sortKey;
  return (
    <th className={className}>
      <button
        type="button"
        className={[
          "inline-flex items-center justify-end gap-0.5 font-medium uppercase tracking-wider text-[10px]",
          active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        ].join(" ")}
        onClick={() => onSort(sortKey)}
      >
        {label}
        <SortArrow active={active} dir={currentDir} />
      </button>
    </th>
  );
}

function ManagerCell({
  mgr,
  size = "sm",
}: {
  mgr?: { userId: string; name: string };
  size?: "sm" | "xs";
}) {
  const cls = size === "xs" ? "px-2 py-1.5 text-xs" : "px-3 py-2 text-xs";
  if (!mgr) {
    return <td className={cls + " text-muted-foreground/40"}>—</td>;
  }
  return <td className={cls + " text-muted-foreground truncate max-w-[120px]"}>{mgr.name}</td>;
}

function PlayersSimpleTable({
  players,
  metric,
  playerToManager,
  sortKey,
  sortDir,
  onSort,
}: {
  players: ConditionalPlayerRow[];
  metric: "total" | "ppg" | "pplay";
  playerToManager: Map<string, { userId: string; name: string }>;
  sortKey: PlayerSortKeyLocal;
  sortDir: "asc" | "desc";
  onSort: (k: PlayerSortKeyLocal) => void;
}) {
  const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
  const rate = (pts: number, games: number) => (games > 0 ? pts / games : 0);
  const headerLabels = metric === "total"
    ? { base: "Base", cond: "Cond", unit: "" }
    : metric === "ppg"
      ? { base: "Base PPG", cond: "Cond PPG", unit: "" }
      : { base: "Base E[GP]", cond: "Cond E[GP]", unit: "" };
  return (
    <table className="w-full text-left text-sm">
      <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
        <tr>
          <th className="px-3 py-2 text-right font-medium">#</th>
          <th className="px-3 py-2 text-left font-medium">Player</th>
          <th className="px-3 py-2 text-left font-medium">Team</th>
          <th className="px-3 py-2 text-left font-medium">Manager</th>
          <SortableTh
            label={headerLabels.base}
            sortKey="base"
            currentKey={sortKey}
            currentDir={sortDir}
            onSort={onSort}
            className="px-3 py-2 text-right font-medium"
          />
          <SortableTh
            label={headerLabels.cond}
            sortKey="cond"
            currentKey={sortKey}
            currentDir={sortDir}
            onSort={onSort}
            className="px-3 py-2 text-right font-medium"
          />
          <SortableTh
            label="Δ"
            sortKey="delta"
            currentKey={sortKey}
            currentDir={sortDir}
            onSort={onSort}
            className="px-3 py-2 text-right font-medium"
          />
        </tr>
      </thead>
      <tbody>
        {players.map((p, idx) => {
          const baseTotalGames = sum(p.baselineGamesByRound);
          const condTotalGames = sum(p.conditionalGamesByRound);
          let baseVal: number, condVal: number, digits: number;
          if (metric === "total") {
            baseVal = p.baselinePoints;
            condVal = p.conditionalPoints;
            digits = 0;
          } else if (metric === "ppg") {
            baseVal = rate(p.baselinePoints, baseTotalGames);
            condVal = rate(p.conditionalPoints, condTotalGames);
            digits = 1;
          } else {
            baseVal = baseTotalGames;
            condVal = condTotalGames;
            digits = 1;
          }
          const delta = condVal - baseVal;
          const mgr = playerToManager.get(p.espnId);
          return (
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
              <ManagerCell mgr={mgr} />
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                {baseVal.toFixed(digits)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums font-medium text-foreground">
                {condVal.toFixed(digits)}
              </td>
              <DeltaCell delta={delta} />
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Round-by-round: 4 columns (R1/R2/CF/Finals) with switchable metric. */
function PlayersRoundTable({
  players,
  metric,
  playerToManager,
  sortKey,
  sortDir,
  onSort,
}: {
  players: ConditionalPlayerRow[];
  metric: "total" | "ppg" | "pplay";
  playerToManager: Map<string, { userId: string; name: string }>;
  sortKey: PlayerSortKeyLocal;
  sortDir: "asc" | "desc";
  onSort: (k: PlayerSortKeyLocal) => void;
}) {
  const rate = (pts: number, games: number) => (games > 0 ? pts / games : 0);
  const cellValue = (p: ConditionalPlayerRow, r: number): { value: number; empty: boolean; fmt: (v: number) => string } => {
    if (metric === "total") {
      const v = p.conditionalPointsByRound[r] ?? 0;
      return { value: v, empty: v <= 0.05, fmt: (x) => x.toFixed(1) };
    }
    if (metric === "ppg") {
      const v = rate(p.baselinePointsByRound[r] ?? 0, p.baselineGamesByRound[r] ?? 0);
      return { value: v, empty: v <= 0.05, fmt: (x) => x.toFixed(1) };
    }
    const v = (p.teamReachProb[r] ?? 0) * 100;
    return { value: v, empty: v < 0.1, fmt: (x) => `${x.toFixed(0)}%` };
  };
  const totalValue = (p: ConditionalPlayerRow): { value: number; fmt: (v: number) => string } => {
    if (metric === "total") return { value: p.conditionalPoints, fmt: (x) => x.toFixed(0) };
    if (metric === "ppg") {
      const games = p.conditionalGamesByRound.reduce((s, x) => s + x, 0);
      return { value: rate(p.conditionalPoints, games), fmt: (x) => x.toFixed(1) };
    }
    const games = p.conditionalGamesByRound.reduce((s, x) => s + x, 0);
    return { value: games, fmt: (x) => x.toFixed(1) };
  };
  const totalLabel = metric === "total" ? "Total" : metric === "ppg" ? "PPG" : "E[GP]";
  const roundKeys: PlayerSortKeyLocal[] = ["r0", "r1", "r2", "r3"];
  return (
    <table className="w-full text-left text-sm">
      <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
        <tr>
          <th className="px-3 py-2 text-right font-medium">#</th>
          <th className="px-3 py-2 text-left font-medium">Player</th>
          <th className="px-3 py-2 text-left font-medium">Team</th>
          <th className="px-3 py-2 text-left font-medium">Manager</th>
          {ROUND_LABELS.map((r, idx) => (
            <SortableTh
              key={r}
              label={r}
              sortKey={roundKeys[idx]}
              currentKey={sortKey}
              currentDir={sortDir}
              onSort={onSort}
              className="px-3 py-2 text-right font-medium"
            />
          ))}
          <SortableTh
            label={totalLabel}
            sortKey="total"
            currentKey={sortKey}
            currentDir={sortDir}
            onSort={onSort}
            className="px-3 py-2 text-right font-medium border-l border-border/50"
          />
        </tr>
      </thead>
      <tbody>
        {players.map((p, idx) => {
          const tot = totalValue(p);
          const mgr = playerToManager.get(p.espnId);
          return (
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
              <ManagerCell mgr={mgr} />
              {[0, 1, 2, 3].map((r) => {
                const c = cellValue(p, r);
                return (
                  <td
                    key={r}
                    className="px-3 py-2 text-right tabular-nums text-foreground"
                  >
                    {c.empty ? <span className="text-muted-foreground/40">—</span> : c.fmt(c.value)}
                  </td>
                );
              })}
              <td className="px-3 py-2 text-right tabular-nums font-semibold text-foreground border-l border-border/50">
                {tot.fmt(tot.value)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Game-by-game: each round shows Pts / PPG / GP triplet so you can see
 *  per-game expectations within that round. */
function PlayersGameTable({
  players,
  playerToManager,
  sortKey,
  sortDir,
  onSort,
}: {
  players: ConditionalPlayerRow[];
  playerToManager: Map<string, { userId: string; name: string }>;
  sortKey: PlayerSortKeyLocal;
  sortDir: "asc" | "desc";
  onSort: (k: PlayerSortKeyLocal) => void;
}) {
  // Per-game view: G1..G7 within each of R1/R2/CF/Finals (28 cells per row),
  // with a per-round Σ column after each round and a grand Total. Each game
  // cell shows expected points in that game across surviving sims (= 0 when
  // the series didn't reach that game in any surviving sim).
  const roundKeys: PlayerSortKeyLocal[] = ["r0", "r1", "r2", "r3"];
  return (
    <table className="w-full text-left text-xs">
      <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
        <tr className="border-b border-border/40">
          <th colSpan={4} />
          {ROUND_LABELS.map((r) => (
            <th
              key={r}
              colSpan={8}
              className="px-1 py-2 text-center font-semibold border-x border-border/40"
            >
              {r}
            </th>
          ))}
          <th className="px-2 py-2 text-center font-semibold border-l border-border/40">
            Total
          </th>
        </tr>
        <tr>
          <th className="px-2 py-2 text-right font-medium">#</th>
          <th className="px-2 py-2 text-left font-medium">Player</th>
          <th className="px-2 py-2 text-left font-medium">Team</th>
          <th className="px-2 py-2 text-left font-medium">Manager</th>
          {ROUND_LABELS.map((r, rIdx) => (
            <Fragment key={r}>
              {Array.from({ length: 7 }, (_, g) => (
                <th
                  key={`${r}-g${g + 1}`}
                  className={[
                    "px-1 py-2 text-right font-medium",
                    g === 0 ? "border-l border-border/40" : "",
                  ].join(" ")}
                >
                  G{g + 1}
                </th>
              ))}
              <SortableTh
                label="Σ"
                sortKey={roundKeys[rIdx]}
                currentKey={sortKey}
                currentDir={sortDir}
                onSort={onSort}
                className="px-1 py-2 text-right font-semibold bg-muted/20"
              />
            </Fragment>
          ))}
          <SortableTh
            label="Pts"
            sortKey="total"
            currentKey={sortKey}
            currentDir={sortDir}
            onSort={onSort}
            className="px-2 py-2 text-right font-medium border-l border-border/40"
          />
        </tr>
      </thead>
      <tbody>
        {players.map((p, idx) => {
          const byGame = p.conditionalPointsByGame;
          const mgr = playerToManager.get(p.espnId);
          return (
            <tr key={p.espnId} className="border-t border-border/60">
              <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                {idx + 1}
              </td>
              <td className="px-2 py-1.5">
                <div className="flex items-center gap-2">
                  <PlayerAvatar espnId={p.espnId} team={p.team} size={20} />
                  <span className="font-medium text-foreground">{p.name}</span>
                </div>
              </td>
              <td className="px-2 py-1.5 text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <TeamLogo team={p.team} size={14} />
                  {p.team}
                </div>
              </td>
              <ManagerCell mgr={mgr} size="xs" />
              {ROUND_LABELS.map((_, rIdx) => {
                let roundSum = 0;
                const cells: React.ReactElement[] = [];
                for (let g = 0; g < 7; g++) {
                  const i = rIdx * 7 + g;
                  const pts = byGame[i] ?? 0;
                  roundSum += pts;
                  const dim = pts < 0.05;
                  cells.push(
                    <td
                      key={i}
                      className={[
                        "px-1 py-1.5 text-right tabular-nums",
                        g === 0 ? "border-l border-border/40" : "",
                        dim ? "text-muted-foreground/30" : "text-foreground",
                      ].join(" ")}
                    >
                      {dim ? "—" : pts.toFixed(1)}
                    </td>,
                  );
                }
                const dimSum = roundSum < 0.05;
                return (
                  <Fragment key={rIdx}>
                    {cells}
                    <td
                      className={[
                        "px-1 py-1.5 text-right tabular-nums font-semibold bg-muted/20",
                        dimSum ? "text-muted-foreground/40" : "text-foreground",
                      ].join(" ")}
                    >
                      {dimSum ? "—" : roundSum.toFixed(1)}
                    </td>
                  </Fragment>
                );
              })}
              <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-foreground border-l border-border/40">
                {p.conditionalPoints.toFixed(0)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
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
