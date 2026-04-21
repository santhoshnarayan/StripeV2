"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BracketView } from "@/components/sim/bracket-view";
import { BracketMobileColumnsView } from "@/components/sim/bracket-mobile-view";
import { AdjustmentsView } from "@/components/sim/adjustments-view";
import { setBracketConstants } from "@/components/sim/adjustments-tab-explore";
import { WhatIfTab } from "@/components/sim/whatif-tab";
import { PlayerAvatar, TeamLogo } from "@/components/sim/player-avatar";
import { SimulatorLeaderboard } from "@/components/league/simulator-leaderboard";
import { appApiFetch } from "@/lib/app-api";
import {
  getCachedSimResults,
  setCachedSimResults,
  DEFAULT_SIM_CONFIG,
  type SimConfig,
  type SimData,
  type SimResults,
  type MarginalValue,
} from "@/lib/sim";
import { runSimAuto } from "@/lib/sim/wasm-engine";

import {
  computeManagerProjections,
  computeManagerProjectionsWithDraftSim,
  computeMarginalValuesWithDraftSim,
  computeEquilibriumBids,
  computeTeamExposureMatrix,
  type RosterInput,
  type ManagerBudgetInfo,
  type EquilibriumResult,
  type TeamExposureRow,
} from "@/lib/sim";

type SimSubTab = "leaderboard" | "players" | "teams" | "bracket" | "whatif" | "adjustments" | "injuries" | "roster" | "advisor" | "exposure";

export interface LeagueRosterData {
  rosters: Array<{
    userId: string;
    name: string;
    totalPoints: number;
    players: Array<{
      playerId: string;
      playerName: string;
      playerTeam: string;
      totalPoints: number;
    }>;
  }>;
  members: Array<{
    userId: string;
    name: string;
    remainingBudget: number;
    remainingRosterSlots: number;
  }>;
  availablePlayers: Array<{
    id: string;
    name: string;
    team: string;
    suggestedValue: number;
    totalPoints: number | null;
  }>;
  league: {
    budgetPerTeam: number;
    minBid: number;
    rosterSize: number;
  };
  viewerUserId?: string;
}

interface SimulatorTabProps {
  leagueId: string;
  leagueName: string;
  leagueData?: LeagueRosterData;
}

const EXPOSURE_ROUND_LABELS = ["R1", "R2", "CF", "Finals", "Champ"] as const;

function exposureCellClasses(value: number | null, base: number): string {
  if (value == null) return "bg-muted/30 text-muted-foreground/50";
  const delta = value - base;
  const pct = Math.abs(delta);
  if (pct < 0.005) return "bg-muted/30 text-foreground";
  if (delta > 0) {
    if (pct >= 0.1) return "bg-emerald-500/40 text-emerald-50 dark:text-emerald-50";
    if (pct >= 0.05) return "bg-emerald-500/25 text-foreground";
    return "bg-emerald-500/10 text-foreground";
  }
  if (pct >= 0.1) return "bg-red-500/40 text-red-50 dark:text-red-50";
  if (pct >= 0.05) return "bg-red-500/25 text-foreground";
  return "bg-red-500/10 text-foreground";
}

