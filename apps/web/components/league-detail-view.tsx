"use client";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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

const POLL_INTERVAL_MS = 8_000;
const POLL_INACTIVE_TIMEOUT_MS = 3 * 60_000;

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
    gamesPlayed: number | null;
    minutesPerGame: number | null;
    pointsPerGame: number | null;
    suggestedValue: number;
    totalPoints: number | null;
    totalGames: number | null;
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
      seed: number | null;
      gamesPlayed: number | null;
      minutesPerGame: number | null;
      pointsPerGame: number | null;
      suggestedValue: number;
      totalPoints: number | null;
      totalGames: number | null;
      defaultBid: number;
      myExplicitBid: number | null;
      myEffectiveBid: number;
    }>;
  };
  draftHistory: Array<{
    id: string;
    roundNumber: number;
    resolvedAt: string | null;
    participants: Array<{
      userId: string;
      name: string;
    }>;
    rows: Array<{
      playerId: string;
      playerName: string;
      playerTeam: string;
      suggestedValue: number;
      winnerUserId: string | null;
      winnerName: string | null;
      winningBid: number | null;
      runnerUpName: string | null;
      runnerUpBid: number | null;
      bids: Array<{
        userId: string;
        userName: string;
        amount: number | null;
        isWinningBid: boolean;
        isSecondPlaceBid: boolean;
      }>;
    }>;
  }>;
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

type LeagueTab = "overview" | "managers" | "draft" | "results" | "standings";
type DraftSortOption =
  | "suggested_desc"
  | "projected_desc"
  | "name_asc"
  | "team_asc"
  | "seed_asc";
type PresetScope = "all" | "include" | "exclude";

type DraftPlayerRow = {
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

const LEAGUE_TABS: Array<{ id: LeagueTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "managers", label: "Managers" },
  { id: "draft", label: "Draft Room" },
  { id: "results", label: "Reveal" },
  { id: "standings", label: "Standings" },
];

function formatNullableNumber(value: number | null, digits = 1) {
  if (value === null) {
    return "-";
  }

  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function sortDraftPlayers<T extends DraftPlayerRow>(players: T[], sort: DraftSortOption) {
  const sortedPlayers = [...players];

  sortedPlayers.sort((left, right) => {
    switch (sort) {
      case "projected_desc":
        return (
          (right.totalPoints ?? -1) - (left.totalPoints ?? -1) ||
          right.suggestedValue - left.suggestedValue ||
          left.name.localeCompare(right.name)
        );
      case "name_asc":
        return left.name.localeCompare(right.name);
      case "team_asc":
        return left.team.localeCompare(right.team) || left.name.localeCompare(right.name);
      case "seed_asc":
        return (
          (left.seed ?? Number.MAX_SAFE_INTEGER) - (right.seed ?? Number.MAX_SAFE_INTEGER) ||
          right.suggestedValue - left.suggestedValue ||
          left.name.localeCompare(right.name)
        );
      case "suggested_desc":
      default:
        return (
          right.suggestedValue - left.suggestedValue ||
          (right.totalPoints ?? -1) - (left.totalPoints ?? -1) ||
          left.name.localeCompare(right.name)
        );
    }
  });

  return sortedPlayers;
}

function parseTeamsInput(value: string) {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean);
}

