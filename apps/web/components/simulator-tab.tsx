"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import { appApiFetch } from "@/lib/app-api";
import {
  runTournamentSim,
  DEFAULT_SIM_CONFIG,
  type SimConfig,
  type SimData,
  type SimResults,
  type TeamSimResult,
  type PlayerProjection,
} from "@/lib/sim";

type SimSubTab = "players" | "teams" | "bracket" | "adjustments";

interface SimulatorTabProps {
  leagueId: string;
  leagueName: string;
}

export function SimulatorTab({ leagueId, leagueName }: SimulatorTabProps) {
  const [simData, setSimData] = useState<SimData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [simResults, setSimResults] = useState<SimResults | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [subTab, setSubTab] = useState<SimSubTab>("players");
  const [config, setConfig] = useState<SimConfig>(DEFAULT_SIM_CONFIG);

  // Mutable copy of adjustments so users can edit them before re-running
  const [localAdjustments, setLocalAdjustments] = useState<
    import("@/lib/sim").PlayerAdjustment[] | null
  >(null);

  // Initialize local adjustments from simData once loaded
  const adjustments = localAdjustments ?? simData?.adjustments ?? [];

  const playerRatingLookup = useMemo(() => {
    if (!simData) return new Map();
    return new Map(simData.simPlayers.map((p) => [p.espn_id, p]));
  }, [simData]);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const data = await appApiFetch<SimData>("/sim-data");
        if (active) setSimData(data);
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
    return () => {
      active = false;
    };
  }, []);

  const handleRunSim = useCallback(async () => {
    if (!simData) return;
    setSimulating(true);
    setProgress(0);

    // Yield to the browser before starting so the UI updates
    await new Promise((r) => setTimeout(r, 0));

    try {
      // Merge local adjustment edits into the sim data for this run
      const simDataWithEdits = {
        ...simData,
        adjustments,
      };
      const results = await runTournamentSim(simDataWithEdits, config, (p) => {
        setProgress(p);
      });
      setSimResults(results);
    } catch (simError) {
      setError(
        simError instanceof Error ? simError.message : "Simulation failed",
      );
    } finally {
      setSimulating(false);
      setProgress(1);
    }
  }, [simData, config]);

  if (loading) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          Loading simulation data...
        </CardContent>
      </Card>
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
    { id: "adjustments", label: "Adjustments & Injuries" },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <CardTitle>Playoff Simulator</CardTitle>
            <CardDescription>
              Monte Carlo simulation of the NBA playoff bracket using team net
              ratings and Dirichlet-distributed player scoring.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <select
              className="h-9 appearance-none rounded-lg border border-input bg-background px-3 pr-8 text-sm"
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
              className="shrink-0"
            >
              {simulating
                ? `Simulating... ${Math.round(progress * 100)}%`
                : simResults
                  ? `Re-run (${config.sims.toLocaleString()} sims)`
                  : `Run Simulation (${config.sims.toLocaleString()})`}
            </Button>
          </div>
        </CardHeader>
        {simResults ? (
          <CardContent>
            <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
              <span>
                Model:{" "}
                <span className="font-medium text-foreground">
                  {config.model === "netrtg"
                    ? "Net Rating"
                    : config.model === "lebron"
                      ? "LEBRON"
                      : "Blend"}
                </span>
              </span>
              <span>
                Sims:{" "}
                <span className="tabular-nums font-medium text-foreground">
                  {config.sims.toLocaleString()}
                </span>
              </span>
              <span>
                Stdev:{" "}
                <span className="tabular-nums font-medium text-foreground">
                  {config.stdev}
                </span>
              </span>
              <span>
                HCA:{" "}
                <span className="tabular-nums font-medium text-foreground">
                  {config.hca}
                </span>
              </span>
              <span>
                Players tracked:{" "}
                <span className="tabular-nums font-medium text-foreground">
                  {simResults.players.length}
                </span>
              </span>
            </div>
          </CardContent>
        ) : null}
      </Card>

      <div className="flex flex-nowrap gap-1 overflow-x-auto rounded-2xl border border-border/80 bg-background/90 p-2 sm:gap-2">
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

      {subTab === "bracket" ? (
        <BracketView simData={simData} simResults={simResults} />
      ) : null}

      {subTab === "adjustments" && simData ? (
        <AdjustmentsView
          simData={simData}
          adjustments={adjustments}
          injuries={simData.injuries}
          onUpdateAdjustment={(espnId, field, value) => {
            setLocalAdjustments((prev) => {
              const current = prev ?? simData.adjustments ?? [];
              const idx = current.findIndex((a) => a.espn_id === espnId);
              if (idx >= 0) {
                const updated = [...current];
                updated[idx] = { ...updated[idx], [field]: value };
                return updated;
              }
              // Find the player in simData to create a new adjustment
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
                  [field]: value,
                },
              ];
            });
          }}
          onResetAdjustments={() => setLocalAdjustments(null)}
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
                    <th className="px-3 py-2 text-right font-medium">Champ%</th>
                  </tr>
                </thead>
                <tbody>
                  {simResults.teams.map((team) => (
                    <tr key={team.team} className="border-t border-border/60">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <img
                            src={teamLogoUrl(team.team)}
                            alt={team.team}
                            width={20}
                            height={20}
                          />
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
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Run a simulation to see team advancement probabilities.
          </CardContent>
        </Card>
      ) : null}

      {subTab === "players" ? (
        <Card>
          <CardHeader>
            <CardTitle>Player Ratings{simResults ? " & Projections" : ""}</CardTitle>
            <CardDescription>
              {simResults
                ? "LEBRON offensive + defensive ratings with simulated fantasy point projections."
                : "LEBRON offensive + defensive ratings. Run a simulation to see projected fantasy points."}
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
                        <th className="px-3 py-2 text-right font-medium">R1</th>
                        <th className="px-3 py-2 text-right font-medium">R2</th>
                        <th className="px-3 py-2 text-right font-medium">CF</th>
                        <th className="px-3 py-2 text-right font-medium">Finals</th>
                      </>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {(simResults
                    ? simResults.players.slice(0, 150)
                    : simData!.simPlayers
                        .slice()
                        .sort((a, b) => b.lebron - a.lebron)
                        .slice(0, 150)
                  ).map((player, idx) => {
                    const raw = playerRatingLookup.get(
                      "espnId" in player ? player.espnId : (player as any).espn_id,
                    );
                    const espnId = "espnId" in player ? player.espnId : (player as any).espn_id;
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
                          {raw?.name ?? (player as any).name}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {raw?.team ?? (player as any).team}
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
                              <td
                                key={ri}
                                className="px-3 py-2 text-right tabular-nums text-muted-foreground"
                              >
                                {pts.toFixed(0)}
                              </td>
                            ))}
                          </>
                        ) : simResults ? (
                          <td colSpan={6} className="px-3 py-2 text-muted-foreground/50">
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

function teamLogoUrl(team: string): string {
  const ESPN_ABBR: Record<string, string> = {
    NY: "nyk",
    SA: "sa",
    GS: "gs",
    PHX: "phx",
  };
  const abbr = (ESPN_ABBR[team] ?? team).toLowerCase();
  return `https://cdn.espn.com/combiner/i?img=/i/teamlogos/nba/500/${abbr}.png&h=40&w=40`;
}

function PctCell({ value, bold }: { value: number; bold?: boolean }) {
  const opacity = Math.min(1, value / 50);
  return (
    <td className="px-3 py-2 text-right tabular-nums">
      <span
        className={[
          "inline-block min-w-[3rem] rounded-md px-1.5 py-0.5",
          bold ? "font-semibold" : "font-normal",
          value > 0
            ? "text-foreground"
            : "text-muted-foreground/50",
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
