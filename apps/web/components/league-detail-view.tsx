"use client";

import { startTransition, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
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

type LeagueDetail = {
  league: {
    id: string;
    name: string;
    phase: string;
    rosterSize: number;
    budgetPerTeam: number;
    minBid: number;
    commissionerUserId: string;
    commissionerName: string;
    isCommissioner: boolean;
    canEditRosterSize: boolean;
  };
  members: Array<{
    membershipId: string;
    userId: string;
    name: string;
    email: string;
    role: string;
    draftPriority: number | null;
    rosterCount: number;
    remainingBudget: number;
    remainingRosterSlots: number;
    totalPoints: number;
  }>;
  priorityOrder: Array<{
    userId: string;
    name: string;
    draftPriority: number | null;
  }>;
  pendingInvites: Array<{
    id: string;
    email: string;
    invitedByName: string;
    createdAt: string;
    status: string;
  }>;
  availablePlayers: Array<{
    id: string;
    name: string;
    team: string;
    conference: string;
    seed: number | null;
    suggestedValue: number;
    totalPoints: number | null;
  }>;
  currentRound: null | {
    id: string;
    roundNumber: number;
    status: string;
    eligiblePlayerMode: string;
    openedAt: string;
    deadlineAt: string | null;
    submissionStatuses: Array<{
      userId: string;
      name: string;
      submittedAt: string | null;
    }>;
    myMaxBid: number;
    players: Array<{
      id: string;
      name: string;
      team: string;
      conference: string;
      suggestedValue: number;
      totalPoints: number | null;
      defaultBid: number;
      myExplicitBid: number | null;
      myEffectiveBid: number;
    }>;
  };
  lastResolvedRound: null | {
    id: string;
    roundNumber: number;
    resolvedAt: string | null;
    results: Array<{
      order: number;
      playerId: string;
      playerName: string;
      playerTeam: string;
      winnerUserId: string;
      winnerName: string;
      winningBid: number;
      wonByTiebreak: boolean;
    }>;
  };
  rosters: Array<{
    userId: string;
    name: string;
    totalPoints: number;
    players: Array<{
      playerId: string;
      playerName: string;
      playerTeam: string;
      acquisitionBid: number;
      acquisitionOrder: number;
      acquiredInRoundId: string | null;
      totalPoints: number;
    }>;
  }>;
};

const PHASE_LABELS: Record<string, string> = {
  invite: "Invite",
  draft: "Draft",
  scoring: "Scoring",
};

export function LeagueDetailView({ leagueId }: { leagueId: string }) {
  const router = useRouter();
  const [data, setData] = useState<LeagueDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [inviteEmails, setInviteEmails] = useState("");
  const [inviteError, setInviteError] = useState("");
  const [invitePending, setInvitePending] = useState(false);
  const [rosterSize, setRosterSize] = useState("10");
  const [settingsError, setSettingsError] = useState("");
  const [settingsPending, setSettingsPending] = useState(false);
  const [roundMode, setRoundMode] = useState<"selected" | "all_remaining">("selected");
  const [deadlineAt, setDeadlineAt] = useState("");
  const [selectedPlayerIds, setSelectedPlayerIds] = useState<string[]>([]);
  const [openRoundError, setOpenRoundError] = useState("");
  const [openRoundPending, setOpenRoundPending] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [submitPending, setSubmitPending] = useState(false);
  const [closePending, setClosePending] = useState(false);
  const [memberActionId, setMemberActionId] = useState<string | null>(null);
  const [bidValues, setBidValues] = useState<Record<string, string>>({});

  async function loadLeague() {
    setLoading(true);
    setError("");

    try {
      const payload = await appApiFetch<LeagueDetail>(`/leagues/${leagueId}`);
      setData(payload);
      setRosterSize(String(payload.league.rosterSize));
      setSelectedPlayerIds([]);
      setBidValues(
        payload.currentRound
          ? Object.fromEntries(
              payload.currentRound.players
                .filter((player) => player.myExplicitBid !== null)
                .map((player) => [player.id, String(player.myExplicitBid)]),
            )
          : {},
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load league");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadLeague();
  }, [leagueId]);

  const invalidBidMessage = useMemo(() => {
    if (!data?.currentRound) {
      return "";
    }

    for (const [playerId, value] of Object.entries(bidValues)) {
      if (!value.trim()) {
        continue;
      }

      const bid = Number(value);
      const player = data.currentRound.players.find((entry) => entry.id === playerId);

      if (!player || !Number.isInteger(bid)) {
        return "Bids must be whole numbers.";
      }

      if (bid < data.league.minBid) {
        return `Bids must be at least $${data.league.minBid}.`;
      }

      if (bid > data.currentRound.myMaxBid) {
        return `Bids cannot exceed your max allowed bid of $${data.currentRound.myMaxBid}.`;
      }
    }

    return "";
  }, [bidValues, data]);

  async function updateRosterSize(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSettingsPending(true);
    setSettingsError("");

    try {
      await appApiFetch(`/leagues/${leagueId}/settings`, {
        method: "POST",
        body: JSON.stringify({
          rosterSize: Number(rosterSize),
        }),
      });

      await loadLeague();
    } catch (settingsUpdateError) {
      setSettingsError(
        settingsUpdateError instanceof Error
          ? settingsUpdateError.message
          : "Failed to update settings",
      );
    } finally {
      setSettingsPending(false);
    }
  }

  async function inviteMembers(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInvitePending(true);
    setInviteError("");

    try {
      const emails = inviteEmails
        .split(/[\n,]/)
        .map((email) => email.trim())
        .filter(Boolean);

      await appApiFetch(`/leagues/${leagueId}/invites`, {
        method: "POST",
        body: JSON.stringify({ emails }),
      });

      setInviteEmails("");
      await loadLeague();
    } catch (inviteMembersError) {
      setInviteError(
        inviteMembersError instanceof Error
          ? inviteMembersError.message
          : "Failed to send invites",
      );
    } finally {
      setInvitePending(false);
    }
  }

  async function removeMember(userId: string) {
    setMemberActionId(userId);
    setError("");

    try {
      await appApiFetch(`/leagues/${leagueId}/members/${userId}/remove`, {
        method: "POST",
      });

      await loadLeague();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Failed to remove member");
    } finally {
      setMemberActionId(null);
    }
  }

  async function openRound(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setOpenRoundPending(true);
    setOpenRoundError("");

    try {
      await appApiFetch(`/leagues/${leagueId}/draft/rounds`, {
        method: "POST",
        body: JSON.stringify({
          mode: roundMode,
          playerIds: roundMode === "selected" ? selectedPlayerIds : undefined,
          deadlineAt: deadlineAt ? new Date(deadlineAt).toISOString() : null,
        }),
      });

      setSelectedPlayerIds([]);
      setDeadlineAt("");
      await loadLeague();
    } catch (openRoundActionError) {
      setOpenRoundError(
        openRoundActionError instanceof Error
          ? openRoundActionError.message
          : "Failed to open round",
      );
    } finally {
      setOpenRoundPending(false);
    }
  }

  async function submitBids() {
    if (!data?.currentRound) {
      return;
    }

    if (invalidBidMessage) {
      setSubmitError(invalidBidMessage);
      return;
    }

    setSubmitPending(true);
    setSubmitError("");

    try {
      const bids = Object.fromEntries(
        Object.entries(bidValues)
          .filter(([, value]) => value.trim())
          .map(([playerId, value]) => [playerId, Number(value)]),
      );

      await appApiFetch(
        `/leagues/${leagueId}/draft/rounds/${data.currentRound.id}/submission`,
        {
          method: "POST",
          body: JSON.stringify({ bids }),
        },
      );

      await loadLeague();
    } catch (submitBidsError) {
      setSubmitError(
        submitBidsError instanceof Error ? submitBidsError.message : "Failed to submit bids",
      );
    } finally {
      setSubmitPending(false);
    }
  }

  async function closeRound() {
    if (!data?.currentRound) {
      return;
    }

    setClosePending(true);
    setError("");

    try {
      await appApiFetch(
        `/leagues/${leagueId}/draft/rounds/${data.currentRound.id}/close`,
        {
          method: "POST",
        },
      );

      await loadLeague();
    } catch (closeRoundError) {
      setError(
        closeRoundError instanceof Error ? closeRoundError.message : "Failed to close round",
      );
    } finally {
      setClosePending(false);
    }
  }

  if (loading) {
    return (
      <main className="mx-auto flex w-full max-w-6xl px-4 py-12 sm:px-6 lg:px-8">
        <p className="text-sm text-muted-foreground">Loading league...</p>
      </main>
    );
  }

  if (error && !data) {
    return (
      <main className="mx-auto flex w-full max-w-6xl px-4 py-12 sm:px-6 lg:px-8">
        <Card className="w-full max-w-xl">
          <CardHeader>
            <CardTitle>Unable to load league</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
          <CardFooter>
            <Button onClick={() => void loadLeague()}>Retry</Button>
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
        <button
          type="button"
          className="text-sm text-muted-foreground underline underline-offset-4"
          onClick={() => startTransition(() => router.push("/"))}
        >
          Back to leagues
        </button>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-2">
            <p className="text-xs font-semibold tracking-[0.25em] text-muted-foreground uppercase">
              {PHASE_LABELS[data.league.phase] ?? data.league.phase}
            </p>
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">
              {data.league.name}
            </h1>
            <p className="text-sm text-muted-foreground">
              Commissioner: {data.league.commissionerName}
            </p>
          </div>
          <div className="rounded-2xl border border-border/80 bg-background px-4 py-3 text-sm text-muted-foreground">
            <p>Roster size: {data.league.rosterSize}</p>
            <p>Budget: ${data.league.budgetPerTeam}</p>
            <p>Min bid: ${data.league.minBid}</p>
          </div>
        </div>
      </section>

      {error ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Tiebreak Priority</CardTitle>
            <CardDescription>
              Public order used to break tied bids. Winning a tiebreak moves that team to the end.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.priorityOrder.length ? (
              data.priorityOrder.map((member) => (
                <div
                  key={member.userId}
                  className="flex items-center justify-between rounded-lg border border-border/70 px-3 py-2 text-sm"
                >
                  <span>{member.name}</span>
                  <span className="text-muted-foreground">#{member.draftPriority}</span>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                Priority order will be generated automatically when the commissioner opens the first draft round.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>League Settings</CardTitle>
            <CardDescription>
              Commissioners can adjust roster size before scoring and while no round is open.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.league.isCommissioner ? (
              <form className="space-y-4" onSubmit={updateRosterSize}>
                <div className="space-y-2">
                  <Label htmlFor="roster-size-settings">Roster Size</Label>
                  <Input
                    id="roster-size-settings"
                    type="number"
                    min={8}
                    max={12}
                    value={rosterSize}
                    onChange={(event) => setRosterSize(event.target.value)}
                    required
                    disabled={!data.league.canEditRosterSize}
                  />
                </div>
                {settingsError ? (
                  <p className="text-sm text-destructive">{settingsError}</p>
                ) : null}
                <Button
                  type="submit"
                  disabled={settingsPending || !data.league.canEditRosterSize}
                >
                  {settingsPending ? "Saving..." : "Save Settings"}
                </Button>
              </form>
            ) : (
              <p className="text-sm text-muted-foreground">
                Only the commissioner can change league settings.
              </p>
            )}
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Managers</CardTitle>
            <CardDescription>Up to 16 active managers can participate in a league.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.members.map((member) => (
              <div
                key={member.userId}
                className="rounded-xl border border-border/80 px-4 py-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-foreground">{member.name}</p>
                    <p className="text-sm text-muted-foreground">{member.email}</p>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <p>{member.role}</p>
                    <p>Priority {member.draftPriority ?? "TBD"}</p>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span>{member.rosterCount} players</span>
                  <span>${member.remainingBudget} left</span>
                  <span>{member.remainingRosterSlots} spots left</span>
                  <span>{member.totalPoints} points</span>
                </div>
                {data.league.isCommissioner && member.role !== "commissioner" ? (
                  <div className="mt-3">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void removeMember(member.userId)}
                      disabled={memberActionId === member.userId}
                    >
                      {memberActionId === member.userId ? "Removing..." : "Remove"}
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Invites</CardTitle>
            <CardDescription>
              Invite by email now; recipients can sign up later using the same address.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {data.league.isCommissioner ? (
              <form className="space-y-3" onSubmit={inviteMembers}>
                <div className="space-y-2">
                  <Label htmlFor="invite-emails">Invite Emails</Label>
                  <Input
                    id="invite-emails"
                    value={inviteEmails}
                    onChange={(event) => setInviteEmails(event.target.value)}
                    placeholder="one@example.com, two@example.com"
                    required
                  />
                </div>
                {inviteError ? <p className="text-sm text-destructive">{inviteError}</p> : null}
                <Button type="submit" disabled={invitePending}>
                  {invitePending ? "Sending..." : "Send Invites"}
                </Button>
              </form>
            ) : (
              <p className="text-sm text-muted-foreground">
                Only the commissioner can send invites.
              </p>
            )}

            <div className="space-y-2">
              {data.pendingInvites.length ? (
                data.pendingInvites.map((invite) => (
                  <div
                    key={invite.id}
                    className="rounded-lg border border-border/70 px-3 py-3 text-sm"
                  >
                    <p className="font-medium text-foreground">{invite.email}</p>
                    <p className="text-muted-foreground">
                      Invited by {invite.invitedByName}
                    </p>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">No pending invites.</p>
              )}
            </div>
          </CardContent>
        </Card>
      </section>

      {data.currentRound ? (
        <Card>
          <CardHeader>
            <CardTitle>Round {data.currentRound.roundNumber}</CardTitle>
            <CardDescription>
              Blind bids stay encrypted until the commissioner closes the round.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
              <span>Format: {data.currentRound.eligiblePlayerMode.replace("_", " ")}</span>
              <span>Max bid: ${data.currentRound.myMaxBid}</span>
              <span>
                Deadline:
                {" "}
                {data.currentRound.deadlineAt
                  ? new Date(data.currentRound.deadlineAt).toLocaleString()
                  : "None"}
              </span>
            </div>

            <div className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
              <div className="space-y-2">
                <p className="text-sm font-medium text-foreground">Submission Status</p>
                {data.currentRound.submissionStatuses.map((submission) => (
                  <div
                    key={submission.userId}
                    className="flex items-center justify-between rounded-lg border border-border/70 px-3 py-2 text-sm"
                  >
                    <span>{submission.name}</span>
                    <span className="text-muted-foreground">
                      {submission.submittedAt
                        ? `Submitted ${new Date(submission.submittedAt).toLocaleTimeString()}`
                        : "Waiting"}
                    </span>
                  </div>
                ))}
              </div>

              <div className="space-y-3">
                <p className="text-sm font-medium text-foreground">Eligible Players</p>
                <div className="max-h-[30rem] overflow-auto rounded-xl border border-border/80">
                  <table className="min-w-full text-left text-sm">
                    <thead className="bg-muted/60 text-xs tracking-[0.18em] text-muted-foreground uppercase">
                      <tr>
                        <th className="px-3 py-3 font-medium">Player</th>
                        <th className="px-3 py-3 font-medium">Team</th>
                        <th className="px-3 py-3 font-medium">Suggested</th>
                        <th className="px-3 py-3 font-medium">Default</th>
                        <th className="px-3 py-3 font-medium">Your Bid</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.currentRound.players.map((player) => (
                        <tr key={player.id} className="border-t border-border/70">
                          <td className="px-3 py-3 font-medium text-foreground">
                            <div>{player.name}</div>
                            <div className="text-xs text-muted-foreground">{player.conference}</div>
                          </td>
                          <td className="px-3 py-3 text-muted-foreground">{player.team}</td>
                          <td className="px-3 py-3 text-muted-foreground">${player.suggestedValue}</td>
                          <td className="px-3 py-3 text-muted-foreground">${player.defaultBid}</td>
                          <td className="px-3 py-3">
                              <Input
                                type="number"
                                min={data.league.minBid}
                                max={data.currentRound?.myMaxBid ?? 0}
                                placeholder={`Default $${player.defaultBid}`}
                                value={bidValues[player.id] ?? ""}
                                onChange={(event) =>
                                setBidValues((current) => ({
                                  ...current,
                                  [player.id]: event.target.value,
                                }))
                              }
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {submitError || invalidBidMessage ? (
                  <p className="text-sm text-destructive">{submitError || invalidBidMessage}</p>
                ) : null}
                <div className="flex flex-wrap gap-3">
                  <Button onClick={() => void submitBids()} disabled={submitPending}>
                    {submitPending ? "Submitting..." : "Submit / Update Bids"}
                  </Button>
                  {data.league.isCommissioner ? (
                    <Button
                      variant="outline"
                      onClick={() => void closeRound()}
                      disabled={closePending}
                    >
                      {closePending ? "Closing..." : "Close Round and Reveal"}
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : data.league.isCommissioner && data.league.phase !== "scoring" ? (
        <Card>
          <CardHeader>
            <CardTitle>Open the Next Round</CardTitle>
            <CardDescription>
              Choose a curated list of players or expose all remaining players for bidding.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={openRound}>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="round-mode">Eligible Players</Label>
                  <select
                    id="round-mode"
                    className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
                    value={roundMode}
                    onChange={(event) => setRoundMode(event.target.value as "selected" | "all_remaining")}
                  >
                    <option value="selected">Selected players</option>
                    <option value="all_remaining">All remaining players</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="round-deadline">Helpful Deadline</Label>
                  <Input
                    id="round-deadline"
                    type="datetime-local"
                    value={deadlineAt}
                    onChange={(event) => setDeadlineAt(event.target.value)}
                  />
                </div>
              </div>

              {roundMode === "selected" ? (
                <div className="max-h-[28rem] overflow-auto rounded-xl border border-border/80">
                  <table className="min-w-full text-left text-sm">
                    <thead className="bg-muted/60 text-xs tracking-[0.18em] text-muted-foreground uppercase">
                      <tr>
                        <th className="px-3 py-3 font-medium">Pick</th>
                        <th className="px-3 py-3 font-medium">Player</th>
                        <th className="px-3 py-3 font-medium">Team</th>
                        <th className="px-3 py-3 font-medium">Suggested</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.availablePlayers.map((player) => {
                        const checked = selectedPlayerIds.includes(player.id);

                        return (
                          <tr key={player.id} className="border-t border-border/70">
                            <td className="px-3 py-3">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(event) =>
                                  setSelectedPlayerIds((current) =>
                                    event.target.checked
                                      ? [...current, player.id]
                                      : current.filter((playerId) => playerId !== player.id),
                                  )
                                }
                              />
                            </td>
                            <td className="px-3 py-3 font-medium text-foreground">{player.name}</td>
                            <td className="px-3 py-3 text-muted-foreground">{player.team}</td>
                            <td className="px-3 py-3 text-muted-foreground">${player.suggestedValue}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  All {data.availablePlayers.length} remaining players will be open for bidding.
                </p>
              )}

              {openRoundError ? (
                <p className="text-sm text-destructive">{openRoundError}</p>
              ) : null}
              <Button type="submit" disabled={openRoundPending}>
                {openRoundPending ? "Opening..." : "Open Round"}
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {data.lastResolvedRound ? (
        <Card>
          <CardHeader>
            <CardTitle>Latest Reveal</CardTitle>
            <CardDescription>
              Round {data.lastResolvedRound.roundNumber} blind auction results.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.lastResolvedRound.results.length ? (
              data.lastResolvedRound.results.map((result) => (
                <div
                  key={result.playerId}
                  className="rounded-xl border border-border/80 px-4 py-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-foreground">
                        #{result.order} {result.playerName}
                      </p>
                      <p className="text-sm text-muted-foreground">{result.playerTeam}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-medium text-foreground">{result.winnerName}</p>
                      <p className="text-sm text-muted-foreground">
                        ${result.winningBid}
                        {result.wonByTiebreak ? " after tiebreak" : ""}
                      </p>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No players were awarded in the latest round.</p>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Standings and Rosters</CardTitle>
          <CardDescription>
            Scores currently use playoff total points from the player pool CSV.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2">
          {data.rosters.map((roster) => (
            <div key={roster.userId} className="rounded-xl border border-border/80 px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium text-foreground">{roster.name}</p>
                  <p className="text-sm text-muted-foreground">{roster.totalPoints} points</p>
                </div>
                <p className="text-sm text-muted-foreground">{roster.players.length} players</p>
              </div>
              <div className="mt-4 space-y-2">
                {roster.players.length ? (
                  roster.players.map((player) => (
                    <div
                      key={player.playerId}
                      className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2 text-sm"
                    >
                      <div>
                        <p className="font-medium text-foreground">{player.playerName}</p>
                        <p className="text-muted-foreground">{player.playerTeam}</p>
                      </div>
                      <div className="text-right text-muted-foreground">
                        <p>${player.acquisitionBid}</p>
                        <p>{player.totalPoints} pts</p>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">No drafted players yet.</p>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </main>
  );
}
