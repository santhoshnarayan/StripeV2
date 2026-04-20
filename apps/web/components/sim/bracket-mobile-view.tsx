"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { TeamLogo } from "@/components/sim/player-avatar";
import { cn } from "@/lib/utils";
import {
  computeSeriesState,
  useBracketSchedule,
  type ScheduleGame,
  type SeriesState,
} from "@/lib/use-bracket-schedule";
import type { SimData, SimResults } from "@/lib/sim";

type RoundKey = "r1" | "r2" | "cf" | "finals";
type TabKey = "west" | "east" | "championship";

const TAB_LABELS: Record<TabKey, string> = {
  west: "West",
  east: "East",
  championship: "Championship",
};

const ROUND_LABELS: Record<RoundKey, string> = {
  r1: "Round 1",
  r2: "Conf Semis",
  cf: "Conf Finals",
  finals: "NBA Finals",
};

type Matchup = {
  seriesKey: string;
  higher: { seed: number; team: string };
  lower: { seed: number; team: string };
  conf: "west" | "east" | "finals";
};

/** Build matchups for a given round from the bracket seeds + sim results flow-through. */
function buildRoundMatchups(
  simData: SimData,
  simResults: SimResults | null,
  round: RoundKey,
): Matchup[] {
  const { westSeeds, eastSeeds } = simData.bracket;

  function confMatchups(
    seeds: [number, string][],
    conf: "west" | "east",
  ): Matchup[] {
    const seed7: [number, string] = [
      7,
      seeds.find(([s]) => s === 7)?.[1] ?? "Play-In",
    ];
    const seed8: [number, string] = [
      8,
      seeds.find(([s]) => s === 8)?.[1] ?? "Play-In",
    ];
    const r1Pairs: [[number, string], [number, string], string][] = [
      [seeds[0], seed8, "1v8"],
      [seeds[3], seeds[4], "4v5"],
      [seeds[2], seeds[5], "3v6"],
      [seeds[1], seed7, "2v7"],
    ];

    function pickWinner(
      a: [number, string],
      b: [number, string],
      r: "r1" | "r2" | "cf",
    ): [number, string] {
      if (!simResults) return [0, "TBD"];
      const aTeam = simResults.teams.find((t) => t.team === a[1]);
      const bTeam = simResults.teams.find((t) => t.team === b[1]);
      const aVal = aTeam?.[r] ?? 0;
      const bVal = bTeam?.[r] ?? 0;
      if (aVal === 0 && bVal === 0) return [0, "TBD"];
      return aVal >= bVal ? a : b;
    }

    if (round === "r1") {
      return r1Pairs.map(([h, l, key]) => ({
        seriesKey: `r1.${conf}.${key}`,
        higher: { seed: h[0], team: h[1] },
        lower: { seed: l[0], team: l[1] },
        conf,
      }));
    }
    if (round === "r2") {
      const w1v8 = pickWinner(r1Pairs[0][0], r1Pairs[0][1], "r2");
      const w4v5 = pickWinner(r1Pairs[1][0], r1Pairs[1][1], "r2");
      const w3v6 = pickWinner(r1Pairs[2][0], r1Pairs[2][1], "r2");
      const w2v7 = pickWinner(r1Pairs[3][0], r1Pairs[3][1], "r2");
      return [
        {
          seriesKey: `r2.${conf}.top`,
          higher: { seed: w1v8[0], team: w1v8[1] },
          lower: { seed: w4v5[0], team: w4v5[1] },
          conf,
        },
        {
          seriesKey: `r2.${conf}.bot`,
          higher: { seed: w3v6[0], team: w3v6[1] },
          lower: { seed: w2v7[0], team: w2v7[1] },
          conf,
        },
      ];
    }
    if (round === "cf") {
      const r2Top: [number, string] = (() => {
        const a = pickWinner(r1Pairs[0][0], r1Pairs[0][1], "r2");
        const b = pickWinner(r1Pairs[1][0], r1Pairs[1][1], "r2");
        return pickWinner(a, b, "cf");
      })();
      const r2Bot: [number, string] = (() => {
        const a = pickWinner(r1Pairs[2][0], r1Pairs[2][1], "r2");
        const b = pickWinner(r1Pairs[3][0], r1Pairs[3][1], "r2");
        return pickWinner(a, b, "cf");
      })();
      return [
        {
          seriesKey: `cf.${conf}`,
          higher: { seed: r2Top[0], team: r2Top[1] },
          lower: { seed: r2Bot[0], team: r2Bot[1] },
          conf,
        },
      ];
    }
    return [];
  }

  if (round === "finals") {
    const westSet = new Set(westSeeds.map(([, t]) => t));
    const eastSet = new Set(eastSeeds.map(([, t]) => t));
    const westFinalist = simResults?.teams
      .filter((t) => westSet.has(t.team))
      .sort((a, b) => b.finals - a.finals)[0];
    const eastFinalist = simResults?.teams
      .filter((t) => eastSet.has(t.team))
      .sort((a, b) => b.finals - a.finals)[0];
    return [
      {
        seriesKey: "finals.series",
        higher: {
          seed: westFinalist?.seed ?? 0,
          team: westFinalist?.team ?? "TBD",
        },
        lower: {
          seed: eastFinalist?.seed ?? 0,
          team: eastFinalist?.team ?? "TBD",
        },
        conf: "finals",
      },
    ];
  }
  return [...confMatchups(westSeeds, "west"), ...confMatchups(eastSeeds, "east")];
}

function LiveBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded px-1 py-px text-[9px] font-bold uppercase tracking-wide text-red-500 bg-red-500/10">
      <span className="size-1.5 rounded-full bg-red-500 animate-pulse" />
      Live
    </span>
  );
}

function SeriesRecord({ higher, lower, series }: {
  higher: string;
  lower: string;
  series: SeriesState;
}) {
  const h = series.wins[higher] ?? 0;
  const l = series.wins[lower] ?? 0;
  if (h === 0 && l === 0) return null;
  const leader = h > l ? `${higher} leads ${h}-${l}` : l > h ? `${lower} leads ${l}-${h}` : `Series tied ${h}-${l}`;
  const clinched = h === 4 || l === 4;
  return (
    <span
      className={cn(
        "text-[10px]",
        clinched ? "font-semibold text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
      )}
    >
      {clinched ? (h === 4 ? `${higher} wins ${h}-${l}` : `${lower} wins ${l}-${h}`) : leader}
    </span>
  );
}

function GameStatusLine({ game }: { game: ScheduleGame }) {
  if (game.status === "in") {
    const home = game.homeTeam ?? "";
    const away = game.awayTeam ?? "";
    const hs = game.homeScore ?? 0;
    const as_ = game.awayScore ?? 0;
    return (
      <Link
        href={`/games/${encodeURIComponent(game.id)}`}
        className="flex items-center justify-between gap-2 rounded border border-red-500/40 bg-red-500/5 px-2 py-1 text-[10px] hover:bg-red-500/10"
      >
        <LiveBadge />
        <span className="tabular-nums truncate">
          {away} {as_} @ {home} {hs}
        </span>
      </Link>
    );
  }
  if (game.status === "post") {
    return null;
  }
  if (game.date) {
    const d = new Date(game.date);
    const day = d.toLocaleDateString(undefined, { weekday: "short", month: "numeric", day: "numeric" });
    return (
      <span className="text-[10px] text-muted-foreground">
        Next: {day}
      </span>
    );
  }
  return null;
}

