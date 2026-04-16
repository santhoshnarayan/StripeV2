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

type SimSubTab = "bracket" | "teams" | "players";

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
  const [subTab, setSubTab] = useState<SimSubTab>("bracket");
  const [config, setConfig] = useState<SimConfig>(DEFAULT_SIM_CONFIG);

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
      const results = await runTournamentSim(simData, config, (p) => {
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
    { id: "bracket", label: "Bracket" },
    { id: "teams", label: "Teams" },
    { id: "players", label: "Players" },
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

      {subTab === "players" && simResults ? (
        <Card>
          <CardHeader>
            <CardTitle>Player Projections</CardTitle>
            <CardDescription>
              Simulated fantasy point projections with per-round breakdown.
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
                    <th className="px-3 py-2 text-right font-medium">Proj Pts</th>
                    <th className="px-3 py-2 text-right font-medium">Proj GP</th>
                    <th className="px-3 py-2 text-right font-medium">R1</th>
                    <th className="px-3 py-2 text-right font-medium">R2</th>
                    <th className="px-3 py-2 text-right font-medium">CF</th>
                    <th className="px-3 py-2 text-right font-medium">Finals</th>
                  </tr>
                </thead>
                <tbody>
                  {simResults.players.slice(0, 100).map((player, idx) => (
                    <tr
                      key={player.espnId}
                      className="border-t border-border/60"
                    >
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {idx + 1}
                      </td>
                      <td className="px-3 py-2 font-medium text-foreground">
                        {player.name}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {player.team}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {player.ppg.toFixed(1)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-medium text-foreground">
                        {player.projectedPoints.toFixed(0)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {player.projectedGames.toFixed(1)}
                      </td>
                      {player.projectedPointsByRound.map((pts, ri) => (
                        <td
                          key={ri}
                          className="px-3 py-2 text-right tabular-nums text-muted-foreground"
                        >
                          {pts.toFixed(0)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : subTab === "players" && !simResults ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Run a simulation to see player projections.
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
