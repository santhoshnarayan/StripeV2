"use client";

import Link from "next/link";
import { startTransition, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { appApiFetch } from "@/lib/app-api";

type DashboardData = {
  currentUser: {
    id: string;
    name: string;
    email: string;
    canCreateLeague: boolean;
  };
  leagues: Array<{
    id: string;
    name: string;
    phase: string;
    rosterSize: number;
    memberCount: number;
    role: string;
    isCommissioner: boolean;
    commissionerName: string;
  }>;
  pendingInvites: Array<{
    id: string;
    leagueId: string;
    leagueName: string;
    invitedByName: string;
    createdAt: string;
  }>;
};

const PHASE_LABELS: Record<string, string> = {
  invite: "Invite",
  draft: "Draft",
  scoring: "Scoring",
};

export function HomeDashboard() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [createName, setCreateName] = useState("");
  const [createRosterSize, setCreateRosterSize] = useState("10");
  const [createError, setCreateError] = useState("");
  const [createPending, setCreatePending] = useState(false);
  const [inviteActionId, setInviteActionId] = useState<string | null>(null);

  async function loadDashboard() {
    setLoading(true);
    setError("");

    try {
      const payload = await appApiFetch<DashboardData>("/dashboard");
      setData(payload);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadDashboard();
  }, []);

  async function handleCreateLeague(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreatePending(true);
    setCreateError("");

    try {
      const payload = await appApiFetch<{ leagueId: string }>("/leagues", {
        method: "POST",
        body: JSON.stringify({
          name: createName,
          rosterSize: Number(createRosterSize),
        }),
      });

      setCreateName("");
      setCreateRosterSize("10");

      startTransition(() => {
        router.push(`/leagues/${payload.leagueId}`);
      });
    } catch (createLeagueError) {
      setCreateError(
        createLeagueError instanceof Error
          ? createLeagueError.message
          : "Failed to create league",
      );
    } finally {
      setCreatePending(false);
    }
  }

  async function acceptInvite(inviteId: string, leagueId: string) {
    setInviteActionId(inviteId);
    setError("");

    try {
      await appApiFetch(`/invites/${inviteId}/accept`, {
        method: "POST",
      });

      startTransition(() => {
        router.push(`/leagues/${leagueId}`);
      });
    } catch (acceptError) {
      setError(
        acceptError instanceof Error ? acceptError.message : "Failed to accept invite",
      );
    } finally {
      setInviteActionId(null);
    }
  }

  if (loading) {
    return (
      <main className="mx-auto flex w-full max-w-6xl px-4 py-12 sm:px-6 lg:px-8">
        <p className="text-sm text-muted-foreground">Loading leagues...</p>
      </main>
    );
  }

  if (error && !data) {
    return (
      <main className="mx-auto flex w-full max-w-6xl px-4 py-12 sm:px-6 lg:px-8">
        <Card className="w-full max-w-xl">
          <CardHeader>
            <CardTitle>Unable to load your dashboard</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
          <CardFooter>
            <Button onClick={() => void loadDashboard()}>Retry</Button>
          </CardFooter>
        </Card>
      </main>
    );
  }

  if (!data) {
    return null;
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-10 sm:px-6 lg:px-8">
      <section className="space-y-2">
        <p className="text-xs font-semibold tracking-[0.25em] text-muted-foreground uppercase">
          League Hub
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          {data.currentUser.name}
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground sm:text-base">
          Create leagues, manage invites, run blind playoff auctions, and review live standings.
        </p>
      </section>

      {error ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <Card>
          <CardHeader>
            <CardTitle>Your Leagues</CardTitle>
            <CardDescription>
              View league state, invite managers, and run the next auction round.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.leagues.length ? (
              data.leagues.map((league) => (
                <Link
                  key={league.id}
                  href={`/leagues/${league.id}`}
                  className="block rounded-xl border border-border/80 bg-background px-4 py-4 transition hover:border-foreground/20 hover:bg-muted/30"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <p className="font-medium text-foreground">{league.name}</p>
                      <p className="text-sm text-muted-foreground">
                        Commissioner: {league.commissionerName}
                      </p>
                    </div>
                    <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-foreground">
                      {PHASE_LABELS[league.phase] ?? league.phase}
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
                    <span>{league.memberCount} managers</span>
                    <span>{league.rosterSize} roster spots</span>
                    <span>{league.isCommissioner ? "Commissioner" : league.role}</span>
                  </div>
                </Link>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                You are not in any leagues yet.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>League Creation</CardTitle>
            <CardDescription>
              New leagues are restricted to the commissioner account for now.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.currentUser.canCreateLeague ? (
              <form className="space-y-4" onSubmit={handleCreateLeague}>
                <div className="space-y-2">
                  <Label htmlFor="league-name">League Name</Label>
                  <Input
                    id="league-name"
                    value={createName}
                    onChange={(event) => setCreateName(event.target.value)}
                    placeholder="Founders League"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="roster-size">Roster Size</Label>
                  <Input
                    id="roster-size"
                    type="number"
                    min={8}
                    max={12}
                    value={createRosterSize}
                    onChange={(event) => setCreateRosterSize(event.target.value)}
                    required
                  />
                </div>
                {createError ? (
                  <p className="text-sm text-destructive">{createError}</p>
                ) : null}
                <Button type="submit" disabled={createPending}>
                  {createPending ? "Creating league..." : "Create League"}
                </Button>
              </form>
            ) : (
              <p className="text-sm text-muted-foreground">
                Only `santhoshnarayan@gmail.com` can create leagues in this MVP.
              </p>
            )}
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Pending Invites</CardTitle>
          <CardDescription>
            Invitations sent to your email can be accepted here after sign-up.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.pendingInvites.length ? (
            data.pendingInvites.map((invite) => (
              <div
                key={invite.id}
                className="flex flex-col gap-3 rounded-xl border border-border/80 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-medium text-foreground">{invite.leagueName}</p>
                  <p className="text-sm text-muted-foreground">
                    Invited by {invite.invitedByName}
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() => void acceptInvite(invite.id, invite.leagueId)}
                  disabled={inviteActionId === invite.id}
                >
                  {inviteActionId === invite.id ? "Joining..." : "Accept Invite"}
                </Button>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">No pending invites.</p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