export function LeagueDetailView({ leagueId }: { leagueId: string }) {
  const router = useRouter();
  const [data, setData] = useState<LeagueDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [inviteEmails, setInviteEmails] = useState("");
  const [inviteError, setInviteError] = useState("");
  const [invitePending, setInvitePending] = useState(false);
  const [leagueName, setLeagueName] = useState("");
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
  const [activeTab, setActiveTab] = useState<LeagueTab>("overview");
  const [draftQuery, setDraftQuery] = useState("");
  const [draftConferenceFilter, setDraftConferenceFilter] = useState("all");
  const [draftTeamFilter, setDraftTeamFilter] = useState("all");
  const [draftSeedFilter, setDraftSeedFilter] = useState("all");
  const [draftSort, setDraftSort] = useState<DraftSortOption>("suggested_desc");
  const [presetCount, setPresetCount] = useState("2");
  const [presetScope, setPresetScope] = useState<PresetScope>("all");
  const [presetTeams, setPresetTeams] = useState("");
  const [presetError, setPresetError] = useState("");
  const [bidQuery, setBidQuery] = useState("");
  const [bidConferenceFilter, setBidConferenceFilter] = useState("all");
  const [bidTeamFilter, setBidTeamFilter] = useState("all");
  const [bidSeedFilter, setBidSeedFilter] = useState("all");
  const dataRef = useRef<LeagueDetail | null>(null);
  const lastActivityRef = useRef<number>(Date.now());

  const loadLeague = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!silent) {
        setLoading(true);
      }
      setError("");

      try {
        const payload = await appApiFetch<LeagueDetail>(`/leagues/${leagueId}`);
        const previous = dataRef.current;
        dataRef.current = payload;
        setData(payload);

        if (!silent) {
          setLeagueName(payload.league.name);
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
        } else if (previous?.currentRound && payload.currentRound) {
          const previousById = new Map(
            previous.currentRound.submissionStatuses.map((status) => [
              status.userId,
              status,
            ]),
          );

          for (const status of payload.currentRound.submissionStatuses) {
            const before = previousById.get(status.userId);
            if (status.submittedAt && before && !before.submittedAt) {
              toast.success(`${status.name} submitted their bids`);
            }
          }

          if (
            previous.currentRound.roundNumber !== payload.currentRound.roundNumber
          ) {
            toast(`Round ${payload.currentRound.roundNumber} is open`);
          }
        } else if (previous?.currentRound && !payload.currentRound) {
          toast("Round closed — reveal is ready");
        } else if (!previous?.currentRound && payload.currentRound) {
          toast(`Round ${payload.currentRound.roundNumber} is open`);
        }
      } catch (loadError) {
        if (!silent) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load league");
        }
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [leagueId],
  );

  useEffect(() => {
    void loadLeague();
  }, [loadLeague]);

  useEffect(() => {
    setActiveTab("overview");
  }, [leagueId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    function recordActivity() {
      lastActivityRef.current = Date.now();
    }

    function handleVisibility() {
      if (document.visibilityState === "visible") {
        lastActivityRef.current = Date.now();
        void loadLeague({ silent: true });
      }
    }

    window.addEventListener("pointerdown", recordActivity);
    window.addEventListener("keydown", recordActivity);
    document.addEventListener("visibilitychange", handleVisibility);

    const interval = window.setInterval(() => {
      if (document.hidden) {
        return;
      }
      if (Date.now() - lastActivityRef.current > POLL_INACTIVE_TIMEOUT_MS) {
        return;
      }
      void loadLeague({ silent: true });
    }, POLL_INTERVAL_MS);

    return () => {
      window.removeEventListener("pointerdown", recordActivity);
      window.removeEventListener("keydown", recordActivity);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.clearInterval(interval);
    };
  }, [loadLeague]);

  const filteredAvailablePlayers = useMemo(() => {
    if (!data) {
      return [];
    }

    const normalizedQuery = draftQuery.trim().toLowerCase();
    const seedValue = draftSeedFilter === "all" ? null : Number(draftSeedFilter);

    return sortDraftPlayers(
      data.availablePlayers.filter((player) => {
        if (
          normalizedQuery &&
          ![player.name, player.team, player.conference]
            .join(" ")
            .toLowerCase()
            .includes(normalizedQuery)
        ) {
          return false;
        }

        if (draftConferenceFilter !== "all" && player.conference !== draftConferenceFilter) {
          return false;
        }

        if (draftTeamFilter !== "all" && player.team !== draftTeamFilter) {
          return false;
        }

        if (seedValue !== null && player.seed !== seedValue) {
          return false;
        }

        return true;
      }),
      draftSort,
    );
  }, [data, draftConferenceFilter, draftQuery, draftSeedFilter, draftSort, draftTeamFilter]);

  const filteredBidPlayers = useMemo(() => {
    if (!data?.currentRound) {
      return [];
    }

    const normalizedQuery = bidQuery.trim().toLowerCase();
    const seedValue = bidSeedFilter === "all" ? null : Number(bidSeedFilter);

    return sortDraftPlayers(
      data.currentRound.players.filter((player) => {
        if (
          normalizedQuery &&
          ![player.name, player.team, player.conference]
            .join(" ")
            .toLowerCase()
            .includes(normalizedQuery)
        ) {
          return false;
        }

        if (bidConferenceFilter !== "all" && player.conference !== bidConferenceFilter) {
          return false;
        }

        if (bidTeamFilter !== "all" && player.team !== bidTeamFilter) {
          return false;
        }

        if (seedValue !== null && player.seed !== seedValue) {
          return false;
        }

        return true;
      }),
      "suggested_desc",
    );
  }, [bidConferenceFilter, bidQuery, bidSeedFilter, bidTeamFilter, data]);

  const availableTeams = useMemo(
    () =>
      data
        ? Array.from(new Set(data.availablePlayers.map((player) => player.team))).sort()
        : [],
    [data],
  );

  const availableSeeds = useMemo(
    () =>
      data
        ? Array.from(
            new Set(
              data.availablePlayers
                .map((player) => player.seed)
                .filter((seed): seed is number => seed !== null),
            ),
          ).sort((left, right) => left - right)
        : [],
    [data],
  );

  const bidTeams = useMemo(
    () =>
      data?.currentRound
        ? Array.from(new Set(data.currentRound.players.map((player) => player.team))).sort()
        : [],
    [data],
  );

  const bidSeeds = useMemo(
    () =>
      data?.currentRound
        ? Array.from(
            new Set(
              data.currentRound.players
                .map((player) => player.seed)
                .filter((seed): seed is number => seed !== null),
            ),
          ).sort((left, right) => left - right)
        : [],
    [data],
  );

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

  async function updateLeagueSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSettingsPending(true);
    setSettingsError("");

    try {
      const payload: {
        name: string;
        rosterSize?: number;
      } = {
        name: leagueName,
      };

      if (data?.league.canEditRosterSize) {
        payload.rosterSize = Number(rosterSize);
      }

      await appApiFetch(`/leagues/${leagueId}/settings`, {
        method: "POST",
        body: JSON.stringify(payload),
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

  function toggleSelectedPlayer(playerId: string, checked: boolean) {
    setSelectedPlayerIds((current) =>
      checked
        ? Array.from(new Set([...current, playerId]))
        : current.filter((selectedPlayerId) => selectedPlayerId !== playerId),
    );
  }

  function selectVisiblePlayers() {
    setSelectedPlayerIds((current) =>
      Array.from(new Set([...current, ...filteredAvailablePlayers.map((player) => player.id)])),
    );
  }

  function clearVisiblePlayers() {
    const visiblePlayerIds = new Set(filteredAvailablePlayers.map((player) => player.id));
    setSelectedPlayerIds((current) =>
      current.filter((playerId) => !visiblePlayerIds.has(playerId)),
    );
  }

  function applyTeamPresetSelection() {
    if (!data) {
      return;
    }

    const topCount = Number(presetCount);

    if (!Number.isInteger(topCount) || topCount <= 0) {
      setPresetError("Preset count must be a whole number greater than zero.");
      return;
    }

    const configuredTeams = parseTeamsInput(presetTeams);

    if (presetScope !== "all" && !configuredTeams.length) {
      setPresetError("Add at least one team code for include or exclude presets.");
      return;
    }

    const configuredTeamSet = new Set(configuredTeams);
    const candidates = data.availablePlayers.filter((player) => {
      if (presetScope === "include") {
        return configuredTeamSet.has(player.team.toUpperCase());
      }

      if (presetScope === "exclude") {
        return !configuredTeamSet.has(player.team.toUpperCase());
      }

      return true;
    });

    const groupedPlayers = new Map<string, typeof candidates>();

    for (const player of candidates) {
      groupedPlayers.set(player.team, [...(groupedPlayers.get(player.team) ?? []), player]);
    }

    const presetPlayerIds = Array.from(groupedPlayers.values())
      .flatMap((players) =>
        [...players]
          .sort(
            (left, right) =>
              (right.totalPoints ?? -1) - (left.totalPoints ?? -1) ||
              right.suggestedValue - left.suggestedValue ||
              left.name.localeCompare(right.name),
          )
          .slice(0, topCount),
      )
      .map((player) => player.id);

    if (!presetPlayerIds.length) {
      setPresetError("The preset did not match any remaining players.");
      return;
    }

    setPresetError("");
    setSelectedPlayerIds((current) => Array.from(new Set([...current, ...presetPlayerIds])));
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

  const summaryCards = [
    {
      label: "Phase",
      value: PHASE_LABELS[data.league.phase] ?? data.league.phase,
      detail: `Commissioner: ${data.league.commissionerName}`,
    },
    {
      label: "Managers",
      value: String(data.members.length),
      detail: `${data.pendingInvites.length} pending invites`,
    },
    {
      label: "Remaining Players",
      value: String(data.availablePlayers.length),
      detail: `${data.league.rosterSize} spots per team`,
    },
    {
      label: "Draft Status",
      value: data.currentRound ? `Round ${data.currentRound.roundNumber}` : "Closed",
      detail: data.currentRound ? `Max bid $${data.currentRound.myMaxBid}` : "No active round",
    },
  ];
  const selectedPlayerIdSet = new Set(selectedPlayerIds);
  const selectedVisibleCount = filteredAvailablePlayers.filter((player) =>
    selectedPlayerIdSet.has(player.id),
  ).length;

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

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {summaryCards.map((card) => (
          <Card key={card.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">{card.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold text-foreground">{card.value}</p>
              <p className="mt-1 text-sm text-muted-foreground">{card.detail}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      {error ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <section className="rounded-2xl border border-border/80 bg-background/90 p-2">
        <div className="flex flex-wrap gap-2">
          {LEAGUE_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={buttonVariants({
                variant: activeTab === tab.id ? "default" : "ghost",
                size: "sm",
              })}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </section>

      {activeTab === "overview" ? (
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
                Commissioners can rename the league at any time. Roster size still locks during an active round and in scoring.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.league.isCommissioner ? (
                <form className="space-y-4" onSubmit={updateLeagueSettings}>
                  <div className="space-y-2">
                    <Label htmlFor="league-name-settings">League Name</Label>
                    <Input
                      id="league-name-settings"
                      value={leagueName}
                      onChange={(event) => setLeagueName(event.target.value)}
                      required
                    />
                  </div>
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
                    disabled={settingsPending}
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
      ) : null}

      {activeTab === "managers" ? (
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
      ) : null}

      {activeTab === "draft" ? (
        <>
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

                <div className="grid gap-4 xl:grid-cols-[0.8fr_1.4fr]">
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
                    <div className="flex flex-wrap items-end justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-foreground">Eligible Players</p>
                        <p className="text-sm text-muted-foreground">
                          Ordered by suggested dollar value descending.
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Input
                          value={bidQuery}
                          onChange={(event) => setBidQuery(event.target.value)}
                          placeholder="Search players or teams"
                          className="w-full sm:w-52"
                        />
                        <select
                          className="h-8 rounded-lg border border-input bg-background px-3 text-sm"
                          value={bidConferenceFilter}
                          onChange={(event) => setBidConferenceFilter(event.target.value)}
                        >
                          <option value="all">All conferences</option>
                          <option value="E">East</option>
                          <option value="W">West</option>
                        </select>
                        <select
                          className="h-8 rounded-lg border border-input bg-background px-3 text-sm"
                          value={bidTeamFilter}
                          onChange={(event) => setBidTeamFilter(event.target.value)}
                        >
                          <option value="all">All teams</option>
                          {bidTeams.map((team) => (
                            <option key={team} value={team}>
                              {team}
                            </option>
                          ))}
                        </select>
                        <select
                          className="h-8 rounded-lg border border-input bg-background px-3 text-sm"
                          value={bidSeedFilter}
                          onChange={(event) => setBidSeedFilter(event.target.value)}
                        >
                          <option value="all">All seeds</option>
                          {bidSeeds.map((seed) => (
                            <option key={seed} value={String(seed)}>
                              Seed {seed}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className="flex flex-col gap-3 md:hidden">
                      {filteredBidPlayers.map((player) => (
                        <div
                          key={player.id}
                          className="rounded-xl border border-border/80 bg-background p-4 shadow-sm"
                        >
                          <div className="flex items-baseline justify-between gap-3">
                            <p className="text-base font-medium text-foreground">{player.name}</p>
                            <p className="text-sm font-semibold text-foreground">
                              ${player.suggestedValue}
                            </p>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {player.team} · Seed {player.seed ?? "-"}
                          </p>
                          <dl className="mt-3 grid grid-cols-3 gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                            <div>
                              <dt className="uppercase tracking-wide">GP</dt>
                              <dd className="text-foreground">{formatNullableNumber(player.gamesPlayed, 0)}</dd>
                            </div>
                            <div>
                              <dt className="uppercase tracking-wide">MPG</dt>
                              <dd className="text-foreground">{formatNullableNumber(player.minutesPerGame)}</dd>
                            </div>
                            <div>
                              <dt className="uppercase tracking-wide">PPG</dt>
                              <dd className="text-foreground">{formatNullableNumber(player.pointsPerGame)}</dd>
                            </div>
                            <div>
                              <dt className="uppercase tracking-wide">Proj Pts</dt>
                              <dd className="text-foreground">{formatNullableNumber(player.totalPoints)}</dd>
                            </div>
                            <div>
                              <dt className="uppercase tracking-wide">Proj GP</dt>
                              <dd className="text-foreground">{formatNullableNumber(player.totalGames)}</dd>
                            </div>
                            <div>
                              <dt className="uppercase tracking-wide">Default</dt>
                              <dd className="text-foreground">${player.defaultBid}</dd>
                            </div>
                          </dl>
                          <div className="mt-3 flex items-center gap-2">
                            <Label
                              htmlFor={`bid-${player.id}`}
                              className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                            >
                              Your bid
                            </Label>
                            <div className="relative flex-1">
                              <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">
                                $
                              </span>
                              <Input
                                id={`bid-${player.id}`}
                                type="number"
                                inputMode="numeric"
                                min={data.league.minBid}
                                max={data.currentRound?.myMaxBid ?? 0}
                                placeholder={String(player.defaultBid)}
                                value={bidValues[player.id] ?? ""}
                                onChange={(event) =>
                                  setBidValues((current) => ({
                                    ...current,
                                    [player.id]: event.target.value,
                                  }))
                                }
                                className="pl-6"
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                      {!filteredBidPlayers.length ? (
                        <div className="rounded-xl border border-border/80 px-4 py-6 text-sm text-muted-foreground">
                          No eligible players match your current filters.
                        </div>
                      ) : null}
                    </div>

                    <div className="hidden max-h-[34rem] overflow-auto rounded-xl border border-border/80 md:block">
                      <table className="min-w-full text-left text-sm">
                        <thead className="bg-muted/60 text-xs tracking-[0.18em] text-muted-foreground uppercase">
                          <tr>
                            <th className="px-3 py-3 font-medium">Player</th>
                            <th className="px-3 py-3 font-medium">Team</th>
                            <th className="px-3 py-3 font-medium">Conf</th>
                            <th className="px-3 py-3 font-medium">Seed</th>
                            <th className="px-3 py-3 font-medium">GP</th>
                            <th className="px-3 py-3 font-medium">MPG</th>
                            <th className="px-3 py-3 font-medium">PPG</th>
                            <th className="px-3 py-3 font-medium">Suggested</th>
                            <th className="px-3 py-3 font-medium">Default</th>
                            <th className="px-3 py-3 font-medium">Proj. Pts</th>
                            <th className="px-3 py-3 font-medium">Proj. GP</th>
                            <th className="px-3 py-3 font-medium">Your Bid</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredBidPlayers.map((player) => (
                            <tr key={player.id} className="border-t border-border/70">
                              <td className="px-3 py-3 font-medium text-foreground">{player.name}</td>
                              <td className="px-3 py-3 text-muted-foreground">{player.team}</td>
                              <td className="px-3 py-3 text-muted-foreground">{player.conference}</td>
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
                              <td className="px-3 py-3 text-muted-foreground">
                                ${player.suggestedValue}
                              </td>
                              <td className="px-3 py-3 text-muted-foreground">${player.defaultBid}</td>
                              <td className="px-3 py-3 text-muted-foreground">
                                {formatNullableNumber(player.totalPoints)}
                              </td>
                              <td className="px-3 py-3 text-muted-foreground">
                                {formatNullableNumber(player.totalGames)}
                              </td>
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
                      {!filteredBidPlayers.length ? (
                        <div className="border-t border-border/70 px-4 py-6 text-sm text-muted-foreground">
                          No eligible players match your current filters.
                        </div>
                      ) : null}
                    </div>
                    {submitError || invalidBidMessage ? (
                      <p className="text-sm text-destructive">{submitError || invalidBidMessage}</p>
                    ) : null}
                    <div className="sticky bottom-2 z-10 flex flex-wrap gap-3 rounded-xl border border-border/80 bg-background/95 p-3 shadow-sm backdrop-blur md:static md:border-0 md:bg-transparent md:p-0 md:shadow-none md:backdrop-blur-none">
                      <Button
                        onClick={() => void submitBids()}
                        disabled={submitPending}
                        className="flex-1 md:flex-none"
                      >
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
                        onChange={(event) =>
                          setRoundMode(event.target.value as "selected" | "all_remaining")
                        }
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
                    <div className="space-y-4">
                      <div className="grid gap-3 lg:grid-cols-[1.2fr_0.8fr]">
                        <div className="rounded-xl border border-border/80 px-4 py-4">
                          <div className="space-y-1">
                            <p className="text-base font-medium text-foreground">Selection Controls</p>
                            <p className="text-sm text-muted-foreground">
                              Filter the remaining pool, sort it, and build a round quickly.
                            </p>
                          </div>
                          <div className="mt-4 space-y-4">
                            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                              <Input
                                value={draftQuery}
                                onChange={(event) => setDraftQuery(event.target.value)}
                                placeholder="Search players or teams"
                              />
                              <select
                                className="h-9 rounded-lg border border-input bg-background px-3 text-sm"
                                value={draftConferenceFilter}
                                onChange={(event) => setDraftConferenceFilter(event.target.value)}
                              >
                                <option value="all">All conferences</option>
                                <option value="E">East</option>
                                <option value="W">West</option>
                              </select>
                              <select
                                className="h-9 rounded-lg border border-input bg-background px-3 text-sm"
                                value={draftTeamFilter}
                                onChange={(event) => setDraftTeamFilter(event.target.value)}
                              >
                                <option value="all">All teams</option>
                                {availableTeams.map((team) => (
                                  <option key={team} value={team}>
                                    {team}
                                  </option>
                                ))}
                              </select>
                              <select
                                className="h-9 rounded-lg border border-input bg-background px-3 text-sm"
                                value={draftSeedFilter}
                                onChange={(event) => setDraftSeedFilter(event.target.value)}
                              >
                                <option value="all">All seeds</option>
                                {availableSeeds.map((seed) => (
                                  <option key={seed} value={String(seed)}>
                                    Seed {seed}
                                  </option>
                                ))}
                              </select>
                              <select
                                className="h-9 rounded-lg border border-input bg-background px-3 text-sm"
                                value={draftSort}
                                onChange={(event) =>
                                  setDraftSort(event.target.value as DraftSortOption)
                                }
                              >
                                <option value="suggested_desc">Suggested value</option>
                                <option value="projected_desc">Projected points</option>
                                <option value="name_asc">Player name</option>
                                <option value="team_asc">Team</option>
                                <option value="seed_asc">Seed</option>
                              </select>
                            </div>

                            <div className="flex flex-wrap gap-2">
                              <Button type="button" variant="outline" onClick={selectVisiblePlayers}>
                                Select Visible
                              </Button>
                              <Button type="button" variant="outline" onClick={clearVisiblePlayers}>
                                Clear Visible
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => setSelectedPlayerIds([])}
                              >
                                Clear All
                              </Button>
                            </div>
                          </div>
                        </div>

                        <div className="rounded-xl border border-border/80 px-4 py-4">
                          <div className="space-y-1">
                            <p className="text-base font-medium text-foreground">Preset Builder</p>
                            <p className="text-sm text-muted-foreground">
                              Add the top projected players per team to the current selection.
                            </p>
                          </div>
                          <div className="mt-4 space-y-3">
                            <div className="grid gap-3 sm:grid-cols-3">
                              <div className="space-y-2">
                                <Label htmlFor="preset-count">Top Per Team</Label>
                                <Input
                                  id="preset-count"
                                  type="number"
                                  min={1}
                                  value={presetCount}
                                  onChange={(event) => setPresetCount(event.target.value)}
                                />
                              </div>
                              <div className="space-y-2 sm:col-span-2">
                                <Label htmlFor="preset-scope">Scope</Label>
                                <select
                                  id="preset-scope"
                                  className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
                                  value={presetScope}
                                  onChange={(event) =>
                                    setPresetScope(event.target.value as PresetScope)
                                  }
                                >
                                  <option value="all">All teams</option>
                                  <option value="exclude">All teams except</option>
                                  <option value="include">Only these teams</option>
                                </select>
                              </div>
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor="preset-teams">Team Codes</Label>
                              <Input
                                id="preset-teams"
                                value={presetTeams}
                                onChange={(event) => setPresetTeams(event.target.value)}
                                placeholder="OKC, BOS, CLE"
                              />
                            </div>
                            {presetError ? (
                              <p className="text-sm text-destructive">{presetError}</p>
                            ) : null}
                            <Button type="button" variant="outline" onClick={applyTeamPresetSelection}>
                              Apply Preset Selection
                            </Button>
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                        <span>{selectedPlayerIds.length} selected</span>
                        <span>{selectedVisibleCount} selected in current view</span>
                        <span>{filteredAvailablePlayers.length} visible players</span>
                        <span>{data.availablePlayers.length} total remaining players</span>
                      </div>

                      <div className="space-y-3 md:hidden">
                        {filteredAvailablePlayers.map((player) => {
                          const checked = selectedPlayerIdSet.has(player.id);

                          return (
                            <label
                              key={player.id}
                              className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/80 px-4 py-4"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(event) =>
                                  toggleSelectedPlayer(player.id, event.target.checked)
                                }
                                className="mt-1"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-start justify-between gap-3">
                                  <div>
                                    <p className="font-medium text-foreground">{player.name}</p>
                                    <p className="text-sm text-muted-foreground">
                                      {player.team} · {player.conference} · Seed {player.seed ?? "-"}
                                    </p>
                                  </div>
                                  <p className="text-sm font-medium text-foreground">
                                    ${player.suggestedValue}
                                  </p>
                                </div>
                                <div className="mt-3 grid grid-cols-2 gap-3 text-sm text-muted-foreground">
                                  <span>GP: {formatNullableNumber(player.gamesPlayed, 0)}</span>
                                  <span>MPG: {formatNullableNumber(player.minutesPerGame)}</span>
                                  <span>PPG: {formatNullableNumber(player.pointsPerGame)}</span>
                                  <span>Proj. Pts: {formatNullableNumber(player.totalPoints)}</span>
                                  <span>Proj. GP: {formatNullableNumber(player.totalGames)}</span>
                                </div>
                              </div>
                            </label>
                          );
                        })}
                        {!filteredAvailablePlayers.length ? (
                          <div className="rounded-xl border border-border/80 px-4 py-6 text-sm text-muted-foreground">
                            No remaining players match your current filters.
                          </div>
                        ) : null}
                      </div>

                      <div className="hidden max-h-[34rem] overflow-auto rounded-xl border border-border/80 md:block">
                        <table className="min-w-full text-left text-sm">
                          <thead className="bg-muted/60 text-xs tracking-[0.18em] text-muted-foreground uppercase">
                            <tr>
                              <th className="px-3 py-3 font-medium">Pick</th>
                              <th className="px-3 py-3 font-medium">Player</th>
                              <th className="px-3 py-3 font-medium">Team</th>
                              <th className="px-3 py-3 font-medium">Conf</th>
                              <th className="px-3 py-3 font-medium">Seed</th>
                              <th className="px-3 py-3 font-medium">GP</th>
                              <th className="px-3 py-3 font-medium">MPG</th>
                              <th className="px-3 py-3 font-medium">PPG</th>
                              <th className="px-3 py-3 font-medium">Suggested</th>
                              <th className="px-3 py-3 font-medium">Proj. Pts</th>
                              <th className="px-3 py-3 font-medium">Proj. GP</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredAvailablePlayers.map((player) => {
                              const checked = selectedPlayerIdSet.has(player.id);

                              return (
                                <tr key={player.id} className="border-t border-border/70">
                                  <td className="px-3 py-3">
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={(event) =>
                                        toggleSelectedPlayer(player.id, event.target.checked)
                                      }
                                    />
                                  </td>
                                  <td className="px-3 py-3 font-medium text-foreground">{player.name}</td>
                                  <td className="px-3 py-3 text-muted-foreground">{player.team}</td>
                                  <td className="px-3 py-3 text-muted-foreground">{player.conference}</td>
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
                                  <td className="px-3 py-3 text-muted-foreground">
                                    ${player.suggestedValue}
                                  </td>
                                  <td className="px-3 py-3 text-muted-foreground">
                                    {formatNullableNumber(player.totalPoints)}
                                  </td>
                                  <td className="px-3 py-3 text-muted-foreground">
                                    {formatNullableNumber(player.totalGames)}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        {!filteredAvailablePlayers.length ? (
                          <div className="border-t border-border/70 px-4 py-6 text-sm text-muted-foreground">
                            No remaining players match your current filters.
                          </div>
                        ) : null}
                      </div>
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
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Draft Room</CardTitle>
                <CardDescription>
                  No round is open right now.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  {data.league.phase === "scoring"
                    ? "The draft is complete and the league is now in scoring."
                    : "The commissioner has not opened the next batch auction yet."}
                </p>
              </CardContent>
            </Card>
          )}
        </>
      ) : null}

      {activeTab === "results" ? (
        <section className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Latest Reveal</CardTitle>
              <CardDescription>
                {data.lastResolvedRound
                  ? `Round ${data.lastResolvedRound.roundNumber} blind auction results.`
                  : "No blind auction reveal yet."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {data.lastResolvedRound ? (
                data.lastResolvedRound.results.length ? (
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
                )
              ) : (
                <p className="text-sm text-muted-foreground">
                  Close the first draft round to see the reveal sequence here.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Draft History</CardTitle>
              <CardDescription>
                Full resolved bid history by player, including winner, runner-up, and every team bid.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {data.draftHistory.length ? (
                data.draftHistory.map((round) => (
                  <div key={round.id} className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="font-medium text-foreground">Round {round.roundNumber}</p>
                        <p className="text-sm text-muted-foreground">
                          {round.resolvedAt
                            ? new Date(round.resolvedAt).toLocaleString()
                            : "Resolved"}
                        </p>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {round.rows.length} players
                      </p>
                    </div>

                    <div className="overflow-x-auto rounded-xl border border-border/80">
                      <table className="min-w-[72rem] text-left text-sm">
                        <thead className="bg-muted/60 text-xs tracking-[0.18em] text-muted-foreground uppercase">
                          <tr>
                            <th className="px-3 py-3 font-medium">Player / Suggested</th>
                            <th className="px-3 py-3 font-medium">Winner / Bid</th>
                            <th className="px-3 py-3 font-medium">Runner-Up / Bid</th>
                            {round.participants.map((participant) => (
                              <th key={participant.userId} className="px-3 py-3 font-medium">
                                {participant.name}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {round.rows.map((row) => (
                            <tr key={row.playerId} className="border-t border-border/70 align-top">
                              <td className="px-3 py-3">
                                <div className="font-medium text-foreground">{row.playerName}</div>
                                <div className="text-xs text-muted-foreground">
                                  {row.playerTeam} · ${row.suggestedValue}
                                </div>
                              </td>
                              <td className="px-3 py-3">
                                <div className="rounded-lg bg-emerald-500/10 px-3 py-2">
                                  <div className="font-medium text-foreground">
                                    {row.winnerName ?? "-"}
                                  </div>
                                  <div className="text-xs text-emerald-700">
                                    {row.winningBid !== null ? `$${row.winningBid}` : "-"}
                                  </div>
                                </div>
                              </td>
                              <td className="px-3 py-3">
                                <div className="rounded-lg bg-amber-500/10 px-3 py-2">
                                  <div className="font-medium text-foreground">
                                    {row.runnerUpName ?? "-"}
                                  </div>
                                  <div className="text-xs text-amber-700">
                                    {row.runnerUpBid !== null ? `$${row.runnerUpBid}` : "-"}
                                  </div>
                                </div>
                              </td>
                              {row.bids.map((bid) => (
                                <td key={bid.userId} className="px-3 py-3">
                                  <div
                                    className={[
                                      "rounded-lg px-3 py-2 text-sm",
                                      bid.isWinningBid
                                        ? "bg-emerald-500/10 font-medium text-foreground"
                                        : bid.isSecondPlaceBid
                                          ? "bg-amber-500/10 font-medium text-foreground"
                                          : "bg-muted/30 text-muted-foreground",
                                    ].join(" ")}
                                  >
                                    {bid.amount !== null ? `$${bid.amount}` : "-"}
                                  </div>
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  No resolved draft rounds yet.
                </p>
              )}
            </CardContent>
          </Card>
        </section>
      ) : null}

      {activeTab === "standings" ? (
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
      ) : null}
    </main>
  );
}
