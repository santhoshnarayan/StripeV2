"use client";

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { appApiFetch } from "@/lib/app-api";

type PlayerRow = {
  rank: number;
  id: string;
  name: string;
  team: string;
  conference: string;
  seed: number | null;
  gamesPlayed: number | null;
  minutesPerGame: number | null;
  pointsPerGame: number | null;
  suggestedValue: number;
  totalPoints: number | null;
  totalGames: number | null;
};

type AuctionAssumption = {
  managers: number;
  rosterSize: number;
  budgetPerTeam: number;
  minBid: number;
};

type PlayersPayload = {
  assumption?: AuctionAssumption;
  players: PlayerRow[];
};

const DEFAULT_ASSUMPTION: AuctionAssumption = {
  managers: 8,
  rosterSize: 9,
  budgetPerTeam: 200,
  minBid: 1,
};

function formatNullableNumber(value: number | null, digits = 1) {
  if (value === null) {
    return "-";
  }

  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

const MIN_MANAGERS = 2;
const MAX_MANAGERS = 20;
const MIN_ROSTER = 1;
const MAX_ROSTER = 20;

export function PlayersView() {
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [assumption, setAssumption] = useState<AuctionAssumption>(DEFAULT_ASSUMPTION);
  const [managersInput, setManagersInput] = useState<string>(
    String(DEFAULT_ASSUMPTION.managers),
  );
  const [rosterSizeInput, setRosterSizeInput] = useState<string>(
    String(DEFAULT_ASSUMPTION.rosterSize),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);

  const managersValue = useMemo(() => {
    const parsed = Number.parseInt(managersInput, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_ASSUMPTION.managers;
    return Math.min(MAX_MANAGERS, Math.max(MIN_MANAGERS, parsed));
  }, [managersInput]);

  const rosterSizeValue = useMemo(() => {
    const parsed = Number.parseInt(rosterSizeInput, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_ASSUMPTION.rosterSize;
    return Math.min(MAX_ROSTER, Math.max(MIN_ROSTER, parsed));
  }, [rosterSizeInput]);

  useEffect(() => {
    let active = true;
    const handle = window.setTimeout(async () => {
      setLoading(true);
      setError("");

      try {
        const search = new URLSearchParams({
          managers: String(managersValue),
          rosterSize: String(rosterSizeValue),
        });
        const payload = await appApiFetch<PlayersPayload>(
          `/players?${search.toString()}`,
        );

        if (active) {
          setPlayers(payload.players);
          if (payload.assumption) {
            setAssumption(payload.assumption);
          }
        }
      } catch (loadError) {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load players");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }, 250);

    return () => {
      active = false;
      window.clearTimeout(handle);
    };
  }, [managersValue, rosterSizeValue]);

  const filteredPlayers = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase();

    if (!normalizedQuery) {
      return players;
    }

    return players.filter((player) =>
      [player.name, player.team, player.conference]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [deferredQuery, players]);

  return (
    <main className="mx-auto flex w-full max-w-[96rem] flex-col gap-6 px-4 py-10 sm:px-6 lg:px-8">
      <section className="space-y-2">
        <p className="text-xs font-semibold tracking-[0.25em] text-muted-foreground uppercase">
          Player Pool
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Players</h1>
        <p className="max-w-3xl text-sm text-muted-foreground sm:text-base">
          Full playoff pool with regular-season stats, projected playoff totals, and
          auction values tuned to the league shape below.
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Pool Size</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold text-foreground">{players.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Highest Value</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold text-foreground">
              ${players[0]?.suggestedValue ?? 0}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">League Shape</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-end gap-3">
              <div className="flex-1 space-y-1">
                <Label
                  htmlFor="players-managers"
                  className="text-[10px] uppercase tracking-wide text-muted-foreground"
                >
                  Managers
                </Label>
                <Input
                  id="players-managers"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={managersInput}
                  onChange={(event) => setManagersInput(event.target.value)}
                  className="h-8 text-right font-semibold tabular-nums"
                />
              </div>
              <span aria-hidden className="pb-2 text-sm text-muted-foreground">
                ×
              </span>
              <div className="flex-1 space-y-1">
                <Label
                  htmlFor="players-roster"
                  className="text-[10px] uppercase tracking-wide text-muted-foreground"
                >
                  Roster
                </Label>
                <Input
                  id="players-roster"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={rosterSizeInput}
                  onChange={(event) => setRosterSizeInput(event.target.value)}
                  className="h-8 text-right font-semibold tabular-nums"
                />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              ${assumption.budgetPerTeam} budget / ${assumption.minBid} min bid.
            </p>
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader className="gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <CardTitle>Player Table</CardTitle>
            <p className="text-sm text-muted-foreground">
              Default sorted by suggested dollar value descending.
            </p>
          </div>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search players, teams, or conference"
            className="w-full sm:max-w-sm"
          />
        </CardHeader>
        <CardContent>
          {loading ? <p className="text-sm text-muted-foreground">Loading players...</p> : null}
          {error ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}

          {!loading && !error ? (
            <div className="overflow-auto rounded-xl border border-border/80">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-muted/60 text-xs tracking-[0.18em] text-muted-foreground uppercase">
                  <tr>
                    <th className="px-3 py-3 text-right font-medium">Rank</th>
                    <th className="px-3 py-3 text-left font-medium">Player</th>
                    <th className="px-3 py-3 text-left font-medium">Team</th>
                    <th className="px-3 py-3 text-right font-medium">Seed</th>
                    <th className="px-3 py-3 text-right font-medium">GP</th>
                    <th className="px-3 py-3 text-right font-medium">MPG</th>
                    <th className="px-3 py-3 text-right font-medium">PPG</th>
                    <th className="px-3 py-3 text-right font-medium">Value</th>
                    <th className="px-3 py-3 text-right font-medium">Proj. Pts</th>
                    <th className="px-3 py-3 text-right font-medium">Proj. GP</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPlayers.map((player) => (
                    <tr key={player.id} className="border-t border-border/70">
                      <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                        {player.rank}
                      </td>
                      <td className="px-3 py-3">
                        <div className="font-medium text-foreground">{player.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {player.conference} Conference
                        </div>
                      </td>
                      <td className="px-3 py-3 text-muted-foreground">{player.team}</td>
                      <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                        {player.seed ?? "-"}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                        {formatNullableNumber(player.gamesPlayed, 0)}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                        {formatNullableNumber(player.minutesPerGame)}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                        {formatNullableNumber(player.pointsPerGame)}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums font-medium text-foreground">
                        ${player.suggestedValue}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                        {formatNullableNumber(player.totalPoints)}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                        {formatNullableNumber(player.totalGames)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!filteredPlayers.length ? (
                <div className="border-t border-border/70 px-4 py-6 text-sm text-muted-foreground">
                  No players match your search.
                </div>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
