"use client";

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
  defaultBid: number;
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

export function PlayersView() {
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [assumption, setAssumption] = useState<AuctionAssumption>(DEFAULT_ASSUMPTION);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    let active = true;

    async function loadPlayers() {
      setLoading(true);
      setError("");

      try {
        const payload = await appApiFetch<PlayersPayload>("/players");

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
    }

    void loadPlayers();

    return () => {
      active = false;
    };
  }, []);

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
          Full playoff pool with regular-season stats, suggested values, default bids,
          and projected playoff scoring totals from the current CSV.
        </p>
        <p className="max-w-3xl rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Dollar values below assume a {assumption.managers}-manager league where each
          team drafts {assumption.rosterSize} players from a ${assumption.budgetPerTeam}{" "}
          budget (min bid ${assumption.minBid}). Values are calculated as Value Over
          Replacement Player — your own league&apos;s page will show values tuned to its
          settings.
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
            <CardTitle className="text-sm text-muted-foreground">Visible Without Login</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Search and browse the pool before joining a league.
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
                    <th className="px-3 py-3 font-medium">Rank</th>
                    <th className="px-3 py-3 font-medium">Player</th>
                    <th className="px-3 py-3 font-medium">Team</th>
                    <th className="px-3 py-3 font-medium">Seed</th>
                    <th className="px-3 py-3 font-medium">GP</th>
                    <th className="px-3 py-3 font-medium">MPG</th>
                    <th className="px-3 py-3 font-medium">PPG</th>
                    <th className="px-3 py-3 font-medium">Value</th>
                    <th className="px-3 py-3 font-medium">Default</th>
                    <th className="px-3 py-3 font-medium">Proj. Pts</th>
                    <th className="px-3 py-3 font-medium">Proj. GP</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPlayers.map((player) => (
                    <tr key={player.id} className="border-t border-border/70">
                      <td className="px-3 py-3 text-muted-foreground">{player.rank}</td>
                      <td className="px-3 py-3">
                        <div className="font-medium text-foreground">{player.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {player.conference} Conference
                        </div>
                      </td>
                      <td className="px-3 py-3 text-muted-foreground">{player.team}</td>
                      <td className="px-3 py-3 text-muted-foreground">
                        {player.seed ?? "-"}
                      </td>
                      <td className="px-3 py-3 text-muted-foreground">
                        {formatNullableNumber(player.gamesPlayed, 0)}
                      </td>
                      <td className="px-3 py-3 text-muted-foreground">
                        {formatNullableNumber(player.minutesPerGame)}
                      </td>
                      <td className="px-3 py-3 text-muted-foreground">
                        {formatNullableNumber(player.pointsPerGame)}
                      </td>
                      <td className="px-3 py-3 font-medium text-foreground">
                        ${player.suggestedValue}
                      </td>
                      <td className="px-3 py-3 text-muted-foreground">${player.defaultBid}</td>
                      <td className="px-3 py-3 text-muted-foreground">
                        {formatNullableNumber(player.totalPoints)}
                      </td>
                      <td className="px-3 py-3 text-muted-foreground">
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
