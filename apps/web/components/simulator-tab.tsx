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
import { AdjustmentsView } from "@/components/sim/adjustments-view";
import { AdjustmentsTab as ExploreAdjustmentsTab, setBracketConstants } from "@/components/sim/adjustments-tab-explore";
import { InjuriesView } from "@/components/sim/injuries-view";
import { PlayerAvatar, TeamLogo } from "@/components/sim/player-avatar";
import { appApiFetch } from "@/lib/app-api";
import {
  runTournamentSim,
  getCachedSimResults,
  setCachedSimResults,
  DEFAULT_SIM_CONFIG,
  type SimConfig,
  type SimData,
  type SimResults,
} from "@/lib/sim";

type SimSubTab = "players" | "teams" | "bracket" | "adjustments" | "injuries";

interface SimulatorTabProps {
  leagueId: string;
  leagueName: string;
}

export function SimulatorTab({ leagueId, leagueName }: SimulatorTabProps) {
  const cacheKey = `league:${leagueId}`;
  const [simData, setSimData] = useState<SimData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [simResults, setSimResults] = useState<SimResults | null>(
    () => getCachedSimResults(cacheKey),
  );
  const [simulating, setSimulating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [subTab, setSubTab] = useState<SimSubTab>("players");
  const [config, setConfig] = useState<SimConfig>(DEFAULT_SIM_CONFIG);
  const autoRanRef = useRef(false);

  const [localAdjustments, setLocalAdjustments] = useState<
    import("@/lib/sim").PlayerAdjustment[] | null
  >(null);
  const adjustments = localAdjustments ?? simData?.adjustments ?? [];

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
        const results = await runTournamentSim(
          { ...data, adjustments: adjs },
          cfg,
          (p) => setProgress(p),
        );
        setSimResults(results);
        setCachedSimResults(cacheKey, results);
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
        const data = await appApiFetch<SimData>(`/sim-data?v=${Date.now()}`);
        if (!active) return;
        setSimData(data);
        if (!getCachedSimResults(cacheKey) && !autoRanRef.current) {
          autoRanRef.current = true;
          void doRunSim(data, DEFAULT_SIM_CONFIG, data.adjustments ?? []);
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

  if (loading && !simResults) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        Loading simulation data...
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

  const subTabs: { id: SimSubTab; label: string }[] = [
    { id: "players", label: "Players" },
    { id: "teams", label: "Teams" },
    { id: "bracket", label: "Bracket" },
    { id: "adjustments", label: "Adjustments" },
    { id: "injuries", label: "Injuries" },
  ];

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

      {subTab === "bracket" ? (
        <BracketView simData={simData} simResults={simResults} />
      ) : null}

      {subTab === "adjustments" && simData ? (
        <ExploreAdjustmentsTab
          teamPlayers={teamPlayers}
          adjustments={adjustmentsRecord}
          defaultAdjustments={defaultAdjustmentsRecord}
          playoffMinutes={simData.playoffMinutes}
          playoffMpgByEspnId={playoffMpgByEspnId}
          onUpdateAdjustment={(espnId, update) => {
            setLocalAdjustments((prev) => {
              const current = prev ?? simData.adjustments ?? [];
              const idx = current.findIndex((a) => a.espn_id === espnId);
              if (idx >= 0) {
                const updated = [...current];
                updated[idx] = { ...updated[idx], ...update };
                return updated;
              }
              const player = simData.simPlayers.find((p) => p.espn_id === espnId);
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
        />
      ) : null}

      {subTab === "injuries" && simData ? (
        <InjuriesView injuries={simData.injuries ?? {}} />
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
                    <th className="px-3 py-2 text-right font-medium">Champ%</th>
                  </tr>
                </thead>
                <tbody>
                  {simResults.teams.map((team) => (
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
                      <PctCell value={team.finals} />
                      <PctCell value={team.champ} bold />
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
                          <td colSpan={10} className="px-3 py-2 text-muted-foreground/50">
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