function ExposureManagerCard({
  managerName,
  baseWin,
  rows,
  isViewer,
}: {
  managerName: string;
  baseWin: number;
  rows: TeamExposureRow[];
  isViewer: boolean;
}) {
  return (
    <div
      className={`rounded-xl border px-4 py-3 ${isViewer ? "border-amber-400/50 bg-amber-50/30 dark:bg-amber-900/10" : "border-border/80"}`}
    >
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <p className="font-medium text-foreground text-sm">
            {managerName}{isViewer ? " (you)" : ""}
          </p>
          <p className="text-[11px] text-muted-foreground">
            Baseline win: {(baseWin * 100).toFixed(1)}% · {rows.length} team{rows.length === 1 ? "" : "s"}
          </p>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">No rostered players on playoff teams.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-2 py-1 text-left font-medium">Team</th>
                {EXPOSURE_ROUND_LABELS.map((r) => (
                  <th key={r} className="px-1 py-1 text-center font-medium">{r}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.team} className="border-t border-border/40">
                  <td className="px-2 py-1 font-medium text-foreground">
                    <div className="flex items-center gap-1.5">
                      <TeamLogo team={row.team} size={16} />
                      <span className="truncate" title={row.playerNames.join(", ")}>{row.team}</span>
                      <span className="text-[10px] text-muted-foreground">×{row.playerCount}</span>
                    </div>
                  </td>
                  {row.winByRound.map((v, i) => (
                    <td
                      key={i}
                      className={`px-1 py-1 text-center tabular-nums rounded ${exposureCellClasses(v, row.baseWin)}`}
                      title={
                        v == null
                          ? "Too few sims reach this round"
                          : `Reach ${(row.teamReachPct[i] * 100).toFixed(0)}% · Win given reach ${(v * 100).toFixed(1)}% (Δ ${((v - row.baseWin) * 100).toFixed(1)}pp)`
                      }
                    >
                      {v == null ? "–" : `${(v * 100).toFixed(0)}`}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function SimulatorTab({ leagueId, leagueName, leagueData }: SimulatorTabProps) {
  const cacheKey = `league:${leagueId}`;
  const [simData, setSimData] = useState<SimData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [simResults, setSimResults] = useState<SimResults | null>(
    () => getCachedSimResults(cacheKey),
  );
  const [simulating, setSimulating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [subTab, setSubTab] = useState<SimSubTab>("leaderboard");
  const [config, setConfig] = useState<SimConfig>(DEFAULT_SIM_CONFIG);
  const autoRanRef = useRef(false);

  const [localAdjustments, setLocalAdjustments] = useState<
    import("@/lib/sim").PlayerAdjustment[] | null
  >(null);
  const adjustments = localAdjustments ?? simData?.adjustments ?? [];
  const lastRunAdjustmentsKeyRef = useRef<string>("");
  const [lastRunKey, setLastRunKey] = useState<string>("");
  const currentAdjustmentsKey = useMemo(
    () => JSON.stringify(adjustments),
    [adjustments],
  );
  const adjustmentsDirty = lastRunKey !== "" && currentAdjustmentsKey !== lastRunKey;

  const playerRatingLookup = useMemo(() => {
    if (!simData) return new Map();
    return new Map(simData.simPlayers.map((p) => [p.espn_id, p]));
  }, [simData]);

  // Transform data for the explore-style adjustments component
  const teamPlayers = useMemo(() => {
    if (!simData) return {};
    const grouped: Record<string, typeof simData.simPlayers> = {};
    for (const p of simData.simPlayers) {
      if (!grouped[p.team]) grouped[p.team] = [];
      grouped[p.team].push(p);
    }
    return grouped;
  }, [simData]);

  const DEFAULT_AVAIL = new Array(30).fill(1) as number[];

  const adjustmentsRecord = useMemo(() => {
    const record: Record<string, import("@/lib/sim").PlayerAdjustment> = {};
    for (const a of adjustments) {
      record[a.espn_id] = { ...a, availability: a.availability ?? DEFAULT_AVAIL };
    }
    return record;
  }, [adjustments]);

  const defaultAdjustmentsRecord = useMemo(() => {
    const record: Record<string, import("@/lib/sim").PlayerAdjustment> = {};
    for (const a of simData?.adjustments ?? []) {
      record[a.espn_id] = { ...a, availability: a.availability ?? DEFAULT_AVAIL };
    }
    return record;
  }, [simData?.adjustments]);

  const playoffMpgByEspnId = useMemo(() => {
    if (!simData) return {};
    const lookup: Record<string, number> = {};
    const nbaIdToEspnId = new Map(
      simData.simPlayers.map((p) => [p.nba_id, p.espn_id]),
    );
    for (const [, teamMinutes] of Object.entries(simData.playoffMinutes)) {
      for (const [nbaId, mpg] of Object.entries(teamMinutes)) {
        const espnId = nbaIdToEspnId.get(nbaId);
        if (espnId) lookup[espnId] = mpg;
      }
    }
    return lookup;
  }, [simData]);

  // Set bracket constants for the explore adjustments component
  useEffect(() => {
    if (simData) {
      setBracketConstants(simData.bracket);
    }
  }, [simData]);

  // Core sim runner — used by auto-run and manual button
  const doRunSim = useCallback(
    async (data: SimData, cfg: SimConfig, adjs: typeof adjustments) => {
      setSimulating(true);
      setProgress(0);
      await new Promise((r) => setTimeout(r, 0));
      try {
        const results = await runSimAuto(
          { ...data, adjustments: adjs },
          cfg,
          (p) => setProgress(p),
        );
        setSimResults(results);
        setCachedSimResults(cacheKey, results);
        const key = JSON.stringify(adjs);
        lastRunAdjustmentsKeyRef.current = key;
        setLastRunKey(key);
      } catch (simError) {
        setError(simError instanceof Error ? simError.message : "Simulation failed");
      } finally {
        setSimulating(false);
        setProgress(1);
      }
    },
    [cacheKey],
  );

  // Fetch sim data + auto-run if no cached results
  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const [data, live] = await Promise.all([
          appApiFetch<SimData>(`/sim-data?v=${Date.now()}`),
          appApiFetch<{ games: SimData["liveGames"] }>(`/nba/sim-live-games`).catch(() => ({ games: [] })),
        ]);
        if (!active) return;
        const merged: SimData = { ...data, liveGames: live.games };
        setSimData(merged);
        if (!getCachedSimResults(cacheKey) && !autoRanRef.current) {
          autoRanRef.current = true;
          void doRunSim(merged, DEFAULT_SIM_CONFIG, merged.adjustments ?? []);
        }
      } catch (loadError) {
        if (active) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Failed to load simulation data",
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [cacheKey, doRunSim]);

  const handleRunSim = useCallback(async () => {
    if (!simData) return;
    await doRunSim(simData, config, adjustments);
  }, [simData, config, adjustments, doRunSim]);

  // Build roster inputs for draft optimizer
  const rosterInputs: RosterInput[] = useMemo(() => {
    if (!leagueData) return [];
    return leagueData.rosters.map((r) => ({
      userId: r.userId,
      name: r.name,
      playerIds: r.players.map((p) => p.playerId),
    }));
  }, [leagueData]);

  const viewerIndex = useMemo(() => {
    if (!leagueData?.viewerUserId) return 0;
    return rosterInputs.findIndex((r) => r.userId === leagueData.viewerUserId);
  }, [rosterInputs, leagueData?.viewerUserId]);

  // Manager projections (roster analysis)
  // If any manager has remaining slots, simulate a greedy forward draft first
  const managerProjections = useMemo(() => {
    if (!simResults || !rosterInputs.length || !leagueData) return null;
    const memberMap = new Map(leagueData.members.map((m) => [m.userId, m]));
    const hasRemainingSlots = leagueData.members.some((m) => m.remainingRosterSlots > 0);

    if (hasRemainingSlots) {
      const budgetInfos: ManagerBudgetInfo[] = rosterInputs.map((r) => {
        const m = memberMap.get(r.userId);
        return {
          userId: r.userId,
          remainingBudget: m?.remainingBudget ?? leagueData.league.budgetPerTeam,
          remainingRosterSlots: m?.remainingRosterSlots ?? leagueData.league.rosterSize,
        };
      });
      return computeManagerProjectionsWithDraftSim(
        simResults,
        rosterInputs,
        leagueData.availablePlayers.map((p) => p.id),
        budgetInfos,
        leagueData.league.minBid,
      );
    }

    return computeManagerProjections(simResults, rosterInputs);
  }, [simResults, rosterInputs, leagueData]);

  // Team-exposure matrix: P(manager wins | a given real team reaches round R).
  const exposureResult = useMemo(() => {
    if (!simResults || !rosterInputs.length || !simData) return null;
    const teamByEspn = new Map<string, string>();
    const nameByEspn = new Map<string, string>();
    for (const sp of simData.simPlayers) {
      teamByEspn.set(sp.espn_id, sp.team);
      nameByEspn.set(sp.espn_id, sp.name);
    }
    return computeTeamExposureMatrix(simResults, rosterInputs, teamByEspn, nameByEspn);
  }, [simResults, rosterInputs, simData]);

  // Marginal values (bid advisor)
  // Advisor is computed lazily — only when the user opens the tab
  const [marginalValues, setMarginalValues] = useState<MarginalValue[] | null>(null);
  const [advisorComputing, setAdvisorComputing] = useState(false);
  // Reset advisor when sim results change
  const simResultsRef = useRef(simResults);
  if (simResults !== simResultsRef.current) {
    simResultsRef.current = simResults;
    setMarginalValues(null);
  }

  const computeAdvisor = useCallback(() => {
    if (!simResults || !rosterInputs.length || !leagueData || advisorComputing) return;
    setAdvisorComputing(true);
    setTimeout(() => {
      const viewer = leagueData.members.find((m) => m.userId === leagueData.viewerUserId);
      if (!viewer) { setAdvisorComputing(false); return; }
      const availableIds = leagueData.availablePlayers.map((p) => p.id);
      const memberMap = new Map(leagueData.members.map((m) => [m.userId, m]));
      const budgetInfos: ManagerBudgetInfo[] = rosterInputs.map((r) => {
        const m = memberMap.get(r.userId);
        return {
          userId: r.userId,
          remainingBudget: m?.remainingBudget ?? leagueData.league.budgetPerTeam,
          remainingRosterSlots: m?.remainingRosterSlots ?? leagueData.league.rosterSize,
        };
      });
      const sugValues = new Map(leagueData.availablePlayers.map((p) => [p.id, p.suggestedValue]));
      const result = computeMarginalValuesWithDraftSim(
        simResults,
        rosterInputs,
        viewerIndex >= 0 ? viewerIndex : 0,
        availableIds,
        budgetInfos,
        leagueData.league.minBid,
        leagueData.league.rosterSize,
        sugValues,
      );
      setMarginalValues(result);
      setAdvisorComputing(false);
    }, 0);
  }, [simResults, rosterInputs, leagueData, viewerIndex, advisorComputing]);

  // Equilibrium bid simulation (computed lazily when advisor tab is opened)
  const [equilibrium, setEquilibrium] = useState<EquilibriumResult | null>(null);
  const [eqComputing, setEqComputing] = useState(false);

  const computeEq = useCallback(() => {
    if (!simResults || !rosterInputs.length || !leagueData || eqComputing) return;
    setEqComputing(true);
    // Run async to avoid blocking UI
    setTimeout(() => {
      const memberMap = new Map(leagueData.members.map((m) => [m.userId, m]));
      const budgetInfos: ManagerBudgetInfo[] = rosterInputs.map((r) => {
        const m = memberMap.get(r.userId);
        return {
          userId: r.userId,
          remainingBudget: m?.remainingBudget ?? leagueData.league.budgetPerTeam,
          remainingRosterSlots: m?.remainingRosterSlots ?? leagueData.league.rosterSize,
        };
      });
      const suggestedValues = new Map(
        leagueData.availablePlayers.map((p) => [p.id, p.suggestedValue]),
      );
      const result = computeEquilibriumBids(
        simResults,
        rosterInputs,
        leagueData.availablePlayers.map((p) => p.id),
        budgetInfos,
        leagueData.league.minBid,
        suggestedValues,
      );
      setEquilibrium(result);
      setEqComputing(false);
    }, 0);
  }, [simResults, rosterInputs, leagueData, eqComputing]);

  const subTabs: { id: SimSubTab; label: string }[] = [
    ...(leagueData ? [{ id: "leaderboard" as SimSubTab, label: "Leaderboard" }] : []),
    { id: "bracket", label: "Bracket" },
    { id: "whatif", label: "What-If" },
    { id: "players", label: "Players" },
    { id: "teams", label: "Teams" },
    ...(leagueData ? [
      { id: "roster" as SimSubTab, label: "Roster" },
      { id: "exposure" as SimSubTab, label: "Exposure" },
      { id: "advisor" as SimSubTab, label: "Advisor" },
    ] : []),
  ];

  if (loading && !simResults) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-9 w-24 animate-pulse rounded bg-muted" />
          ))}
        </div>
        <Card>
          <CardHeader>
            <div className="h-5 w-48 animate-pulse rounded bg-muted" />
            <div className="h-4 w-72 animate-pulse rounded bg-muted" />
          </CardHeader>
          <CardContent className="space-y-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-4 py-2">
                <div className="h-10 w-10 animate-pulse rounded-full bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-32 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-24 animate-pulse rounded bg-muted" />
                </div>
                <div className="h-4 w-16 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error && !simData) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Simulator</CardTitle>
          <CardDescription>{error}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => window.location.reload()}>Retry</Button>
        </CardContent>
      </Card>
    );
  }

  if (!simData) return null;

  return (
    <div className="space-y-4">
      {/* Single combined row: tabs left, controls right */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-nowrap gap-1 overflow-x-auto">
          {subTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={[
                "shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                subTab === tab.id
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              ].join(" ")}
              onClick={() => setSubTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select
            className="h-8 appearance-none rounded-lg border border-input bg-background px-3 pr-8 text-sm"
            value={config.model}
            onChange={(e) =>
              setConfig((prev) => ({
                ...prev,
                model: e.target.value as SimConfig["model"],
              }))
            }
          >
            <option value="lebron">Player Ratings (LEBRON)</option>
            <option value="netrtg">Team Net Rating</option>
            <option value="blend">Blend (50/50)</option>
          </select>
          <Button
            onClick={() => void handleRunSim()}
            disabled={simulating}
            size="sm"
          >
            {simulating
              ? `${Math.round(progress * 100)}%`
              : simResults
                ? `Re-run (${(config.sims / 1000).toFixed(0)}K)`
                : `Run (${(config.sims / 1000).toFixed(0)}K)`}
          </Button>
        </div>
      </div>

      {subTab === "leaderboard" && leagueData && managerProjections ? (
        <SimulatorLeaderboard
          managerProjections={managerProjections}
          exposure={exposureResult}
          rosters={leagueData.rosters}
          simData={simData}
          viewerUserId={leagueData.viewerUserId}
        />
      ) : subTab === "leaderboard" && !simResults ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          {simulating ? `Running simulation... ${Math.round(progress * 100)}%` : "Run a simulation to see the leaderboard."}
        </div>
      ) : null}

      {subTab === "bracket" ? (
        <>
          <div className="md:hidden">
            <BracketMobileColumnsView simData={simData} simResults={simResults} />
          </div>
          <div className="hidden md:block">
            <BracketView simData={simData} simResults={simResults} />
          </div>
        </>
      ) : null}

      {subTab === "whatif" ? (
        <WhatIfTab
          simData={simData}
          simResults={simResults}
          simulating={simulating}
          progress={progress}
          rosters={rosterInputs}
          viewerUserId={leagueData?.viewerUserId}
          teamPlayers={teamPlayers}
          adjustments={adjustmentsRecord}
          defaultAdjustments={defaultAdjustmentsRecord}
          playoffMpgByEspnId={playoffMpgByEspnId}
          onUpdateAdjustment={(espnId, update) => {
            setLocalAdjustments((prev) => {
              const current = prev ?? simData?.adjustments ?? [];
              const idx = current.findIndex((a) => a.espn_id === espnId);
              if (idx >= 0) {
                const updated = [...current];
                updated[idx] = { ...updated[idx], ...update };
                return updated;
              }
              const player = simData?.simPlayers.find((p) => p.espn_id === espnId);
              if (!player) return current;
              return [
                ...current,
                {
                  espn_id: espnId,
                  name: player.name,
                  team: player.team,
                  o_lebron_delta: 0,
                  d_lebron_delta: 0,
                  minutes_override: null,
                  availability: new Array(30).fill(1),
                  ...update,
                },
              ];
            });
          }}
          onLoadAdjustments={(adjs) => {
            const arr = Object.entries(adjs).map(([espnId, adj]) => ({
              ...adj,
              espn_id: espnId,
              name: adj.name ?? espnId,
              team: adj.team ?? "",
              availability: adj.availability ?? new Array(30).fill(1),
            }));
            setLocalAdjustments(arr);
          }}
          onResetAdjustments={() => setLocalAdjustments(null)}
          onRunSim={() => void handleRunSim()}
          adjustmentsDirty={adjustmentsDirty}
        />
      ) : null}

      {subTab === "teams" && simResults ? (
        <Card>
          <CardHeader>
            <CardTitle>Team Advancement Probabilities</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-xl border border-border/80">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Team</th>
                    <th className="px-3 py-2 text-right font-medium">Seed</th>
                    <th className="px-3 py-2 text-right font-medium">Rating</th>
                    <th className="px-3 py-2 text-right font-medium">R1%</th>
                    <th className="px-3 py-2 text-right font-medium">R2%</th>
                    <th className="px-3 py-2 text-right font-medium">CF%</th>
                    <th className="px-3 py-2 text-right font-medium">Finals%</th>
                  </tr>
                </thead>
                <tbody>
                  {[...simResults.teams]
                    .sort((a, b) =>
                      b.finals - a.finals
                      || b.cf - a.cf
                      || b.r2 - a.r2
                      || b.r1 - a.r1
                    )
                    .map((team) => (
                    <tr key={team.team} className="border-t border-border/60">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <TeamLogo team={team.team} size={20} />
                          <span className="font-medium text-foreground">
                            {team.team}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {team.fullName}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {team.seed ?? "PI"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {team.rating.toFixed(1)}
                      </td>
                      <PctCell value={team.r1} />
                      <PctCell value={team.r2} />
                      <PctCell value={team.cf} />
                      <PctCell value={team.finals} bold />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : subTab === "teams" && !simResults ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          {simulating ? `Running simulation... ${Math.round(progress * 100)}%` : "Run a simulation to see team advancement probabilities."}
        </div>
      ) : null}

      {subTab === "players" ? (
        <Card>
          <CardHeader>
            <CardTitle>Player Ratings{simResults ? " & Projections" : ""}</CardTitle>
            <CardDescription>
              {simResults
                ? "LEBRON ratings with simulated fantasy point projections and per-round breakdown."
                : simulating
                  ? `Running simulation... ${Math.round(progress * 100)}%`
                  : "LEBRON ratings. Run a simulation to see projected fantasy points."}
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
                    <th className="px-3 py-2 text-right font-medium">PPG</th>
                    <th className="px-3 py-2 text-right font-medium">LEBRON</th>
                    <th className="px-3 py-2 text-right font-medium">O-LEB</th>
                    <th className="px-3 py-2 text-right font-medium">D-LEB</th>
                    <th className="px-3 py-2 text-right font-medium">WAR</th>
                    {simResults ? (
                      <>
                        <th className="px-3 py-2 text-right font-medium">Proj Pts</th>
                        <th className="px-3 py-2 text-right font-medium">σ</th>
                        <th className="px-3 py-2 text-right font-medium">p10</th>
                        <th className="px-3 py-2 text-right font-medium">p90</th>
                        <th className="px-3 py-2 text-right font-medium">Proj GP</th>
                        <th className="px-3 py-2 text-right font-medium">R1 Pts</th>
                        <th className="px-3 py-2 text-right font-medium">R1 GP</th>
                        <th className="px-3 py-2 text-right font-medium">R2 Pts</th>
                        <th className="px-3 py-2 text-right font-medium">R2 GP</th>
                        <th className="px-3 py-2 text-right font-medium">CF Pts</th>
                        <th className="px-3 py-2 text-right font-medium">CF GP</th>
                        <th className="px-3 py-2 text-right font-medium">F Pts</th>
                        <th className="px-3 py-2 text-right font-medium">F GP</th>
                      </>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {(simResults
                    ? simResults.players.slice(0, 150)
                    : simData.simPlayers
                        .slice()
                        .sort((a, b) => b.lebron - a.lebron)
                        .slice(0, 150)
                  ).map((player, idx) => {
                    const espnId = "espnId" in player ? player.espnId : (player as any).espn_id;
                    const raw = playerRatingLookup.get(espnId);
                    const proj = simResults?.players.find((p) => p.espnId === espnId);
                    return (
                      <tr
                        key={espnId}
                        className="border-t border-border/60"
                      >
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {idx + 1}
                        </td>
                        <td className="px-3 py-2 font-medium text-foreground">
                          <div className="flex items-center gap-2">
                            <PlayerAvatar espnId={espnId} team={raw?.team ?? (player as any).team} size={28} />
                            {raw?.name ?? (player as any).name}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          <div className="flex items-center gap-1.5">
                            <TeamLogo team={raw?.team ?? (player as any).team} size={16} />
                            {raw?.team ?? (player as any).team}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {(raw?.ppg ?? 0).toFixed(1)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium text-foreground">
                          {(raw?.lebron ?? 0).toFixed(2)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {(raw?.o_lebron ?? 0).toFixed(2)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {(raw?.d_lebron ?? 0).toFixed(2)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {(raw?.war ?? 0).toFixed(1)}
                        </td>
                        {simResults && proj ? (
                          <>
                            <td className="px-3 py-2 text-right tabular-nums font-medium text-foreground">
                              {proj.projectedPoints.toFixed(0)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                              {proj.stddev.toFixed(0)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                              {proj.p10.toFixed(0)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                              {proj.p90.toFixed(0)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                              {proj.projectedGames.toFixed(1)}
                            </td>
                            {proj.projectedPointsByRound.map((pts, ri) => (
                              <React.Fragment key={ri}>
                                <td
                                  className="px-3 py-2 text-right tabular-nums text-muted-foreground"
                                >
                                  {pts.toFixed(0)}
                                </td>
                                <td
                                  className="px-3 py-2 text-right tabular-nums text-muted-foreground"
                                >
                                  {proj.projectedGamesByRound[ri]?.toFixed(1) ?? "—"}
                                </td>
                              </React.Fragment>
                            ))}
                          </>
                        ) : simResults ? (
                          <td colSpan={13} className="px-3 py-2 text-muted-foreground/50">
                            —
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Roster Analysis */}
      {subTab === "roster" && managerProjections ? (
        <Card>
          <CardHeader>
            <CardTitle>Roster Analysis</CardTitle>
            <CardDescription>
              Win probability and projected point distributions for each manager, based on {simResults?.numSims.toLocaleString()} simulations.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-xl border border-border/80">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-right font-medium">#</th>
                    <th className="px-3 py-2 text-left font-medium">Manager</th>
                    <th className="px-3 py-2 text-right font-medium">Players</th>
                    <th className="px-3 py-2 text-right font-medium">Win%</th>
                    <th className="px-3 py-2 text-right font-medium">Mean Pts</th>
                    <th className="px-3 py-2 text-right font-medium">Std Dev</th>
                    <th className="px-3 py-2 text-right font-medium">p10</th>
                    <th className="px-3 py-2 text-right font-medium">p90</th>
                  </tr>
                </thead>
                <tbody>
                  {[...managerProjections]
                    .sort((a, b) => b.winProbability - a.winProbability)
                    .map((mp, idx) => {
                      const roster = leagueData?.rosters.find((r) => r.userId === mp.userId);
                      const isViewer = mp.userId === leagueData?.viewerUserId;
                      return (
                        <tr key={mp.userId} className={`border-t border-border/60 ${isViewer ? "bg-amber-50/50 dark:bg-amber-900/10" : ""}`}>
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                            {idx + 1}
                          </td>
                          <td className="px-3 py-2 font-medium text-foreground">
                            {mp.name}{isViewer ? " (you)" : ""}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                            {roster?.players.length ?? 0}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums font-semibold text-foreground">
                            {(mp.winProbability * 100).toFixed(1)}%
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-foreground">
                            {mp.mean.toFixed(0)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                            {mp.stddev.toFixed(0)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                            {mp.p10.toFixed(0)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                            {mp.p90.toFixed(0)}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>

            {/* Win probability bar chart */}
            {managerProjections.length > 0 && (
              <div className="mt-6 space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Win Probability</p>
                {[...managerProjections]
                  .sort((a, b) => b.winProbability - a.winProbability)
                  .map((mp) => {
                    const isViewer = mp.userId === leagueData?.viewerUserId;
                    return (
                      <div key={mp.userId} className="flex items-center gap-3">
                        <span className={`w-28 text-sm truncate ${isViewer ? "font-medium" : "text-muted-foreground"}`}>
                          {mp.name}
                        </span>
                        <div className="flex-1 h-6 bg-muted/40 rounded-md overflow-hidden">
                          <div
                            className={`h-full rounded-md transition-all ${isViewer ? "bg-amber-500/60" : "bg-foreground/20"}`}
                            style={{ width: `${Math.max(1, mp.winProbability * 100)}%` }}
                          />
                        </div>
                        <span className="w-14 text-right text-sm tabular-nums font-medium">
                          {(mp.winProbability * 100).toFixed(1)}%
                        </span>
                      </div>
                    );
                  })}
              </div>
            )}

            {/* Per-manager roster breakdown */}
            {leagueData && (
              <div className="mt-6 grid gap-4 lg:grid-cols-2">
                {[...managerProjections]
                  .sort((a, b) => b.winProbability - a.winProbability)
                  .map((mp) => {
                    const roster = leagueData.rosters.find((r) => r.userId === mp.userId);
                    const isViewer = mp.userId === leagueData.viewerUserId;
                    const member = leagueData.members.find((m) => m.userId === mp.userId);
                    if (!roster) return null;
                    return (
                      <div
                        key={mp.userId}
                        className={`rounded-xl border px-4 py-3 ${isViewer ? "border-amber-400/50 bg-amber-50/30 dark:bg-amber-900/10" : "border-border/80"}`}
                      >
                        <div className="flex items-center justify-between gap-3 mb-3">
                          <div>
                            <p className="font-medium text-foreground text-sm">
                              {mp.name}{isViewer ? " (you)" : ""}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {(mp.winProbability * 100).toFixed(1)}% win · {mp.mean.toFixed(0)} avg pts · ${member?.remainingBudget ?? 0} left
                            </p>
                          </div>
                          <p className="text-xs text-muted-foreground">{roster.players.length} players</p>
                        </div>
                        <div className="space-y-1.5">
                          {roster.players
                            .slice()
                            .sort((a, b) => b.totalPoints - a.totalPoints)
                            .map((p) => {
                              const proj = simResults?.players.find((sp) => sp.espnId === p.playerId);
                              return (
                                <div key={p.playerId} className="flex items-center gap-2 rounded-lg bg-muted/40 px-2.5 py-1.5 text-sm">
                                  <PlayerAvatar espnId={p.playerId} team={p.playerTeam} size={24} />
                                  <span className="font-medium text-foreground flex-1 truncate">{p.playerName}</span>
                                  <span className="text-xs text-muted-foreground tabular-nums">
                                    {proj ? `${proj.projectedPoints.toFixed(0)} pts` : `${p.totalPoints} pts`}
                                  </span>
                                </div>
                              );
                            })}
                          {roster.players.length === 0 && (
                            <p className="text-xs text-muted-foreground py-2">No drafted players yet.</p>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </CardContent>
        </Card>
      ) : subTab === "roster" && !simResults ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          {simulating ? `Running simulation... ${Math.round(progress * 100)}%` : "Run a simulation to see roster analysis."}
        </div>
      ) : null}

      {/* Team Exposure */}
      {subTab === "exposure" && exposureResult && managerProjections && leagueData ? (
        <Card>
          <CardHeader>
            <CardTitle>Team Exposure</CardTitle>
            <CardDescription>
              For each manager, how their championship odds shift conditional on a real NBA team advancing.
              Green = boost, red = drag vs. their baseline. Rows sorted by biggest lift.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 lg:grid-cols-2">
              {[...managerProjections]
                .sort((a, b) => b.winProbability - a.winProbability)
                .map((mp) => {
                  const rows = exposureResult.rowsByManager.get(mp.userId) ?? [];
                  const isViewer = mp.userId === leagueData.viewerUserId;
                  return (
                    <ExposureManagerCard
                      key={mp.userId}
                      managerName={mp.name}
                      baseWin={mp.winProbability}
                      rows={rows}
                      isViewer={isViewer}
                    />
                  );
                })}
            </div>
          </CardContent>
        </Card>
      ) : subTab === "exposure" && !simResults ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          {simulating ? `Running simulation... ${Math.round(progress * 100)}%` : "Run a simulation to see team exposure."}
        </div>
      ) : null}

      {/* Bid Advisor */}
      {subTab === "advisor" && simResults && leagueData ? (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle>Bid Advisor</CardTitle>
                <CardDescription>
                  Simulates 2K full drafts to measure how much each player improves your win probability.
                </CardDescription>
              </div>
              <Button
                onClick={computeAdvisor}
                disabled={advisorComputing}
                size="sm"
              >
                {advisorComputing ? "Computing..." : marginalValues ? "Recompute" : "Compute Advisor"}
              </Button>
            </div>
          </CardHeader>
          {marginalValues ? (
          <CardContent>
            <div className="overflow-x-auto rounded-xl border border-border/80">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-right font-medium">#</th>
                    <th className="px-3 py-2 text-left font-medium">Player</th>
                    <th className="px-3 py-2 text-left font-medium">Team</th>
                    <th className="px-3 py-2 text-right font-medium">Proj Pts</th>
                    <th className="px-3 py-2 text-right font-medium">Cur Win%</th>
                    <th className="px-3 py-2 text-right font-medium">New Win%</th>
                    <th className="px-3 py-2 text-right font-medium">Delta</th>
                    <th className="px-3 py-2 text-right font-medium">Sug. Bid</th>
                  </tr>
                </thead>
                <tbody>
                  {marginalValues.slice(0, 50).map((mv, idx) => (
                    <tr key={mv.espnId} className="border-t border-border/60">
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {idx + 1}
                      </td>
                      <td className="px-3 py-2 font-medium text-foreground">
                        <div className="flex items-center gap-2">
                          <PlayerAvatar espnId={mv.espnId} team={mv.team} size={28} />
                          {mv.playerName}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        <div className="flex items-center gap-1.5">
                          <TeamLogo team={mv.team} size={16} />
                          {mv.team}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {mv.projectedPoints.toFixed(0)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {(mv.currentWinProb * 100).toFixed(1)}%
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-foreground">
                        {(mv.newWinProb * 100).toFixed(1)}%
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <span className={mv.marginalWinProb > 0 ? "font-medium text-emerald-700 dark:text-emerald-300" : "text-muted-foreground"}>
                          {mv.marginalWinProb > 0 ? "+" : ""}{(mv.marginalWinProb * 100).toFixed(2)}%
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-medium text-foreground">
                        ${mv.suggestedBid}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
          ) : !advisorComputing ? (
            <CardContent>
              <p className="text-sm text-muted-foreground py-4 text-center">
                Click &quot;Compute Advisor&quot; to run 2K draft simulations and find optimal bids.
              </p>
            </CardContent>
          ) : null}
        </Card>
      ) : subTab === "advisor" && !simResults ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          {simulating ? `Running simulation... ${Math.round(progress * 100)}%` : "Run a simulation to see bid advisor."}
        </div>
      ) : null}

      {/* Equilibrium Bid Matrix */}
      {subTab === "advisor" && simResults && leagueData ? (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle>Equilibrium Bid Matrix</CardTitle>
                <CardDescription>
                  Simulated auction bids for all teams after iterative best-response optimization.
                  Each team adjusts bids to maximize their win probability given other teams&apos; strategies.
                </CardDescription>
              </div>
              <Button
                onClick={computeEq}
                disabled={eqComputing || !simResults}
                size="sm"
              >
                {eqComputing ? "Computing..." : equilibrium ? "Recompute" : "Compute Equilibrium"}
              </Button>
            </div>
          </CardHeader>
          {equilibrium ? (
            <CardContent>
              <div className="overflow-x-auto rounded-xl border border-border/80">
                <table className="w-full text-left text-sm">
                  <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="sticky left-0 z-10 bg-muted/40 px-3 py-2 text-left font-medium min-w-[160px]">Player</th>
                      <th className="px-2 py-2 text-left font-medium">Team</th>
                      <th className="px-2 py-2 text-right font-medium">Proj</th>
                      <th className="px-2 py-2 text-right font-medium">Value</th>
                      {equilibrium.managerNames.map((name, i) => (
                        <th key={i} className="px-2 py-2 text-right font-medium min-w-[60px]">
                          {name.split(" ")[0]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {equilibrium.players.slice(0, 60).map((row) => {
                      const maxBid = Math.max(...row.bids);
                      return (
                        <tr key={row.espnId} className="border-t border-border/60">
                          <td className="sticky left-0 z-10 bg-background px-3 py-1.5 font-medium text-foreground">
                            <div className="flex items-center gap-2">
                              <PlayerAvatar espnId={row.espnId} team={row.team} size={22} />
                              <span className="truncate">{row.playerName}</span>
                            </div>
                          </td>
                          <td className="px-2 py-1.5 text-muted-foreground">
                            <div className="flex items-center gap-1">
                              <TeamLogo team={row.team} size={14} />
                              {row.team}
                            </div>
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                            {row.projectedPoints.toFixed(0)}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums font-medium text-foreground">
                            ${row.suggestedValue}
                          </td>
                          {row.bids.map((bid, mi) => {
                            const isViewer = leagueData.viewerUserId === rosterInputs[mi]?.userId;
                            const isMax = bid === maxBid && bid > 0;
                            return (
                              <td
                                key={mi}
                                className={`px-2 py-1.5 text-right tabular-nums ${
                                  isViewer ? "font-medium" : ""
                                } ${
                                  bid === 0
                                    ? "text-muted-foreground/30"
                                    : isMax
                                      ? "font-semibold text-foreground"
                                      : "text-muted-foreground"
                                }`}
                              >
                                {bid > 0 ? `$${bid}` : "—"}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {equilibrium.iterations} iterations × 20 auctions per iteration. Bold = highest bidder.
              </p>
            </CardContent>
          ) : !eqComputing ? (
            <CardContent>
              <p className="text-sm text-muted-foreground py-4 text-center">
                Click &quot;Compute Equilibrium&quot; to simulate auction outcomes for all teams.
              </p>
            </CardContent>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}


function PctCell({ value, bold }: { value: number; bold?: boolean }) {
  const opacity = Math.min(1, value / 50);
  return (
    <td className="px-3 py-2 text-right tabular-nums">
      <span
        className={[
          "inline-block min-w-[3rem] rounded-md px-1.5 py-0.5",
          bold ? "font-semibold" : "font-normal",
          value > 0 ? "text-foreground" : "text-muted-foreground/50",
        ].join(" ")}
        style={
          value > 0
            ? {
                backgroundColor: `color-mix(in oklch, var(--bid-green-bg), transparent ${Math.round((1 - opacity) * 100)}%)`,
              }
            : undefined
        }
      >
        {value > 0 ? `${value.toFixed(1)}` : "—"}
      </span>
    </td>
  );
}
