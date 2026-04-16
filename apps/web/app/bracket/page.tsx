"use client";

import { useCallback, useEffect, useState } from "react";
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
} from "@/lib/sim";

export default function BracketPage() {
  const [simData, setSimData] = useState<SimData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [simResults, setSimResults] = useState<SimResults | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [config, setConfig] = useState<SimConfig>(DEFAULT_SIM_CONFIG);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const data = await appApiFetch<SimData>(`/sim-data?v=${Date.now()}`);
        if (active) setSimData(data);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Failed to load");
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
    await new Promise((r) => setTimeout(r, 0));
    try {
      const results = await runTournamentSim(simData, config, (p) =>
        setProgress(p),
      );
      setSimResults(results);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Simulation failed");
    } finally {
      setSimulating(false);
      setProgress(1);
    }
  }, [simData, config]);

  return (
    <main className="mx-auto flex w-full max-w-[96rem] flex-col gap-6 px-4 py-10 sm:px-6 lg:px-8">
      <section className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-muted-foreground">
          2025-26 NBA Playoffs
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          Bracket &amp; Simulator
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground sm:text-base">
          Monte Carlo simulation of the playoff bracket using player LEBRON
          ratings and projected playoff minutes. Run a simulation to see team
          advancement probabilities and player fantasy point projections.
        </p>
      </section>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <CardTitle>Playoff Simulator</CardTitle>
            <CardDescription>
              {loading
                ? "Loading bracket data..."
                : error && !simData
                  ? error
                  : `${simData?.simPlayers.length ?? 0} players across ${Object.keys(simData?.playoffMinutes ?? {}).length} teams`}
            </CardDescription>
          </div>
          {simData ? (
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
                disabled={simulating || loading}
              >
                {simulating
                  ? `Simulating... ${Math.round(progress * 100)}%`
                  : simResults
                    ? `Re-run (${config.sims.toLocaleString()})`
                    : `Run Simulation (${config.sims.toLocaleString()})`}
              </Button>
            </div>
          ) : null}
        </CardHeader>
        {simResults ? (
          <CardContent>
            <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
              <span>
                Model:{" "}
                <span className="font-medium text-foreground">
                  {config.model === "lebron"
                    ? "Player Ratings"
                    : config.model === "netrtg"
                      ? "Net Rating"
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
                Favorite:{" "}
                <span className="font-medium text-foreground">
                  {simResults.teams[0].team} ({simResults.teams[0].champ.toFixed(1)}%)
                </span>
              </span>
            </div>
          </CardContent>
        ) : null}
      </Card>

      {simData ? (
        <BracketView simData={simData} simResults={simResults} />
      ) : null}

      {simResults ? (
        <Card>
          <CardHeader>
            <CardTitle>Team Advancement</CardTitle>
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
                  {simResults.teams
                    .filter((t) => t.r1 > 0 || t.champ > 0)
                    .map((team) => (
                      <tr key={team.team} className="border-t border-border/60">
                        <td className="px-3 py-2 font-medium text-foreground">
                          {team.team}{" "}
                          <span className="text-xs text-muted-foreground">
                            {team.fullName}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {team.seed ?? "PI"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {team.rating.toFixed(1)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {team.r1 > 0 ? team.r1.toFixed(1) : "—"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {team.r2 > 0 ? team.r2.toFixed(1) : "—"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {team.cf > 0 ? team.cf.toFixed(1) : "—"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {team.finals > 0 ? team.finals.toFixed(1) : "—"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium text-foreground">
                          {team.champ > 0 ? team.champ.toFixed(1) : "—"}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </main>
  );
}
