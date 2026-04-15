"use client";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
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
      isAutoAssigned: boolean;
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
      isAutoAssigned: boolean;
      totalPoints: number;
    }>;
  }>;
};

const PHASE_LABELS: Record<string, string> = {
  invite: "Invite",
  draft: "Draft",
  scoring: "Scoring",
};

type LeagueTab = "overview" | "managers" | "players" | "draft" | "results" | "standings";
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

const LEAGUE_TAB_DEFS: Record<LeagueTab, { label: string; shortLabel: string }> = {
  overview: { label: "Overview", shortLabel: "Home" },
  managers: { label: "Managers", shortLabel: "Teams" },
  players: { label: "Players", shortLabel: "Pool" },
  draft: { label: "Draft Room", shortLabel: "Draft" },
  results: { label: "Reveal", shortLabel: "Reveal" },
  standings: { label: "Standings", shortLabel: "Rank" },
};

function getLeagueTabOrder(phase: string): LeagueTab[] {
  if (phase === "draft" || phase === "invite") {
    return ["draft", "overview", "managers", "players", "results", "standings"];
  }
  return ["standings", "overview", "managers", "players", "draft", "results"];
}

function formatNullableNumber(value: number | null, digits = 1) {
  if (value === null) {
    return "-";
  }

  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function formatRelativeTime(input: string | Date | null | undefined, now: number = Date.now()) {
  if (!input) {
    return "";
  }
  const then = typeof input === "string" ? new Date(input).getTime() : input.getTime();
  if (Number.isNaN(then)) {
    return "";
  }
  const diffSeconds = Math.round((then - now) / 1000);
  const absSeconds = Math.abs(diffSeconds);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

  if (absSeconds < 45) {
    return diffSeconds >= 0 ? "just now" : "just now";
  }
  if (absSeconds < 60) {
    return rtf.format(Math.round(diffSeconds), "second");
  }
  if (absSeconds < 60 * 60) {
    return rtf.format(Math.round(diffSeconds / 60), "minute");
  }
  if (absSeconds < 60 * 60 * 24) {
    return rtf.format(Math.round(diffSeconds / 3600), "hour");
  }
  if (absSeconds < 60 * 60 * 24 * 7) {
    return rtf.format(Math.round(diffSeconds / 86400), "day");
  }
  return new Date(then).toLocaleDateString();
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

function sanitizeBidInput(raw: string) {
  return raw.replace(/[^\d]/g, "").replace(/^0+(?=\d)/, "");
}

function parseBidValue(raw: string): number | null {
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

function RefreshIcon(props: ComponentProps<"svg">) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

function ChevronDownIcon(props: ComponentProps<"svg">) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/**
 * Consistent styled <select>: native control with appearance-none + an
 * overlaid chevron so the indicator looks the same on every platform.
 */
function SelectField({
  className = "",
  children,
  ...rest
}: ComponentProps<"select">) {
  return (
    <div className="relative">
      <select
        {...rest}
        className={[
          "h-8 appearance-none rounded-lg border border-input bg-background pl-3 pr-8 text-sm",
          "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
          className,
        ].join(" ")}
      >
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  loading = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-label="Cancel"
        className="absolute inset-0 bg-foreground/40 backdrop-blur-sm"
        onClick={onCancel}
      />
      <div className="relative z-10 w-full max-w-sm rounded-2xl border border-border/80 bg-card p-6 shadow-lg">
        <h2 id="confirm-title" className="text-lg font-semibold text-foreground">
          {title}
        </h2>
        {description ? (
          <div className="mt-2 text-sm text-muted-foreground">{description}</div>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? "Working..." : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Ratio-driven background color for a bid input. Uses CSS variables
// declared in globals.css so it looks correct in both light and dark mode.
// Four stops, interpolated linearly in oklch:
//   ratio ≤ 0       -> red     ("bidding nothing")
//   0..0.75         -> red -> yellow
//   0.75..1.0       -> yellow -> white
//   1.0..1.25       -> white -> green
//   ratio ≥ 1.25    -> green   ("paying well above value")
function bidInputStyle(bid: number | null, suggestedValue: number): React.CSSProperties {
  if (bid === null || suggestedValue <= 0) {
    return {};
  }
  const ratio = bid / suggestedValue;
  const mix = (low: string, high: string, t: number) =>
    `color-mix(in oklch, ${low}, ${high} ${Math.round(t * 100)}%)`;

  if (ratio <= 0) {
    return {
      backgroundColor: "var(--bid-red-bg)",
      color: "var(--bid-red-fg)",
    };
  }
  if (ratio <= 0.75) {
    const t = ratio / 0.75;
    return {
      backgroundColor: mix("var(--bid-red-bg)", "var(--bid-yellow-bg)", t),
      color: mix("var(--bid-red-fg)", "var(--bid-yellow-fg)", t),
    };
  }
  if (ratio <= 1.0) {
    const t = (ratio - 0.75) / 0.25;
    return {
      backgroundColor: mix("var(--bid-yellow-bg)", "var(--bid-white-bg)", t),
      color: mix("var(--bid-yellow-fg)", "var(--bid-white-fg)", t),
    };
  }
  if (ratio <= 1.25) {
    const t = (ratio - 1.0) / 0.25;
    return {
      backgroundColor: mix("var(--bid-white-bg)", "var(--bid-green-bg)", t),
      color: mix("var(--bid-white-fg)", "var(--bid-green-fg)", t),
    };
  }
  return {
    backgroundColor: "var(--bid-green-bg)",
    color: "var(--bid-green-fg)",
  };
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
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
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
  const [expandedHistoryRows, setExpandedHistoryRows] = useState<Set<string>>(
    () => new Set(),
  );
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
    if (data?.league.phase) {
      const order = getLeagueTabOrder(data.league.phase);
      setActiveTab(order[0] ?? "overview");
    }
  }, [leagueId, data?.league.phase]);

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

      if (!player || !Number.isInteger(bid) || bid < 0) {
        return "Bids must be whole numbers.";
      }

      // A bid of 0 is a valid "pass" — the user is opting out of this player.
      if (bid === 0) {
        continue;
      }

      if (bid < data.league.minBid) {
        return `Bids must be $0 or at least $${data.league.minBid}.`;
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
      setShowCloseConfirm(false);
    }
  }

  function setBidValue(playerId: string, value: string) {
    setBidValues((current) => ({
      ...current,
      [playerId]: sanitizeBidInput(value),
    }));
  }

  function resetBidValue(playerId: string) {
    setBidValues((current) => {
      const next = { ...current };
      delete next[playerId];
      return next;
    });
  }

  function applyBulkBids(mode: "suggested" | "zero" | "clear") {
    if (!data?.currentRound) return;
    const players = data.currentRound.players;
    setBidValues((current) => {
      const next = { ...current };
      for (const player of players) {
        if (mode === "clear") {
          delete next[player.id];
        } else if (mode === "zero") {
          next[player.id] = "0";
        } else {
          // "suggested" — cap at the viewer's current max bid so the
          // value we drop in is always submittable.
          const capped = Math.min(
            player.suggestedValue,
            data.currentRound!.myMaxBid,
          );
          next[player.id] = String(Math.max(0, capped));
        }
      }
      return next;
    });
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
      <main className="mx-auto flex w-full max-w-[96rem] px-4 py-12 sm:px-6 lg:px-8">
        <p className="text-sm text-muted-foreground">Loading league...</p>
      </main>
    );
  }

  if (error && !data) {
    return (
      <main className="mx-auto flex w-full max-w-[96rem] px-4 py-12 sm:px-6 lg:px-8">
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

  const selectedPlayerIdSet = new Set(selectedPlayerIds);
  const selectedVisibleCount = filteredAvailablePlayers.filter((player) =>
    selectedPlayerIdSet.has(player.id),
  ).length;

  return (
    <main className="mx-auto flex w-full max-w-[96rem] flex-col gap-6 px-4 py-10 sm:px-6 lg:px-8">
      <section className="space-y-3">
        <button
          type="button"
          className="text-sm text-muted-foreground underline underline-offset-4"
          onClick={() => startTransition(() => router.push("/"))}
        >
          Back to leagues
        </button>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <p className="text-xs font-semibold tracking-[0.25em] text-muted-foreground uppercase">
              {PHASE_LABELS[data.league.phase] ?? data.league.phase}
            </p>
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">
              {data.league.name}
            </h1>
            <p className="text-sm text-muted-foreground">
              Commissioner: {data.league.commissionerName}
              {" · "}
              {data.members.length} managers
              {" · "}
              {data.availablePlayers.length} players remaining
            </p>
          </div>
          <div className="grid gap-1 rounded-2xl border border-border/80 bg-card px-4 py-3 text-sm text-muted-foreground">
            <p>
              Roster size: <span className="font-medium text-foreground">{data.league.rosterSize}</span>
            </p>
            <p>
              Budget: <span className="font-medium text-foreground">${data.league.budgetPerTeam}</span>
            </p>
            <p>
              Min bid: <span className="font-medium text-foreground">${data.league.minBid}</span>
            </p>
            {data.currentRound ? (
              <p className="mt-1 border-t border-border/70 pt-2">
                <span className="text-foreground font-medium">
                  Round {data.currentRound.roundNumber}
                </span>
                {" · Max bid "}
                <span className="text-foreground font-medium">${data.currentRound.myMaxBid}</span>
              </p>
            ) : null}
          </div>
        </div>
      </section>

      {error ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <section className="rounded-2xl border border-border/80 bg-background/90 p-2">
        <div className="flex flex-nowrap gap-1 overflow-x-auto sm:gap-2">
          {getLeagueTabOrder(data.league.phase).map((tabId) => {
            const def = LEAGUE_TAB_DEFS[tabId];
            return (
            <button
              key={tabId}
              type="button"
              className={[
                buttonVariants({
                  variant: activeTab === tabId ? "default" : "ghost",
                  size: "sm",
                }),
                "shrink-0",
              ].join(" ")}
              onClick={() => setActiveTab(tabId)}
            >
              <span className="hidden sm:inline">{def.label}</span>
              <span className="sm:hidden">{def.shortLabel}</span>
            </button>
            );
          })}
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
                    <span>{member.totalPoints} proj. pts</span>
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

      {activeTab === "players" ? (
        <Card>
          <CardHeader>
            <CardTitle>League Player Pool</CardTitle>
            <CardDescription>
              Remaining undrafted players with dollar values tuned for this league&apos;s
              shape ({data.members.length} managers × {data.league.rosterSize} picks, $
              {data.league.budgetPerTeam} budget, min bid ${data.league.minBid}).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-auto rounded-xl border border-border/80">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/60 text-xs tracking-[0.18em] text-muted-foreground uppercase">
                  <tr>
                    <th className="px-3 py-3 text-left font-medium">Player</th>
                    <th className="px-3 py-3 text-left font-medium">Team</th>
                    <th className="px-3 py-3 text-left font-medium">Conf</th>
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
                  {sortDraftPlayers(data.availablePlayers, "suggested_desc").map(
                    (player) => (
                      <tr key={player.id} className="border-t border-border/70">
                        <td className="px-3 py-3 font-medium text-foreground">{player.name}</td>
                        <td className="px-3 py-3 text-muted-foreground">{player.team}</td>
                        <td className="px-3 py-3 text-muted-foreground">{player.conference}</td>
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
                    ),
                  )}
                </tbody>
              </table>
              {!data.availablePlayers.length ? (
                <div className="border-t border-border/70 px-4 py-6 text-sm text-muted-foreground">
                  No remaining undrafted players.
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>
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

                <div className="space-y-4">
                  <div>
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="text-sm font-medium text-foreground">Submission Status</p>
                      <p className="text-xs text-muted-foreground">
                        {
                          data.currentRound.submissionStatuses.filter((s) => s.submittedAt)
                            .length
                        }{" "}
                        / {data.currentRound.submissionStatuses.length} submitted
                      </p>
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                      {data.currentRound.submissionStatuses.map((submission) => {
                        const submitted = Boolean(submission.submittedAt);
                        return (
                          <div
                            key={submission.userId}
                            title={
                              submission.submittedAt
                                ? `Submitted ${new Date(submission.submittedAt).toLocaleString()}`
                                : "Waiting on bids"
                            }
                            className={[
                              "flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                              submitted
                                ? "border-emerald-500/40 bg-emerald-500/10 text-foreground"
                                : "border-border/70 bg-background",
                            ].join(" ")}
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <span
                                aria-hidden
                                className={[
                                  "inline-flex h-1.5 w-1.5 shrink-0 rounded-full",
                                  submitted
                                    ? "bg-emerald-500"
                                    : "animate-pulse bg-amber-500",
                                ].join(" ")}
                              />
                              <span className="truncate">{submission.name}</span>
                            </span>
                            <span
                              className={[
                                "shrink-0 text-[11px]",
                                submitted ? "text-emerald-700" : "text-muted-foreground",
                              ].join(" ")}
                            >
                              {submitted
                                ? formatRelativeTime(submission.submittedAt!)
                                : "Waiting"}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div className="flex flex-wrap items-end justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-foreground">Eligible Players</p>
                        <p className="text-sm text-muted-foreground">
                          Ordered by suggested dollar value descending. Bid $0 to pass
                          on a player.
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Input
                          value={bidQuery}
                          onChange={(event) => setBidQuery(event.target.value)}
                          placeholder="Search players or teams"
                          className="w-full sm:w-52"
                        />
                        <SelectField
                          value={bidConferenceFilter}
                          onChange={(event) => setBidConferenceFilter(event.target.value)}
                        >
                          <option value="all">All conferences</option>
                          <option value="E">East</option>
                          <option value="W">West</option>
                        </SelectField>
                        <SelectField
                          value={bidTeamFilter}
                          onChange={(event) => setBidTeamFilter(event.target.value)}
                        >
                          <option value="all">All teams</option>
                          {bidTeams.map((team) => (
                            <option key={team} value={team}>
                              {team}
                            </option>
                          ))}
                        </SelectField>
                        <SelectField
                          value={bidSeedFilter}
                          onChange={(event) => setBidSeedFilter(event.target.value)}
                        >
                          <option value="all">All seeds</option>
                          {bidSeeds.map((seed) => (
                            <option key={seed} value={String(seed)}>
                              Seed {seed}
                            </option>
                          ))}
                        </SelectField>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2 border-y border-border/60 bg-muted/20 px-3 py-2 -mx-3 sm:mx-0 sm:rounded-lg sm:border">
                      <span className="self-center text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Bulk:
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => applyBulkBids("suggested")}
                      >
                        Set all → suggested
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => applyBulkBids("zero")}
                      >
                        Set all → $0
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => applyBulkBids("clear")}
                      >
                        Clear all
                      </Button>
                    </div>
                    <div className="flex flex-col gap-3 md:hidden">
                      {filteredBidPlayers.map((player) => (
                        <div
                          key={player.id}
                          className="overflow-hidden rounded-2xl border border-border/80 bg-card shadow-sm"
                        >
                          <div className="flex items-start justify-between gap-3 px-4 pt-4">
                            <div className="min-w-0">
                              <p className="truncate text-base font-semibold text-foreground">
                                {player.name}
                              </p>
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                {player.team} · {player.conference} · Seed {player.seed ?? "-"}
                              </p>
                            </div>
                            <div className="shrink-0 text-right">
                              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                Suggested
                              </p>
                              <p className="text-lg font-bold tabular-nums text-foreground">
                                ${player.suggestedValue}
                              </p>
                            </div>
                          </div>
                          <p className="mt-1 px-4 text-xs text-muted-foreground">
                            Projected {formatNullableNumber(player.totalPoints)} pts · Default $
                            {player.defaultBid}
                          </p>
                          <div className="mt-3 flex items-center gap-2 border-t border-border/60 bg-muted/30 px-3 py-3">
                            <Button
                              type="button"
                              variant="outline"
                              size="icon-sm"
                              onClick={() => resetBidValue(player.id)}
                              aria-label={`Reset bid for ${player.name}`}
                              title="Reset to default"
                            >
                              <RefreshIcon className="size-3.5" />
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setBidValue(player.id, "0")}
                              title="Pass (bid $0)"
                              className="h-7 px-2 text-xs tabular-nums"
                            >
                              $0
                            </Button>
                            <div className="relative flex-1">
                              <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">
                                $
                              </span>
                              <Input
                                id={`bid-${player.id}`}
                                type="text"
                                inputMode="numeric"
                                pattern="[0-9]*"
                                autoComplete="off"
                                placeholder={String(player.defaultBid)}
                                value={bidValues[player.id] ?? ""}
                                onChange={(event) =>
                                  setBidValue(player.id, event.target.value)
                                }
                                className="h-9 pl-6 pr-3 text-right text-base font-semibold tabular-nums"
                                style={bidInputStyle(
                                  parseBidValue(bidValues[player.id] ?? ""),
                                  player.suggestedValue,
                                )}
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

                    <div className="hidden overflow-x-auto rounded-xl border border-border/80 md:block">
                      <table className="w-full text-left text-sm">
                        <thead className="bg-muted/60 text-xs tracking-[0.18em] text-muted-foreground uppercase">
                          <tr>
                            <th className="px-3 py-3 text-left font-medium">Player</th>
                            <th className="px-3 py-3 text-left font-medium">Team</th>
                            <th className="px-3 py-3 text-left font-medium">Conf</th>
                            <th className="px-3 py-3 text-right font-medium">Seed</th>
                            <th className="px-3 py-3 text-right font-medium">GP</th>
                            <th className="px-3 py-3 text-right font-medium">MPG</th>
                            <th className="px-3 py-3 text-right font-medium">PPG</th>
                            <th className="px-3 py-3 text-right font-medium">Suggested</th>
                            <th className="px-3 py-3 text-right font-medium">Default</th>
                            <th className="px-3 py-3 text-right font-medium">Proj. Pts</th>
                            <th className="px-3 py-3 text-right font-medium">Proj. GP</th>
                            <th className="px-3 py-3 text-right font-medium">Your Bid</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredBidPlayers.map((player) => (
                            <tr key={player.id} className="border-t border-border/70">
                              <td className="px-3 py-3 font-medium text-foreground">{player.name}</td>
                              <td className="px-3 py-3 text-muted-foreground">{player.team}</td>
                              <td className="px-3 py-3 text-muted-foreground">{player.conference}</td>
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
                              <td className="px-3 py-3 text-right font-medium tabular-nums text-foreground">
                                ${player.suggestedValue}
                              </td>
                              <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                                ${player.defaultBid}
                              </td>
                              <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                                {formatNullableNumber(player.totalPoints)}
                              </td>
                              <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                                {formatNullableNumber(player.totalGames)}
                              </td>
                              <td className="px-3 py-3">
                                <div className="flex items-center justify-end gap-1">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-xs"
                                    onClick={() => resetBidValue(player.id)}
                                    aria-label={`Reset bid for ${player.name}`}
                                    title="Reset to default"
                                  >
                                    <RefreshIcon className="size-3" />
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="xs"
                                    onClick={() => setBidValue(player.id, "0")}
                                    title="Pass (bid $0)"
                                    className="h-6 px-1.5 tabular-nums"
                                  >
                                    $0
                                  </Button>
                                  <Input
                                    type="text"
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    autoComplete="off"
                                    placeholder={String(player.defaultBid)}
                                    value={bidValues[player.id] ?? ""}
                                    onChange={(event) =>
                                      setBidValue(player.id, event.target.value)
                                    }
                                    className="h-7 w-20 text-right font-medium tabular-nums"
                                    style={bidInputStyle(
                                      parseBidValue(bidValues[player.id] ?? ""),
                                      player.suggestedValue,
                                    )}
                                  />
                                </div>
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
                    <div className="sticky bottom-2 z-10 flex flex-wrap gap-3 rounded-xl border border-border/80 bg-background/95 p-3 shadow-sm backdrop-blur md:static md:justify-end md:border-0 md:bg-transparent md:p-0 md:shadow-none md:backdrop-blur-none">
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
                          onClick={() => setShowCloseConfirm(true)}
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
                      <SelectField
                        id="round-mode"
                        className="h-9 w-full"
                        value={roundMode}
                        onChange={(event) =>
                          setRoundMode(event.target.value as "selected" | "all_remaining")
                        }
                      >
                        <option value="selected">Selected players</option>
                        <option value="all_remaining">All remaining players</option>
                      </SelectField>
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
                              <SelectField
                                className="h-9 w-full"
                                value={draftConferenceFilter}
                                onChange={(event) => setDraftConferenceFilter(event.target.value)}
                              >
                                <option value="all">All conferences</option>
                                <option value="E">East</option>
                                <option value="W">West</option>
                              </SelectField>
                              <SelectField
                                className="h-9 w-full"
                                value={draftTeamFilter}
                                onChange={(event) => setDraftTeamFilter(event.target.value)}
                              >
                                <option value="all">All teams</option>
                                {availableTeams.map((team) => (
                                  <option key={team} value={team}>
                                    {team}
                                  </option>
                                ))}
                              </SelectField>
                              <SelectField
                                className="h-9 w-full"
                                value={draftSeedFilter}
                                onChange={(event) => setDraftSeedFilter(event.target.value)}
                              >
                                <option value="all">All seeds</option>
                                {availableSeeds.map((seed) => (
                                  <option key={seed} value={String(seed)}>
                                    Seed {seed}
                                  </option>
                                ))}
                              </SelectField>
                              <SelectField
                                className="h-9 w-full"
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
                              </SelectField>
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
                                <SelectField
                                  id="preset-scope"
                                  className="h-9 w-full"
                                  value={presetScope}
                                  onChange={(event) =>
                                    setPresetScope(event.target.value as PresetScope)
                                  }
                                >
                                  <option value="all">All teams</option>
                                  <option value="exclude">All teams except</option>
                                  <option value="include">Only these teams</option>
                                </SelectField>
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

                      <div className="hidden overflow-x-auto rounded-xl border border-border/80 md:block">
                        <table className="min-w-full text-left text-sm">
                          <thead className="bg-muted/60 text-xs tracking-[0.18em] text-muted-foreground uppercase">
                            <tr>
                              <th className="px-3 py-3 text-left font-medium">Pick</th>
                              <th className="px-3 py-3 text-left font-medium">Player</th>
                              <th className="px-3 py-3 text-left font-medium">Team</th>
                              <th className="px-3 py-3 text-left font-medium">Conf</th>
                              <th className="px-3 py-3 text-right font-medium">Seed</th>
                              <th className="px-3 py-3 text-right font-medium">GP</th>
                              <th className="px-3 py-3 text-right font-medium">MPG</th>
                              <th className="px-3 py-3 text-right font-medium">PPG</th>
                              <th className="px-3 py-3 text-right font-medium">Suggested</th>
                              <th className="px-3 py-3 text-right font-medium">Proj. Pts</th>
                              <th className="px-3 py-3 text-right font-medium">Proj. GP</th>
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
            <CardContent className="space-y-2">
              {data.lastResolvedRound ? (
                data.lastResolvedRound.results.length ? (
                  data.lastResolvedRound.results.map((result) => {
                    const note = result.isAutoAssigned
                      ? "auto-assigned"
                      : result.wonByTiebreak
                        ? "after tiebreak"
                        : null;
                    return (
                      <div
                        key={result.playerId}
                        className="flex flex-col gap-2 rounded-xl bg-muted/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium text-foreground">
                            <span className="mr-1 text-xs tabular-nums text-muted-foreground">
                              #{result.order}
                            </span>
                            {result.playerName}
                          </p>
                          <p className="text-xs text-muted-foreground">{result.playerTeam}</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-200">
                            <span aria-hidden>👑</span>
                            {result.winnerName}
                            <span className="tabular-nums">· ${result.winningBid}</span>
                          </span>
                          {note ? (
                            <span className="text-[11px] text-muted-foreground">· {note}</span>
                          ) : null}
                        </div>
                      </div>
                    );
                  })
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
                Every team&apos;s sealed bid for each resolved round. Winning
                bids are highlighted emerald; runner-ups in amber.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-8">
              {data.draftHistory.length ? (
                data.draftHistory.map((round) => {
                  const totalSpent = round.rows.reduce(
                    (sum, row) => sum + (row.winningBid ?? 0),
                    0,
                  );
                  const playerCount = round.rows.length;
                  return (
                    <div key={round.id} className="space-y-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <div className="flex items-baseline gap-3">
                          <h3 className="text-base font-semibold text-foreground">
                            Round {round.roundNumber}
                          </h3>
                          <span className="text-xs text-muted-foreground">
                            {round.resolvedAt
                              ? formatRelativeTime(round.resolvedAt)
                              : "resolved"}
                          </span>
                        </div>
                        <p className="text-xs tabular-nums text-muted-foreground">
                          {playerCount} {playerCount === 1 ? "player" : "players"}
                          {" · "}
                          <span className="font-medium text-foreground">${totalSpent}</span>{" "}
                          spent
                        </p>
                      </div>

                      <div className="flex flex-col gap-2 md:hidden">
                        {round.rows.map((row) => {
                          const rowKey = `${round.id}:${row.playerId}`;
                          const expanded = expandedHistoryRows.has(rowKey);
                          const participantById = new Map(
                            round.participants.map((participant) => [
                              participant.userId,
                              participant.name,
                            ]),
                          );
                          const sortedBids = [...row.bids].sort((left, right) => {
                            const leftAmount =
                              left.amount ?? Number.NEGATIVE_INFINITY;
                            const rightAmount =
                              right.amount ?? Number.NEGATIVE_INFINITY;
                            return rightAmount - leftAmount;
                          });
                          return (
                            <div
                              key={row.playerId}
                              className="overflow-hidden rounded-xl border border-border/70 bg-card"
                            >
                              <button
                                type="button"
                                aria-expanded={expanded}
                                onClick={() =>
                                  setExpandedHistoryRows((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(rowKey)) {
                                      next.delete(rowKey);
                                    } else {
                                      next.add(rowKey);
                                    }
                                    return next;
                                  })
                                }
                                className="flex w-full flex-col gap-2 px-4 py-3 text-left"
                              >
                                <div className="flex items-baseline justify-between gap-3">
                                  <p className="min-w-0 truncate text-base font-semibold text-foreground">
                                    {row.playerName}
                                  </p>
                                  <p className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                                    {row.playerTeam} · sug. ${row.suggestedValue}
                                  </p>
                                </div>
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-200">
                                    <span aria-hidden>👑</span>
                                    {row.winnerName ?? "—"}
                                    {row.winningBid !== null ? (
                                      <span className="tabular-nums">
                                        · $
                                        {row.winningBid}
                                      </span>
                                    ) : null}
                                  </span>
                                  {row.runnerUpName ? (
                                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-400/10 dark:text-amber-200">
                                      2nd · {row.runnerUpName}
                                      {row.runnerUpBid !== null ? (
                                        <span className="tabular-nums">
                                          {" · "}
                                          {row.runnerUpBid === 0
                                            ? "Pass"
                                            : `$${row.runnerUpBid}`}
                                        </span>
                                      ) : null}
                                    </span>
                                  ) : null}
                                </div>
                                <p className="text-[11px] text-muted-foreground">
                                  {expanded
                                    ? "▾ Hide every bid"
                                    : `▸ Show every bid (${row.bids.length})`}
                                </p>
                              </button>
                              {expanded ? (
                                <div className="space-y-1.5 border-t border-border/60 bg-muted/20 px-3 py-3">
                                  {sortedBids.map((bid) => {
                                    const name =
                                      participantById.get(bid.userId) ?? bid.userId;
                                    const display =
                                      bid.amount === null
                                        ? "—"
                                        : bid.amount === 0
                                          ? "Pass"
                                          : `$${bid.amount}`;
                                    return (
                                      <div
                                        key={bid.userId}
                                        className={[
                                          "flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm tabular-nums",
                                          bid.amount === null
                                            ? "bg-muted/40 text-muted-foreground"
                                            : "",
                                        ].join(" ")}
                                        style={
                                          bid.amount === null
                                            ? undefined
                                            : bidInputStyle(bid.amount, row.suggestedValue)
                                        }
                                      >
                                        <span className="flex min-w-0 items-center gap-1.5 truncate font-medium">
                                          {bid.isWinningBid ? (
                                            <span aria-hidden>👑</span>
                                          ) : null}
                                          <span className="truncate">{name}</span>
                                        </span>
                                        <span className="shrink-0 font-semibold">
                                          {display}
                                        </span>
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>

                      <div className="hidden overflow-x-auto rounded-xl border border-border/80 md:block">
                        <table className="w-full min-w-[72rem] border-separate border-spacing-0 text-sm">
                          <thead className="bg-muted/40 text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
                            <tr>
                              <th className="sticky left-0 z-10 bg-muted/40 px-3 py-2 text-left font-medium backdrop-blur">
                                Player / Suggested
                              </th>
                              <th className="px-3 py-2 text-left font-medium">Winner / Bid</th>
                              <th className="px-3 py-2 text-left font-medium">Runner-Up / Bid</th>
                              {round.participants.map((participant) => {
                                const first = participant.name.split(" ")[0] ?? participant.name;
                                return (
                                  <th
                                    key={participant.userId}
                                    className="px-2 py-2 text-right font-medium"
                                    title={participant.name}
                                  >
                                    {first}
                                  </th>
                                );
                              })}
                            </tr>
                          </thead>
                          <tbody>
                            {round.rows.map((row, rowIndex) => {
                              const stripe = rowIndex % 2 === 0 ? "bg-background" : "bg-muted/20";
                              return (
                                <tr
                                  key={row.playerId}
                                  className={[
                                    "group/history-row border-t border-border/60 align-middle",
                                    stripe,
                                    "hover:bg-muted/40",
                                  ].join(" ")}
                                >
                                  <td
                                    className={[
                                      "sticky left-0 z-10 px-3 py-3",
                                      stripe,
                                      "border-r border-border/60 group-hover/history-row:bg-muted/40",
                                    ].join(" ")}
                                  >
                                    <div className="truncate font-medium text-foreground">
                                      {row.playerName}
                                    </div>
                                    <div className="text-[11px] tabular-nums text-muted-foreground">
                                      {row.playerTeam} · ${row.suggestedValue}
                                    </div>
                                  </td>
                                  <td className="px-3 py-3 align-middle">
                                    <div className="inline-flex min-w-[8rem] flex-col rounded-lg bg-emerald-500/15 px-3 py-1.5 dark:bg-emerald-400/10">
                                      <span className="text-sm font-semibold text-emerald-900 dark:text-emerald-100">
                                        {row.winnerName ?? "—"}
                                      </span>
                                      <span className="text-xs tabular-nums text-emerald-700 dark:text-emerald-300">
                                        {row.winningBid !== null ? `$${row.winningBid}` : "—"}
                                      </span>
                                    </div>
                                  </td>
                                  <td className="px-3 py-3 align-middle">
                                    <div className="inline-flex min-w-[8rem] flex-col rounded-lg bg-amber-500/10 px-3 py-1.5 dark:bg-amber-400/10">
                                      <span className="text-sm font-semibold text-amber-900 dark:text-amber-100">
                                        {row.runnerUpName ?? "—"}
                                      </span>
                                      <span className="text-xs tabular-nums text-amber-700 dark:text-amber-300">
                                        {row.runnerUpBid === null
                                          ? "—"
                                          : row.runnerUpBid === 0
                                            ? "Pass"
                                            : `$${row.runnerUpBid}`}
                                      </span>
                                    </div>
                                  </td>
                                  {row.bids.map((bid) => {
                                    const display =
                                      bid.amount === null
                                        ? "—"
                                        : bid.amount === 0
                                          ? "Pass"
                                          : `$${bid.amount}`;
                                    const isWin = bid.isWinningBid;
                                    const isRunnerUp = !isWin && bid.isSecondPlaceBid;
                                    return (
                                      <td
                                        key={bid.userId}
                                        className="px-2 py-3 text-right align-middle"
                                      >
                                        <span
                                          className={[
                                            "inline-block min-w-[3rem] text-sm tabular-nums transition-colors",
                                            isWin
                                              ? "font-semibold text-emerald-700 dark:text-emerald-300"
                                              : isRunnerUp
                                                ? "font-medium text-amber-700 dark:text-amber-300"
                                                : bid.amount === 0
                                                  ? "italic text-muted-foreground/70"
                                                  : bid.amount === null
                                                    ? "text-muted-foreground/50"
                                                    : "text-muted-foreground",
                                          ].join(" ")}
                                        >
                                          {display}
                                        </span>
                                      </td>
                                    );
                                  })}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })
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
            <CardTitle>Projected Standings and Rosters</CardTitle>
            <CardDescription>
              Rankings use each player&apos;s projected playoff total points from the player pool CSV. Actual playoff scoring will replace these once games begin.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 lg:grid-cols-2">
            {data.rosters.map((roster) => (
              <div key={roster.userId} className="rounded-xl border border-border/80 px-4 py-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-foreground">{roster.name}</p>
                    <p className="text-sm text-muted-foreground">{roster.totalPoints} projected pts</p>
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
                          <p className="font-medium text-foreground">
                            {player.playerName}
                            {player.isAutoAssigned ? (
                              <span className="ml-2 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-700">
                                Auto
                              </span>
                            ) : null}
                          </p>
                          <p className="text-muted-foreground">{player.playerTeam}</p>
                        </div>
                        <div className="text-right text-muted-foreground">
                          <p>${player.acquisitionBid}</p>
                          <p>{player.totalPoints} proj pts</p>
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

      <ConfirmDialog
        open={showCloseConfirm}
        title="Close round and reveal?"
        description={
          <p>
            This will lock every bid, resolve the auction, update rosters, and
            post the results. You can&apos;t undo this.
          </p>
        }
        confirmLabel="Close and reveal"
        destructive
        loading={closePending}
        onCancel={() => {
          if (!closePending) setShowCloseConfirm(false);
        }}
        onConfirm={() => void closeRound()}
      />
    </main>
  );
}