function MatchupCard({
  matchup,
  series,
  round,
  simResults,
}: {
  matchup: Matchup;
  series: SeriesState | null;
  round: RoundKey;
  simResults: SimResults | null;
}) {
  const hAdv = simResults?.teams.find((t) => t.team === matchup.higher.team);
  const lAdv = simResults?.teams.find((t) => t.team === matchup.lower.team);
  const isLive = series?.headline === "in";

  return (
    <div
      className={cn(
        "rounded-lg border bg-card overflow-hidden",
        isLive
          ? "border-red-500/60"
          : series?.headline === "post"
            ? "border-border/60 bg-muted/30"
            : "border-border",
      )}
    >
      <TeamSlot
        team={matchup.higher.team}
        seed={matchup.higher.seed}
        wins={series?.wins[matchup.higher.team] ?? 0}
        advPct={hAdv?.[round]}
      />
      <div className="border-t border-border/60" />
      <TeamSlot
        team={matchup.lower.team}
        seed={matchup.lower.seed}
        wins={series?.wins[matchup.lower.team] ?? 0}
        advPct={lAdv?.[round]}
      />
      {series && (series.liveGame || series.headline !== "idle") ? (
        <div className="flex items-center justify-between gap-2 border-t border-border/60 px-2 py-1 bg-muted/20">
          <SeriesRecord
            higher={matchup.higher.team}
            lower={matchup.lower.team}
            series={series}
          />
          {series.liveGame ? (
            <GameStatusLine game={series.liveGame} />
          ) : series.nextGame ? (
            <GameStatusLine game={series.nextGame} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TeamSlot({
  team,
  seed,
  wins,
  advPct,
}: {
  team: string;
  seed: number;
  wins: number;
  advPct?: number | null;
}) {
  const isTBD = team === "TBD" || team === "Play-In";
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <span className="w-4 shrink-0 text-[10px] tabular-nums text-muted-foreground text-right">
        {seed > 0 ? seed : ""}
      </span>
      {!isTBD ? (
        <TeamLogo team={team} size={18} />
      ) : (
        <span className="size-[18px] rounded bg-muted shrink-0" />
      )}
      <span className="truncate text-sm font-medium text-foreground">{team}</span>
      {wins > 0 ? (
        <span className="ml-1 rounded bg-muted px-1 text-[10px] font-semibold tabular-nums">
          {wins}
        </span>
      ) : null}
      {!isTBD && advPct != null ? (
        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {advPct.toFixed(0)}%
        </span>
      ) : null}
    </div>
  );
}

export function BracketMobileView({
  simData,
  simResults,
}: {
  simData: SimData;
  simResults: SimResults | null;
}) {
  const [round, setRound] = useState<RoundKey>("r1");
  const { schedule } = useBracketSchedule();

  const seriesByKey = useMemo(() => {
    const map: Record<string, SeriesState> = {};
    for (const [key, games] of Object.entries(schedule)) {
      map[key] = computeSeriesState(games);
    }
    return map;
  }, [schedule]);

  const matchups = useMemo(
    () => buildRoundMatchups(simData, simResults, round),
    [simData, simResults, round],
  );

  const westMatchups = matchups.filter((m) => m.conf === "west");
  const eastMatchups = matchups.filter((m) => m.conf === "east");
  const finalMatchups = matchups.filter((m) => m.conf === "finals");

  return (
    <div className="space-y-4">
      <div className="flex gap-1 overflow-x-auto no-scrollbar">
        {(Object.keys(ROUND_LABELS) as RoundKey[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setRound(k)}
            className={cn(
              "shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors",
              round === k
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-muted/70",
            )}
          >
            {ROUND_LABELS[k]}
          </button>
        ))}
      </div>

      {westMatchups.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            West
          </h3>
          <div className="space-y-2">
            {westMatchups.map((m) => (
              <MatchupCard
                key={m.seriesKey}
                matchup={m}
                series={seriesByKey[m.seriesKey] ?? null}
                round={round}
                simResults={simResults}
              />
            ))}
          </div>
        </section>
      ) : null}

      {eastMatchups.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            East
          </h3>
          <div className="space-y-2">
            {eastMatchups.map((m) => (
              <MatchupCard
                key={m.seriesKey}
                matchup={m}
                series={seriesByKey[m.seriesKey] ?? null}
                round={round}
                simResults={simResults}
              />
            ))}
          </div>
        </section>
      ) : null}

      {finalMatchups.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Finals
          </h3>
          <div className="space-y-2">
            {finalMatchups.map((m) => (
              <MatchupCard
                key={m.seriesKey}
                matchup={m}
                series={seriesByKey[m.seriesKey] ?? null}
                round={round}
                simResults={simResults}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function BracketMobileColumnsView({
  simData,
  simResults,
}: {
  simData: SimData;
  simResults: SimResults | null;
}) {
  const [tab, setTab] = useState<TabKey>("west");
  const { schedule } = useBracketSchedule();

  const seriesByKey = useMemo(() => {
    const map: Record<string, SeriesState> = {};
    for (const [key, games] of Object.entries(schedule)) {
      map[key] = computeSeriesState(games);
    }
    return map;
  }, [schedule]);

  const r1All = useMemo(
    () => buildRoundMatchups(simData, simResults, "r1"),
    [simData, simResults],
  );
  const r2All = useMemo(
    () => buildRoundMatchups(simData, simResults, "r2"),
    [simData, simResults],
  );
  const cfAll = useMemo(
    () => buildRoundMatchups(simData, simResults, "cf"),
    [simData, simResults],
  );
  const finalsAll = useMemo(
    () => buildRoundMatchups(simData, simResults, "finals"),
    [simData, simResults],
  );

  const columns: { label: string; round: RoundKey; matchups: Matchup[] }[] =
    tab === "west"
      ? [
          { label: ROUND_LABELS.r1, round: "r1", matchups: r1All.filter((m) => m.conf === "west") },
          { label: ROUND_LABELS.r2, round: "r2", matchups: r2All.filter((m) => m.conf === "west") },
        ]
      : tab === "east"
        ? [
            { label: ROUND_LABELS.r1, round: "r1", matchups: r1All.filter((m) => m.conf === "east") },
            { label: ROUND_LABELS.r2, round: "r2", matchups: r2All.filter((m) => m.conf === "east") },
          ]
        : [
            { label: ROUND_LABELS.cf, round: "cf", matchups: cfAll },
            { label: ROUND_LABELS.finals, round: "finals", matchups: finalsAll },
          ];

  return (
    <div className="space-y-4">
      <div className="flex gap-1 overflow-x-auto no-scrollbar">
        {(Object.keys(TAB_LABELS) as TabKey[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={cn(
              "shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors",
              tab === k
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-muted/70",
            )}
          >
            {TAB_LABELS[k]}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {columns.map((col) => (
          <section key={col.round} className="space-y-2 min-w-0">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {col.label}
            </h3>
            <div className="space-y-2">
              {col.matchups.map((m) => (
                <MatchupCard
                  key={m.seriesKey}
                  matchup={m}
                  series={seriesByKey[m.seriesKey] ?? null}
                  round={col.round}
                  simResults={simResults}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
