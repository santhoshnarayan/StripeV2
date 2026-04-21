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
import { useSession } from "@/lib/auth-client";
import { SimulatorTab } from "@/components/simulator-tab";
import {
  computeManagerProjections,
  type ManagerProjection,
  type RosterInput,
} from "@/lib/sim";
import { useAutoSim } from "@/lib/use-auto-sim";
import { PlayerAvatar, TeamLogo } from "@/components/sim/player-avatar";
import { LiveGamesTicker } from "@/components/nba/live-games-ticker";
import { LeagueChartPanel } from "@/components/league/league-chart-panel";
import type { RosteredPlayerInfo } from "@/components/nba/game-detail";
import { usePolling } from "@/lib/use-polling";
import { markUserActive } from "@/lib/use-activity";
import { useLeagueProjections } from "@/lib/use-league-projections";

// usePolling already pauses when tab is hidden or the user is idle past
// POLL_INACTIVE_TIMEOUT_MS, so this is the cadence for an active foregrounded
// session. League-detail data (rosters, members, leagueAction) doesn't need
// 8s freshness — sim/live ticker poll separately on their own hooks.
const POLL_INTERVAL_MS = 30_000;
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
    isMember: boolean;
    isPublic: boolean;
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
    injuryStatus?: string | null;
  }>;
  allPlayers?: Array<{
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
    injuryStatus?: string | null;
    draftedBy: {
      userId: string;
      name: string;
      acquisitionBid: number;
      isAutoAssigned: boolean;
    } | null;
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
      injuryStatus?: string | null;
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
      totalPoints: number | null;
      winnerUserId: string | null;
      winnerName: string | null;
      winningBid: number | null;
      winnerRemainingBudget: number | null;
      winnerRemainingSlots: number | null;
      runnerUpName: string | null;
      runnerUpBid: number | null;
      bids: Array<{
        userId: string;
        userName: string;
        amount: number | null;
        maxAllowed: number | null;
        isWinningBid: boolean;
        isSecondPlaceBid: boolean;
        isAutoDefault?: boolean;
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
      totalPoints: number | null;
      suggestedValue: number;
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
  auctionState: {
    status: string;
    bidTimerSeconds: number;
    nominationTimerSeconds: number;
    nominationOrder: string[];
    nominationIndex: number;
    currentNominatorUserId: string | null;
    currentPlayerId: string | null;
    currentPlayerName: string | null;
    currentPlayerTeam: string | null;
    highBidAmount: number | null;
    highBidUserId: string | null;
    expiresAt: string | null;
    totalAwards: number;
  } | null;
  snakeState: {
    status: string;
    timed: boolean;
    pickTimerSeconds: number;
    pickOrder: string[];
    currentPickIndex: number;
    currentPickerUserId: string | null;
    totalPicks: number;
    currentRound: number;
    totalRounds: number;
    expiresAt: string | null;
  } | null;
  actions: Array<{
    id: string;
    type: string;
    userId: string | null;
    playerId: string | null;
    amount: number | null;
    actorUserId: string | null;
    roundId: string | null;
    sequenceNumber: number;
    metadata: Record<string, unknown> | null;
    createdAt: string;
  }>;
  livePoints?: Record<string, number>;
};

const PHASE_LABELS: Record<string, string> = {
  invite: "Invite",
  draft: "Draft",
  scoring: "Scoring",
};

const ACTION_TYPE_LABELS: Record<string, string> = {
  draft_award: "Draft Award",
  roster_remove: "Remove & Refund",
  roster_add: "Commissioner Add",
  budget_adjust: "Budget Adjustment",
  round_opened: "Round Opened",
  round_closed: "Round Closed",
  auction_start: "Auction Started",
  auction_nominate: "Nomination",
  auction_bid: "Bid",
  auction_award: "Auction Award",
  auction_pass: "Passed",
  auction_pause: "Paused",
  auction_resume: "Resumed",
  auction_undo_award: "Undo Award",
  auction_end: "Auction Ended",
  snake_start: "Snake Draft Started",
  snake_pick: "Snake Pick",
  snake_auto_pick: "Auto-Pick (Timeout)",
  snake_pause: "Paused",
  snake_resume: "Resumed",
  snake_undo_pick: "Undo Pick",
  snake_end: "Snake Draft Ended",
};

type LeagueTab = "overview" | "managers" | "players" | "draft" | "reveal" | "standings" | "simulator" | "chart" | "commissioner";
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
  simulator: { label: "Simulator", shortLabel: "Sim" },
  chart: { label: "Chart", shortLabel: "Chart" },
  reveal: { label: "Reveal", shortLabel: "Reveal" },
  standings: { label: "Standings", shortLabel: "Standings" },
  commissioner: { label: "Commissioner", shortLabel: "Commish" },
};

const PUBLIC_TABS: ReadonlySet<LeagueTab> = new Set([
  "standings",
  "chart",
  "simulator",
  "reveal",
]);

function getLeagueTabOrder(
  phase: string,
  isCommissioner?: boolean,
  isMember: boolean = true,
): LeagueTab[] {
  const base: LeagueTab[] = phase === "draft" || phase === "invite"
    ? ["draft", "simulator", "overview", "managers", "players", "reveal", "standings"]
    : ["standings", "chart", "simulator", "overview", "managers", "players", "draft", "reveal"];
  if (isCommissioner) base.push("commissioner");
  if (!isMember) return base.filter((t) => PUBLIC_TABS.has(t));
  return base;
}

function formatNullableNumber(value: number | null, digits = 1) {
  if (value === null) {
    return "-";
  }

  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function InjuryBadge({ status }: { status?: string | null }) {
  if (!status) return null;
  const label = status === "out" ? "OUT"
    : status === "doubtful" ? "D"
    : status === "questionable" ? "Q"
    : status === "probable" ? "P"
    : null;
  if (!label) return null;
  return (
    <span className="ml-1 text-[10px] font-semibold text-red-500 dark:text-red-400">
      {label}
    </span>
  );
}

function shortenNames(name: string, nameToShort: Map<string, string>): string {
  const parts = name.split(", ").map((n) => n.trim());
  return parts.map((n) => nameToShort.get(n) ?? n).join(", ");
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

// "East (2)" / "West (3)" / "East" / "—"
function formatConferenceSeed(
  conference: string | null | undefined,
  seed: number | null | undefined,
) {
  const confLabel =
    conference === "E" ? "East" : conference === "W" ? "West" : conference ?? "";
  if (!confLabel) return seed != null ? `Seed ${seed}` : "—";
  return seed != null ? `${confLabel} (${seed})` : confLabel;
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

  let backgroundColor: string;
  let color: string;

  if (ratio <= 0) {
    backgroundColor = "var(--bid-red-bg)";
    color = "var(--bid-red-fg)";
  } else if (ratio <= 0.75) {
    const t = ratio / 0.75;
    backgroundColor = mix("var(--bid-red-bg)", "var(--bid-yellow-bg)", t);
    color = mix("var(--bid-red-fg)", "var(--bid-yellow-fg)", t);
  } else if (ratio <= 1.0) {
    const t = (ratio - 0.75) / 0.25;
    backgroundColor = mix("var(--bid-yellow-bg)", "var(--bid-white-bg)", t);
    color = mix("var(--bid-yellow-fg)", "var(--bid-white-fg)", t);
  } else if (ratio <= 1.25) {
    const t = (ratio - 1.0) / 0.25;
    backgroundColor = mix("var(--bid-white-bg)", "var(--bid-green-bg)", t);
    color = mix("var(--bid-white-fg)", "var(--bid-green-fg)", t);
  } else {
    backgroundColor = "var(--bid-green-bg)";
    color = "var(--bid-green-fg)";
  }

  // The shared Input component renders with `border border-input`, which in
  // light mode is a solid gray that pops against the tinted background. Match
  // the border to the bg so the tint fills edge-to-edge in both themes.
  return { backgroundColor, color, borderColor: backgroundColor };
}

// ====================== LIVE AUCTION COMPONENTS ======================

type AuctionSSEState = {
  status: string;
  bidTimerSeconds: number;
  nominationTimerSeconds: number;
  nominationOrder: string[];
  nominationIndex: number;
  currentNominatorUserId: string | null;
  currentPlayerId: string | null;
  currentPlayerName: string | null;
  currentPlayerTeam: string | null;
  highBidAmount: number | null;
  highBidUserId: string | null;
  expiresAt: string | null;
  totalAwards: number;
  leagueId: string;
};

function useAuctionSSE(leagueId: string, enabled: boolean) {
  const [state, setState] = useState<AuctionSSEState | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const es = new EventSource(`/api/app/leagues/${leagueId}/auction/stream`, {
      withCredentials: true,
    });

    es.addEventListener("state", (e) => {
      setState(JSON.parse(e.data));
      setConnected(true);
    });
    es.addEventListener("bid", (e) => {
      const bid = JSON.parse(e.data);
      setState((prev) =>
        prev
          ? {
              ...prev,
              highBidAmount: bid.amount,
              highBidUserId: bid.userId,
              expiresAt: bid.expiresAt,
            }
          : prev,
      );
    });
    es.addEventListener("award", (e) => {
      const award = JSON.parse(e.data);
      toast.success(`${award.playerName} awarded for $${award.amount}`);
    });
    es.addEventListener("nominate", (e) => {
      const nom = JSON.parse(e.data);
      setState((prev) =>
        prev
          ? {
              ...prev,
              status: "bidding",
              currentPlayerId: nom.playerId,
              currentPlayerName: nom.playerName,
              currentPlayerTeam: nom.playerTeam,
              highBidAmount: nom.openingBid,
              highBidUserId: nom.nominatorUserId,
              expiresAt: nom.expiresAt,
            }
          : prev,
      );
    });
    es.addEventListener("nominate_turn", (e) => {
      const turn = JSON.parse(e.data);
      setState((prev) =>
        prev
          ? {
              ...prev,
              status: "nominating",
              currentNominatorUserId: turn.nominatorUserId,
              nominationIndex: turn.nominationIndex,
              currentPlayerId: null,
              currentPlayerName: null,
              currentPlayerTeam: null,
              highBidAmount: null,
              highBidUserId: null,
              expiresAt: null,
            }
          : prev,
      );
    });
    es.addEventListener("pause", () => {
      setState((prev) => (prev ? { ...prev, status: "paused" } : prev));
    });
    es.addEventListener("resume", (e) => {
      const d = JSON.parse(e.data);
      setState((prev) =>
        prev
          ? {
              ...prev,
              status: d.status,
              expiresAt: d.expiresAt,
            }
          : prev,
      );
    });
    es.addEventListener("end", () => {
      setState((prev) => (prev ? { ...prev, status: "completed" } : prev));
    });
    es.addEventListener("undo_award", (e) => {
      const d = JSON.parse(e.data);
      toast(`Undone: ${d.playerName} removed from roster, $${d.refundAmount} refunded`);
    });

    es.onerror = () => {
      setConnected(false);
    };

    return () => es.close();
  }, [leagueId, enabled]);

  return { state, connected };
}

function CountdownTimer({ expiresAt }: { expiresAt: string | null }) {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!expiresAt) {
      setRemaining(null);
      return;
    }
    const target = new Date(expiresAt).getTime();

    const tick = () => {
      const ms = target - Date.now();
      setRemaining(Math.max(0, ms));
    };
    tick();
    const interval = setInterval(tick, 100);
    return () => clearInterval(interval);
  }, [expiresAt]);

  if (remaining === null) return null;
  const seconds = Math.ceil(remaining / 1000);
  const isUrgent = seconds <= 3;
  return (
    <span
      className={
        isUrgent
          ? "tabular-nums font-bold text-red-500 animate-pulse"
          : "tabular-nums font-medium"
      }
    >
      {seconds}s
    </span>
  );
}

// ============================================================
// SNAKE DRAFT
// ============================================================

type SnakeSSEState = {
  status: string;
  timed: boolean;
  pickTimerSeconds: number;
  pickOrder: string[];
  currentPickIndex: number;
  currentPickerUserId: string | null;
  totalPicks: number;
  currentRound: number;
  totalRounds: number;
  expiresAt: string | null;
  leagueId: string;
};

function useSnakeSSE(leagueId: string, enabled: boolean) {
  const [state, setState] = useState<SnakeSSEState | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const es = new EventSource(`/api/app/leagues/${leagueId}/snake/stream`, {
      withCredentials: true,
    });

    es.addEventListener("state", (e) => {
      setState(JSON.parse(e.data));
      setConnected(true);
    });
    es.addEventListener("pick", (e) => {
      const d = JSON.parse(e.data);
      toast.success(`${d.playerName} picked by ${d.pickerUserId}`);
    });
    es.addEventListener("auto_pick", (e) => {
      const d = JSON.parse(e.data);
      if (d.skipped) {
        toast("Pick skipped — no players available");
      } else {
        toast(`Auto-pick: ${d.playerName}`);
      }
    });
    es.addEventListener("next_pick", (e) => {
      const d = JSON.parse(e.data);
      setState((prev) =>
        prev
          ? {
              ...prev,
              currentPickerUserId: d.pickerUserId,
              currentPickIndex: d.pickIndex,
              currentRound: d.round,
              expiresAt: d.expiresAt,
            }
          : prev,
      );
    });
    es.addEventListener("pause", () => {
      setState((prev) => (prev ? { ...prev, status: "paused", expiresAt: null } : prev));
    });
    es.addEventListener("resume", (e) => {
      const d = JSON.parse(e.data);
      setState((prev) =>
        prev
          ? { ...prev, status: d.status, expiresAt: d.expiresAt }
          : prev,
      );
    });
    es.addEventListener("end", () => {
      setState((prev) => (prev ? { ...prev, status: "completed" } : prev));
    });
    es.addEventListener("undo_pick", (e) => {
      const d = JSON.parse(e.data);
      toast(`Undone: ${d.playerName}`);
      if (d.rewound) {
        setState((prev) =>
          prev
            ? {
                ...prev,
                currentPickerUserId: d.currentPickerUserId,
                currentPickIndex: d.currentPickIndex,
                expiresAt: d.expiresAt,
              }
            : prev,
        );
      }
    });

    es.onerror = () => {
      setConnected(false);
    };

    return () => es.close();
  }, [leagueId, enabled]);

  return { state, connected };
}

function SnakeDraftPanel({
  leagueId,
  data,
  viewerUserId,
  onRefresh,
}: {
  leagueId: string;
  data: LeagueDetail;
  viewerUserId: string;
  onRefresh: () => void;
}) {
  const { state: sseState, connected } = useSnakeSSE(leagueId, true);
  const [playerSearch, setPlayerSearch] = useState("");
  const [sortBy, setSortBy] = useState<DraftSortOption>("suggested_desc");
  const [showEndConfirm, setShowEndConfirm] = useState(false);

  const memberMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const mem of data.members) m.set(mem.userId, mem.name);
    return m;
  }, [data.members]);

  const rosteredPlayerIds = useMemo(() => {
    const ids = new Set<string>();
    for (const r of data.rosters) {
      for (const p of r.players) ids.add(p.playerId);
    }
    return ids;
  }, [data.rosters]);

  const availablePlayers = useMemo(() => {
    const filtered = (data.availablePlayers ?? []).filter(
      (p) => !rosteredPlayerIds.has(p.id),
    );
    const searched = playerSearch
      ? filtered.filter(
          (p) =>
            p.name.toLowerCase().includes(playerSearch.toLowerCase()) ||
            p.team.toLowerCase().includes(playerSearch.toLowerCase()),
        )
      : filtered;
    return sortDraftPlayers(searched, sortBy);
  }, [data.availablePlayers, rosteredPlayerIds, playerSearch, sortBy]);

  if (!sseState) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-muted-foreground">
          Connecting to snake draft...
        </CardContent>
      </Card>
    );
  }

  const isMyTurn = sseState.currentPickerUserId === viewerUserId;
  const currentPickerName = sseState.currentPickerUserId
    ? memberMap.get(sseState.currentPickerUserId) ?? "Unknown"
    : "—";
  const isCommissioner = data.league.isCommissioner;
  const isPaused = sseState.status === "paused";
  const isCompleted = sseState.status === "completed";
  const pickOrder = sseState.pickOrder as string[];
  const memberCount = new Set(pickOrder).size;

  async function handlePick(player: { id: string; name: string; team: string }) {
    try {
      const result = await appApiFetch<{ ok: boolean; error?: string }>(
        `/leagues/${leagueId}/snake/pick`,
        {
          method: "POST",
          body: JSON.stringify({
            playerId: player.id,
            playerName: player.name,
            playerTeam: player.team,
          }),
        },
      );
      if (result.ok) {
        onRefresh();
      } else {
        toast.error(result.error ?? "Failed to pick");
      }
    } catch {
      toast.error("Failed to pick");
    }
  }

  async function handleSnakeAction(action: string) {
    try {
      const result = await appApiFetch<{ ok: boolean; error?: string }>(
        `/leagues/${leagueId}/snake/${action}`,
        { method: "POST", body: JSON.stringify({}) },
      );
      if (!result.ok) {
        toast.error(result.error ?? `Failed to ${action}`);
      } else {
        onRefresh();
      }
    } catch {
      toast.error(`Failed to ${action}`);
    }
  }

  if (isCompleted) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-lg font-semibold mb-2">Snake Draft Complete</p>
          <p className="text-muted-foreground">
            {sseState.totalPicks} picks made across {sseState.totalRounds} rounds.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">
                Snake Draft — Round {sseState.currentRound} of {sseState.totalRounds}
              </CardTitle>
              <CardDescription>
                Pick {sseState.currentPickIndex + 1} of {pickOrder.length}
                {!connected && " (reconnecting...)"}
              </CardDescription>
            </div>
            {isCommissioner && (
              <div className="flex gap-2">
                {sseState.timed && !isPaused && (
                  <Button size="sm" variant="outline" onClick={() => handleSnakeAction("pause")}>
                    Pause
                  </Button>
                )}
                {isPaused && (
                  <Button size="sm" variant="outline" onClick={() => handleSnakeAction("resume")}>
                    Resume
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => handleSnakeAction("undo-pick")}>
                  Undo Last
                </Button>
                <Button size="sm" variant="destructive" onClick={() => setShowEndConfirm(true)}>
                  End Draft
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <div className="flex-1">
              {isPaused ? (
                <p className="text-amber-500 font-semibold">Draft Paused</p>
              ) : isMyTurn ? (
                <p className="text-green-600 font-semibold text-lg">Your turn to pick!</p>
              ) : (
                <p className="text-muted-foreground">
                  Waiting for <span className="font-medium text-foreground">{currentPickerName}</span>...
                </p>
              )}
            </div>
            {sseState.timed && !isPaused && sseState.expiresAt && (
              <div className="text-right">
                <span className="text-xs text-muted-foreground mr-1">Timer:</span>
                <CountdownTimer expiresAt={sseState.expiresAt} />
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Pick Order Visual */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Pick Order</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1">
            {pickOrder.slice(
              Math.max(0, sseState.currentPickIndex - 3),
              sseState.currentPickIndex + memberCount + 3,
            ).map((userId, i) => {
              const actualIndex = Math.max(0, sseState.currentPickIndex - 3) + i;
              const isCurrent = actualIndex === sseState.currentPickIndex;
              const isPast = actualIndex < sseState.currentPickIndex;
              const name = memberMap.get(userId) ?? "?";
              return (
                <span
                  key={`${actualIndex}-${userId}`}
                  className={`inline-flex items-center px-2 py-0.5 rounded text-xs ${
                    isCurrent
                      ? "bg-green-600 text-white font-bold"
                      : isPast
                        ? "bg-muted text-muted-foreground line-through"
                        : "bg-muted/50 text-foreground"
                  }`}
                >
                  {name}
                </span>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Manager Status */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Manager Status</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {data.members.map((m) => {
              const rosterCount = data.rosters.find((r) => r.userId === m.userId)?.players.length ?? 0;
              return (
                <div
                  key={m.userId}
                  className={`rounded-lg border px-3 py-2 text-sm ${
                    m.userId === sseState.currentPickerUserId
                      ? "border-green-500 bg-green-500/10"
                      : "border-border"
                  }`}
                >
                  <p className="font-medium truncate">{m.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {rosterCount} / {data.league.rosterSize} players
                  </p>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Available Players — only show full list when it's my turn */}
      {isMyTurn && !isPaused ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Available Players — Click to Pick</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2 mb-3">
              <Input
                placeholder="Search players..."
                value={playerSearch}
                onChange={(e) => setPlayerSearch(e.target.value)}
                className="max-w-xs"
              />
              <SelectField
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as DraftSortOption)}
              >
                <option value="suggested_desc">Value (high)</option>
                <option value="projected_desc">Projected Pts</option>
                <option value="name_asc">Name (A-Z)</option>
                <option value="team_asc">Team</option>
              </SelectField>
            </div>
            <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground text-left">
                    <th className="py-1.5 pr-3">Player</th>
                    <th className="py-1.5 pr-3">Team</th>
                    <th className="py-1.5 pr-3 text-right">Value</th>
                    <th className="py-1.5 pr-3 text-right">Proj Pts</th>
                    <th className="py-1.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {availablePlayers.slice(0, 50).map((p) => (
                    <tr key={p.id} className="border-b border-border/50 hover:bg-muted/30">
                      <td className="py-1.5 pr-3 font-medium">{p.name}</td>
                      <td className="py-1.5 pr-3 text-muted-foreground">{p.team}</td>
                      <td className="py-1.5 pr-3 text-right">${p.suggestedValue}</td>
                      <td className="py-1.5 pr-3 text-right">{p.totalPoints ?? "—"}</td>
                      <td className="py-1.5 text-right">
                        <Button
                          size="sm"
                          variant="default"
                          onClick={() => handlePick({ id: p.id, name: p.name, team: p.team })}
                        >
                          Pick
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Available Players</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2 mb-3">
              <Input
                placeholder="Search players..."
                value={playerSearch}
                onChange={(e) => setPlayerSearch(e.target.value)}
                className="max-w-xs"
              />
            </div>
            <div className="overflow-x-auto max-h-[300px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground text-left">
                    <th className="py-1.5 pr-3">Player</th>
                    <th className="py-1.5 pr-3">Team</th>
                    <th className="py-1.5 pr-3 text-right">Value</th>
                    <th className="py-1.5 text-right">Proj Pts</th>
                  </tr>
                </thead>
                <tbody>
                  {availablePlayers.slice(0, 50).map((p) => (
                    <tr key={p.id} className="border-b border-border/50">
                      <td className="py-1.5 pr-3">{p.name}</td>
                      <td className="py-1.5 pr-3 text-muted-foreground">{p.team}</td>
                      <td className="py-1.5 pr-3 text-right">${p.suggestedValue}</td>
                      <td className="py-1.5 text-right">{p.totalPoints ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={showEndConfirm}
        title="End Snake Draft?"
        description="This will end the draft immediately. Remaining picks won't be made."
        confirmLabel="End Draft"
        destructive
        onCancel={() => setShowEndConfirm(false)}
        onConfirm={() => {
          setShowEndConfirm(false);
          handleSnakeAction("end");
        }}
      />
    </div>
  );
}

function AuctionDraftPanel({
  leagueId,
  data,
  viewerUserId,
  onRefresh,
}: {
  leagueId: string;
  data: LeagueDetail;
  viewerUserId: string;
  onRefresh: () => void;
}) {
  const { state: sseState, connected } = useAuctionSSE(leagueId, !!data.auctionState);
  const auction = sseState ?? data.auctionState;
  const [bidAmount, setBidAmount] = useState("");
  const [nomSearch, setNomSearch] = useState("");
  const [nomBid, setNomBid] = useState("");
  const [actionPending, setActionPending] = useState(false);

  const memberMap = useMemo(
    () => new Map(data.members.map((m) => [m.userId, m])),
    [data.members],
  );

  const isCommissioner = data.league.isCommissioner;
  const isMyNomination =
    auction?.status === "nominating" &&
    auction.currentNominatorUserId === viewerUserId;

  const filteredPlayers = useMemo(() => {
    if (!nomSearch) return data.availablePlayers.slice(0, 20);
    const q = nomSearch.toLowerCase();
    return data.availablePlayers
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.team.toLowerCase().includes(q),
      )
      .slice(0, 20);
  }, [data.availablePlayers, nomSearch]);

  async function handleNominate(playerId: string, playerName: string, playerTeam: string) {
    const bid = parseInt(nomBid) || 1;
    setActionPending(true);
    try {
      const result = await appApiFetch<{ ok: boolean; error?: string }>(
        `/leagues/${leagueId}/auction/nominate`,
        {
          method: "POST",
          body: JSON.stringify({ playerId, playerName, playerTeam, openingBid: bid }),
        },
      );
      if (!result.ok) toast.error(result.error ?? "Nomination failed");
      else {
        setNomSearch("");
        setNomBid("");
        onRefresh();
      }
    } catch {
      toast.error("Nomination failed");
    } finally {
      setActionPending(false);
    }
  }

  async function handleBid() {
    const amount = parseInt(bidAmount);
    if (!amount || amount <= (auction?.highBidAmount ?? 0)) {
      toast.error("Bid must be higher than current high bid");
      return;
    }
    setActionPending(true);
    try {
      const result = await appApiFetch<{ ok: boolean; error?: string }>(
        `/leagues/${leagueId}/auction/bid`,
        { method: "POST", body: JSON.stringify({ amount }) },
      );
      if (!result.ok) toast.error(result.error ?? "Bid failed");
      else {
        setBidAmount("");
        toast.success(`Bid $${amount} placed!`);
      }
    } catch {
      toast.error("Bid failed");
    } finally {
      setActionPending(false);
    }
  }

  async function handleCommissionerAction(action: string) {
    setActionPending(true);
    try {
      const result = await appApiFetch<{ ok: boolean; error?: string }>(
        `/leagues/${leagueId}/auction/${action}`,
        { method: "POST", body: JSON.stringify({}) },
      );
      if (!result.ok) toast.error(result.error ?? "Action failed");
      else onRefresh();
    } catch {
      toast.error("Action failed");
    } finally {
      setActionPending(false);
    }
  }

  if (!auction) return null;

  const nominatorName = auction.currentNominatorUserId
    ? memberMap.get(auction.currentNominatorUserId)?.name ?? "Unknown"
    : "—";
  const highBidderName = auction.highBidUserId
    ? memberMap.get(auction.highBidUserId)?.name ?? "Unknown"
    : "—";
  const minNextBid = (auction.highBidAmount ?? 0) + 1;

  return (
    <div className="space-y-4">
      {/* Status banner */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">Live Auction Draft</CardTitle>
              <CardDescription>
                {auction.totalAwards} players drafted
                {!connected && sseState === null ? " (connecting...)" : ""}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={[
                  "inline-flex h-2 w-2 rounded-full",
                  auction.status === "paused"
                    ? "bg-amber-500"
                    : connected
                      ? "bg-emerald-500"
                      : "bg-red-500 animate-pulse",
                ].join(" ")}
              />
              <span className="text-sm text-muted-foreground capitalize">
                {auction.status === "paused" ? "Paused" : connected ? "Live" : "Reconnecting"}
              </span>
              {isCommissioner && auction.status !== "completed" ? (
                <div className="flex gap-1 ml-2">
                  {auction.status === "paused" ? (
                    <Button size="sm" variant="outline" disabled={actionPending} onClick={() => handleCommissionerAction("resume")}>
                      Resume
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" disabled={actionPending} onClick={() => handleCommissionerAction("pause")}>
                      Pause
                    </Button>
                  )}
                  <Button size="sm" variant="destructive" disabled={actionPending} onClick={() => handleCommissionerAction("end")}>
                    End
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Current bidding slot */}
          {auction.status === "bidding" && auction.currentPlayerName ? (
            <div className="rounded-lg border border-border/80 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Now bidding on</p>
                  <p className="text-xl font-semibold">
                    {auction.currentPlayerName}{" "}
                    <span className="text-muted-foreground text-base">({auction.currentPlayerTeam})</span>
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm text-muted-foreground">Time remaining</p>
                  <p className="text-2xl">
                    <CountdownTimer expiresAt={auction.expiresAt} />
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2">
                <div>
                  <span className="text-sm text-muted-foreground">High bid: </span>
                  <span className="font-semibold text-lg">${auction.highBidAmount}</span>
                  <span className="text-sm text-muted-foreground ml-1">by {highBidderName}</span>
                </div>
                {auction.highBidUserId === viewerUserId ? (
                  <span className="text-sm font-medium text-emerald-600">You are winning</span>
                ) : null}
              </div>
              {/* Bid input */}
              {auction.highBidUserId !== viewerUserId ? (
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    placeholder={`Min $${minNextBid}`}
                    value={bidAmount}
                    onChange={(e) => setBidAmount(e.target.value)}
                    className="w-32"
                    min={minNextBid}
                    onKeyDown={(e) => { if (e.key === "Enter") handleBid(); }}
                  />
                  <Button disabled={actionPending || !bidAmount} onClick={handleBid}>
                    Bid ${bidAmount || minNextBid}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={actionPending}
                    onClick={() => {
                      setBidAmount(String(minNextBid));
                      setTimeout(handleBid, 0);
                    }}
                  >
                    +$1
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Nomination phase */}
          {auction.status === "nominating" ? (
            <div className="rounded-lg border border-border/80 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Nominating</p>
                  <p className="text-lg font-semibold">
                    {isMyNomination ? "Your turn to nominate!" : `Waiting for ${nominatorName}...`}
                  </p>
                </div>
                {auction.expiresAt ? (
                  <div className="text-right">
                    <p className="text-sm text-muted-foreground">Time remaining</p>
                    <p className="text-2xl">
                      <CountdownTimer expiresAt={auction.expiresAt} />
                    </p>
                  </div>
                ) : null}
              </div>
              {isMyNomination ? (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <Input
                      placeholder="Search players..."
                      value={nomSearch}
                      onChange={(e) => setNomSearch(e.target.value)}
                      className="flex-1"
                    />
                    <Input
                      type="number"
                      placeholder="Opening bid"
                      value={nomBid}
                      onChange={(e) => setNomBid(e.target.value)}
                      className="w-32"
                      min={1}
                    />
                  </div>
                  <div className="max-h-60 overflow-y-auto space-y-1">
                    {filteredPlayers.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        disabled={actionPending}
                        className="w-full flex items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-muted/60 transition-colors text-left"
                        onClick={() => handleNominate(p.id, p.name, p.team)}
                      >
                        <span>
                          {p.name} <span className="text-muted-foreground">({p.team})</span>
                        </span>
                        <span className="text-muted-foreground">${p.suggestedValue}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Paused state */}
          {auction.status === "paused" ? (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-center">
              <p className="text-lg font-semibold text-amber-600">Auction Paused</p>
              <p className="text-sm text-muted-foreground">
                The commissioner has paused the auction. Timer will reset when resumed.
              </p>
            </div>
          ) : null}

          {/* Completed */}
          {auction.status === "completed" ? (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 text-center">
              <p className="text-lg font-semibold text-emerald-600">Auction Complete</p>
              <p className="text-sm text-muted-foreground">
                {auction.totalAwards} players were drafted.
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Manager status */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Manager Status</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {data.members.map((m) => {
              const isNominator = auction.currentNominatorUserId === m.userId;
              const isHighBidder = auction.highBidUserId === m.userId;
              return (
                <div
                  key={m.userId}
                  className={[
                    "flex items-center justify-between rounded-md border px-3 py-2 text-sm",
                    isNominator
                      ? "border-blue-500/50 bg-blue-500/5"
                      : isHighBidder
                        ? "border-emerald-500/50 bg-emerald-500/5"
                        : "border-border/70",
                  ].join(" ")}
                >
                  <div className="flex items-center gap-2">
                    {isNominator ? (
                      <span className="inline-flex h-1.5 w-1.5 rounded-full bg-blue-500" />
                    ) : isHighBidder ? (
                      <span className="inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    ) : null}
                    <span className="font-medium truncate">{m.name}</span>
                  </div>
                  <div className="flex items-center gap-3 text-muted-foreground">
                    <span>${m.remainingBudget}</span>
                    <span>{m.rosterCount}/{data.league.rosterSize}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Available players */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Available Players ({data.availablePlayers.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="max-h-96 overflow-y-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="pb-2 font-medium">Player</th>
                  <th className="pb-2 font-medium text-right">Projected</th>
                  <th className="pb-2 font-medium text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {data.availablePlayers.slice(0, 50).map((p) => (
                  <tr key={p.id} className="border-b border-border/40">
                    <td className="py-1.5">
                      {p.name} <span className="text-muted-foreground">({p.team})</span>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{p.totalPoints?.toFixed(1) ?? "—"}</td>
                    <td className="py-1.5 text-right tabular-nums">${p.suggestedValue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

type StandingsSortKey = "current" | "winProb" | "projected";
type SortDir = "asc" | "desc";

function StandingsPanel({
  leagueId,
  rosters,
  livePoints,
  isScoring,
}: {
  leagueId: string;
  rosters: LeagueDetail["rosters"];
  livePoints: Record<string, number>;
  isScoring: boolean;
}) {
  const [sort, setSort] = useState<StandingsSortKey>(isScoring ? "current" : "projected");
  const [dir, setDir] = useState<SortDir>("desc");
  const { simResults, status: simStatus } = useAutoSim(leagueId);
  const simLoading = simStatus === "loading" || simStatus === "running";

  const simPtsByPlayer = useMemo(() => {
    if (!simResults) return null;
    return new Map(simResults.players.map((p) => [p.espnId, p.projectedPoints]));
  }, [simResults]);

  const managerProjections = useMemo<ManagerProjection[] | null>(() => {
    if (!simResults) return null;
    const inputs: RosterInput[] = rosters.map((r) => ({
      userId: r.userId,
      name: r.name,
      playerIds: r.players.map((p) => p.playerId),
    }));
    return computeManagerProjections(simResults, inputs);
  }, [simResults, rosters]);

  const rows = useMemo(() => {
    const projByUser = new Map(managerProjections?.map((p) => [p.userId, p]) ?? []);
    return rosters.map((r) => {
      const current = r.players.reduce(
        (sum, p) => sum + (livePoints[p.playerId] ?? 0),
        0,
      );
      const simProjected = simPtsByPlayer
        ? r.players.reduce(
            (sum, p) => sum + (simPtsByPlayer.get(p.playerId) ?? 0),
            0,
          )
        : null;
      const csvProjected = r.totalPoints;
      const mp = projByUser.get(r.userId);
      return {
        userId: r.userId,
        name: r.name,
        players: r.players.length,
        current,
        projected: simProjected ?? csvProjected,
        winProbability: mp?.winProbability ?? null,
      };
    });
  }, [rosters, livePoints, simPtsByPlayer, managerProjections]);

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      let d = 0;
      if (sort === "current") d = a.current - b.current;
      else if (sort === "winProb")
        d = (a.winProbability ?? -1) - (b.winProbability ?? -1);
      else d = a.projected - b.projected;
      if (d === 0) d = a.projected - b.projected;
      if (d === 0) d = a.name.localeCompare(b.name);
      return dir === "desc" ? -d : d;
    });
    return copy;
  }, [rows, sort, dir]);

  const handleSort = (next: StandingsSortKey) => {
    if (sort === next) setDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSort(next);
      setDir("desc");
    }
  };

  const arrow = (key: StandingsSortKey) =>
    sort === key ? (dir === "desc" ? " ▼" : " ▲") : "";

  const rosterOrder = sorted.map((r) => r.userId);
  const rosterByUser = new Map(rosters.map((r) => [r.userId, r]));
  const hasSim = Boolean(simResults);
  const hasLivePoints = rows.some((r) => r.current > 0);

  return (
    <div className="space-y-6">
      {/* Standings Table */}
      <Card>
        <CardHeader>
          <CardTitle>Standings</CardTitle>
          <CardDescription>
            {isScoring || hasLivePoints
              ? "Live playoff scoring. Click a column to sort."
              : "Projected rankings. Live scoring begins once games tip off."}
            {!hasSim ? (
              <>
                {" "}
                <span className="text-muted-foreground/80">
                  {simLoading
                    ? "Computing win probabilities…"
                    : simStatus === "error"
                    ? "Could not compute projections — try the Simulator tab."
                    : "Open the Simulator tab to populate win % and sim-based projections."}
                </span>
              </>
            ) : null}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-xl border border-border/80">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-right font-medium w-8">#</th>
                  <th className="px-3 py-2 text-left font-medium">Manager</th>
                  <th className="px-3 py-2 text-right font-medium">Players</th>
                  <th className="px-3 py-2 text-right font-medium">
                    <button
                      type="button"
                      onClick={() => handleSort("current")}
                      className="uppercase tracking-wider text-[10px] font-medium hover:text-foreground"
                    >
                      Current{arrow("current")}
                    </button>
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    <button
                      type="button"
                      onClick={() => handleSort("winProb")}
                      className="uppercase tracking-wider text-[10px] font-medium hover:text-foreground"
                      title={hasSim ? "" : "Run the simulator to populate"}
                    >
                      Win %{arrow("winProb")}
                    </button>
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    <button
                      type="button"
                      onClick={() => handleSort("projected")}
                      className="uppercase tracking-wider text-[10px] font-medium hover:text-foreground"
                    >
                      Proj Pts{arrow("projected")}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((row, idx) => (
                  <tr key={row.userId} className="border-t border-border/60">
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {idx + 1}
                    </td>
                    <td className="px-3 py-2 font-medium text-foreground">
                      {row.name}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {row.players}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium text-foreground">
                      {row.current > 0 ? row.current.toLocaleString() : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-foreground">
                      {row.winProbability != null ? (
                        `${(row.winProbability * 100).toFixed(1)}%`
                      ) : simLoading ? (
                        <span className="inline-block h-3 w-10 rounded bg-muted animate-pulse align-middle" />
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-foreground">
                      {Math.round(row.projected).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Roster Cards */}
      <Card>
        <CardHeader>
          <CardTitle>Rosters</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2">
          {rosterOrder.map((userId) => {
            const roster = rosterByUser.get(userId);
            if (!roster) return null;
            const current = roster.players.reduce(
              (s, p) => s + (livePoints[p.playerId] ?? 0),
              0,
            );
            return (
              <div
                key={roster.userId}
                className="rounded-xl border border-border/80 px-4 py-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-foreground">{roster.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {current > 0
                        ? `${current.toLocaleString()} pts · ${roster.totalPoints.toLocaleString()} projected`
                        : `${roster.totalPoints.toLocaleString()} projected pts`}
                    </p>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {roster.players.length} players
                  </p>
                </div>
                <div className="mt-4 space-y-2">
                  {roster.players.length ? (
                    [...roster.players]
                      .sort((a, b) => {
                        const la = livePoints[a.playerId] ?? 0;
                        const lb = livePoints[b.playerId] ?? 0;
                        if (la !== lb) return lb - la;
                        return b.totalPoints - a.totalPoints;
                      })
                      .map((player) => {
                        const live = livePoints[player.playerId] ?? 0;
                        return (
                          <div
                            key={player.playerId}
                            className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2 text-sm"
                          >
                            <div className="flex items-center gap-2">
                              <PlayerAvatar
                                espnId={player.playerId}
                                team={player.playerTeam}
                                size={28}
                              />
                              <div>
                                <p className="font-medium text-foreground">
                                  {player.playerName}
                                  {player.isAutoAssigned ? (
                                    <span className="ml-2 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-700">
                                      Auto
                                    </span>
                                  ) : null}
                                </p>
                                <p className="text-muted-foreground">
                                  {player.playerTeam}
                                </p>
                              </div>
                            </div>
                            <div className="text-right text-muted-foreground">
                              <p>${player.acquisitionBid}</p>
                              <p>
                                {live > 0 ? `${live} pts · ` : ""}
                                {player.totalPoints} proj
                              </p>
                            </div>
                          </div>
                        );
                      })
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No drafted players yet.
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

export function LeagueDetailView({
  leagueId,
  initialTab,
}: {
  leagueId: string;
  initialTab?: LeagueTab;
}) {
  const router = useRouter();
  const { data: session } = useSession();
  const viewerUserId = session?.user?.id ?? null;
  // Kick off the auto-sim as soon as the league loads so upcoming-game
  // projections (e.g. the live-ticker Key Scorers panel) can read simulator
  // output without waiting for the user to open the Simulator tab. Result is
  // cached in-module, so tabs that also call useAutoSim reuse it.
  const { simResults: leagueSimResults } = useAutoSim(leagueId);
  const [data, setData] = useState<LeagueDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [inviteEmails, setInviteEmails] = useState("");
  const [inviteError, setInviteError] = useState("");
  const [invitePending, setInvitePending] = useState(false);
  const [leagueName, setLeagueName] = useState("");
  const [rosterSize, setRosterSize] = useState("10");
  const [leagueIsPublic, setLeagueIsPublic] = useState(false);
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
  const [activeTab, setActiveTab] = useState<LeagueTab>(initialTab ?? "overview");
  const [showDraftedPlayers, setShowDraftedPlayers] = useState(false);
  const [showOnlySelected, setShowOnlySelected] = useState(false);
  const [showAddPlayers, setShowAddPlayers] = useState(false);
  const [addPlayerQuery, setAddPlayerQuery] = useState("");
  const [expandedManagerRoster, setExpandedManagerRoster] = useState<string | null>(null);
  const [historyMetric, setHistoryMetric] = useState<"pts" | "varp">("pts");
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
  const [undoStack, setUndoStack] = useState<Array<Record<string, string>>>([]);
  const [redoStack, setRedoStack] = useState<Array<Record<string, string>>>([]);
  // Mirror the stacks into refs so callbacks captured in async contexts
  // (e.g. the Sonner toast Undo button) can always read the latest state.
  const undoStackRef = useRef<Array<Record<string, string>>>([]);
  const redoStackRef = useRef<Array<Record<string, string>>>([]);
  const undoHandlerRef = useRef<() => void>(() => {});
  const [expandedHistoryRows, setExpandedHistoryRows] = useState<Set<string>>(
    () => new Set(),
  );
  const [removePlayerTarget, setRemovePlayerTarget] = useState<{
    playerId: string;
    playerName: string;
    ownerName: string;
    acquisitionBid: number;
  } | null>(null);
  const [removePlayerPending, setRemovePlayerPending] = useState(false);
  const dataRef = useRef<LeagueDetail | null>(null);
  const bidValuesRef = useRef<Record<string, string>>({});
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const submitAbortRef = useRef<AbortController | null>(null);
  const hasSubmittedOnceRef = useRef(false);
  // While the user types in a single field, we only want one snapshot for
  // that whole run of keystrokes. `lastContinuousBidField` tracks the field
  // the most recent snapshot is tied to; a new snapshot gets pushed when the
  // source changes (different field, or a discrete action like reset/0/bulk).
  const lastContinuousBidField = useRef<string | null>(null);

  // Pre-fetch the projections timeline the moment the league page mounts so
  // it's already in memory if/when the user switches to the Chart tab.
  // Cache is keyed by leagueId inside the hook, so members of multiple
  // leagues don't stomp on each other.
  const { projections: leagueProjections, refetch: refetchLeagueProjections } =
    useLeagueProjections(leagueId);

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
          setLeagueIsPublic(payload.league.isPublic);
          setSelectedPlayerIds([]);
          const initialBids = payload.currentRound
            ? Object.fromEntries(
                payload.currentRound.players
                  .filter((player) => player.myExplicitBid !== null)
                  .map((player) => [player.id, String(player.myExplicitBid)]),
              )
            : {};
          setBidValues(initialBids);
          bidValuesRef.current = initialBids;
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

  // Clean up any pending auto-save timer + in-flight submission on unmount.
  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
      }
      if (submitAbortRef.current) {
        submitAbortRef.current.abort();
      }
    };
  }, []);

  // A round change means the old undo/redo snapshots reference a different
  // set of player IDs and shouldn't be restorable.
  useEffect(() => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    lastContinuousBidField.current = null;
    setUndoStack([]);
    setRedoStack([]);
  }, [data?.currentRound?.id]);

  useEffect(() => {
    if (data?.league.phase) {
      const order = getLeagueTabOrder(
        data.league.phase,
        data.league.isCommissioner,
        data.league.isMember,
      );
      if (initialTab && order.includes(initialTab)) {
        setActiveTab(initialTab);
      } else {
        setActiveTab(order[0] ?? "overview");
      }
    }
  }, [leagueId, data?.league.phase, data?.league.isMember, initialTab]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        markUserActive();
        void loadLeague({ silent: true });
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadLeague]);

  usePolling(() => loadLeague({ silent: true }), {
    activeMs: POLL_INTERVAL_MS,
    idleMs: POLL_INACTIVE_TIMEOUT_MS,
  });

  // Build the projected-points ranking across the *full* league pool
  // (undrafted available players + everyone already on a roster). 173 rows
  // is cheap to sort locally and avoids a server round-trip for the UI.
  const projectionPool = useMemo(() => {
    if (!data) {
      return { rankById: new Map<string, number>(), replacementPts: 0 };
    }

    const entries: Array<{ id: string; totalPoints: number }> = [];
    const seen = new Set<string>();
    const push = (id: string, totalPoints: number | null | undefined) => {
      if (seen.has(id)) return;
      seen.add(id);
      entries.push({ id, totalPoints: totalPoints ?? 0 });
    };

    for (const player of data.availablePlayers) {
      push(player.id, player.totalPoints);
    }
    for (const roster of data.rosters) {
      for (const drafted of roster.players) {
        push(drafted.playerId, drafted.totalPoints);
      }
    }

    entries.sort((left, right) => right.totalPoints - left.totalPoints);

    const rankById = new Map<string, number>();
    entries.forEach((player, index) => {
      rankById.set(player.id, index + 1);
    });

    const draftPoolSize = Math.min(
      entries.length,
      data.members.length * data.league.rosterSize,
    );
    const replacement = entries[draftPoolSize] ?? entries[entries.length - 1];
    const replacementPts = Math.max(0, Math.round(replacement?.totalPoints ?? 0));

    return { rankById, replacementPts };
  }, [data]);

  // Build maps of userId → short name and fullName → short name for all members.
  const { shortNameById, shortNameByFull } = useMemo(() => {
    const byId = new Map<string, string>();
    const byFull = new Map<string, string>();
    if (!data) return { shortNameById: byId, shortNameByFull: byFull };
    const members = data.members.map((m) => ({
      userId: m.userId,
      full: m.name,
      first: m.name.split(/\s+/)[0] ?? m.name,
      last: m.name.split(/\s+/).slice(1).join(" "),
    }));
    // Try first names
    const firstCounts = new Map<string, number>();
    for (const m of members) firstCounts.set(m.first, (firstCounts.get(m.first) ?? 0) + 1);
    for (const m of members) {
      if (firstCounts.get(m.first) === 1) {
        byId.set(m.userId, m.first);
        byFull.set(m.full, m.first);
      }
    }
    // For collisions, add last name characters progressively
    const colliders = members.filter((m) => !byId.has(m.userId));
    if (colliders.length > 0) {
      const maxLast = Math.max(...colliders.map((m) => m.last.length));
      for (let len = 1; len <= maxLast; len++) {
        const remaining = colliders.filter((m) => !byId.has(m.userId));
        const abbrs = remaining.map((m) => ({
          ...m,
          short: m.last ? `${m.first} ${m.last.slice(0, len)}.` : m.first,
        }));
        const counts = new Map<string, number>();
        for (const a of abbrs) counts.set(a.short, (counts.get(a.short) ?? 0) + 1);
        for (const a of abbrs) {
          if (counts.get(a.short) === 1) {
            byId.set(a.userId, a.short);
            byFull.set(a.full, a.short);
          }
        }
      }
      // Fallback: full name
      for (const m of colliders) {
        if (!byId.has(m.userId)) {
          byId.set(m.userId, m.full);
          byFull.set(m.full, m.full);
        }
      }
    }
    return { shortNameById: byId, shortNameByFull: byFull };
  }, [data]);

  // Build map of rostered playerId → manager info for box-score highlighting.
  const rosteredPlayersMap = useMemo(() => {
    const map = new Map<string, RosteredPlayerInfo>();
    if (!data) return map;
    const memberById = new Map(data.members.map((m) => [m.userId, m.name] as const));
    for (const roster of data.rosters) {
      const managerName = memberById.get(roster.userId) ?? roster.name ?? "";
      const managerShortName = shortNameById.get(roster.userId) ?? managerName.split(/\s+/)[0] ?? managerName;
      const viewerIsManager = viewerUserId === roster.userId;
      for (const p of roster.players) {
        map.set(p.playerId, {
          managerName,
          managerShortName,
          managerUserId: roster.userId,
          viewerIsManager,
        });
      }
    }
    return map;
  }, [data, shortNameById, viewerUserId]);

  // Compute max allowed bid per user at each row in each resolved round.
  // maxAllowed is now provided per bid by the backend, which replays the
  // full action log (including commissioner removes/adds/adjustments).

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

        if (showOnlySelected && !selectedPlayerIds.includes(player.id)) {
          return false;
        }

        return true;
      }),
      draftSort,
    );
  }, [data, draftConferenceFilter, draftQuery, draftSeedFilter, draftSort, draftTeamFilter, showOnlySelected, selectedPlayerIds]);

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

      if (data.currentRound.myMaxBid > 0 && bid > data.currentRound.myMaxBid) {
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
        isPublic?: boolean;
      } = {
        name: leagueName,
        isPublic: leagueIsPublic,
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

  async function submitBids({ silent = false }: { silent?: boolean } = {}) {
    const round = data?.currentRound;
    if (!round || !viewerUserId) {
      return;
    }

    // Cancel any pending debounce — we're firing right now.
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }

    if (invalidBidMessage) {
      // Don't silently post invalid bids; wait for the user to fix them.
      setSubmitError(invalidBidMessage);
      return;
    }

    // Abort any in-flight submission — its result is stale now that a
    // newer save is going out. The previous caller will see AbortError
    // and no-op in its catch branch.
    if (submitAbortRef.current) {
      submitAbortRef.current.abort();
    }
    const controller = new AbortController();
    submitAbortRef.current = controller;

    setSubmitPending(true);
    setSubmitError("");

    try {
      const bids = Object.fromEntries(
        Object.entries(bidValuesRef.current)
          .filter(([, value]) => value.trim())
          .map(([playerId, value]) => [playerId, Number(value)]),
      );

      await appApiFetch(
        `/leagues/${leagueId}/draft/rounds/${round.id}/submission`,
        {
          method: "POST",
          body: JSON.stringify({ bids }),
          signal: controller.signal,
        },
      );

      hasSubmittedOnceRef.current = true;

      // Optimistically mark our own submission row as submitted so the UI
      // updates instantly. Polling will reconcile if anything drifts.
      const submittedAtIso = new Date().toISOString();
      setData((current) => {
        if (!current?.currentRound) return current;
        const updated = {
          ...current,
          currentRound: {
            ...current.currentRound,
            submissionStatuses: current.currentRound.submissionStatuses.map((status) =>
              status.userId === viewerUserId
                ? { ...status, submittedAt: submittedAtIso }
                : status,
            ),
          },
        };
        dataRef.current = updated;
        return updated;
      });

      // No shared id: each save gets its own toast so rapid successive
      // edits visibly stack, with the older one sliding behind the new one.
      toast.success("Bids saved", {
        duration: 5000,
        action: {
          label: "Undo",
          onClick: () => undoHandlerRef.current(),
        },
      });
    } catch (submitBidsError) {
      if ((submitBidsError as { name?: string })?.name === "AbortError") {
        // Superseded by a newer save; leave UI state to that call.
        return;
      }
      setSubmitError(
        submitBidsError instanceof Error
          ? submitBidsError.message
          : "Failed to submit bids",
      );
      if (silent) {
        toast.error("Failed to save bids");
      }
    } finally {
      if (submitAbortRef.current === controller) {
        setSubmitPending(false);
        submitAbortRef.current = null;
      }
    }
  }

  function scheduleAutoSaveBids() {
    // Only auto-save after the user has submitted at least once.
    // Check server data for prior submission, or the local flag.
    const viewerSubmission = data?.currentRound?.submissionStatuses.find(
      (s) => s.userId === viewerUserId,
    );
    if (!hasSubmittedOnceRef.current && !viewerSubmission?.submittedAt) {
      return; // don't auto-save before first manual submit
    }

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }
    autoSaveTimerRef.current = setTimeout(() => {
      autoSaveTimerRef.current = null;
      void submitBids({ silent: true });
    }, 600);
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

  async function removePlayerFromRoster() {
    if (!removePlayerTarget) return;
    setRemovePlayerPending(true);
    try {
      await appApiFetch(
        `/leagues/${leagueId}/roster/${removePlayerTarget.playerId}/remove`,
        { method: "POST" },
      );
      toast.success(
        `Removed ${removePlayerTarget.playerName} and refunded $${removePlayerTarget.acquisitionBid} to ${removePlayerTarget.ownerName}`,
      );
      await loadLeague();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove player");
    } finally {
      setRemovePlayerPending(false);
      setRemovePlayerTarget(null);
    }
  }

  // Push the current bidValues onto the undo stack. This is for *user-driven*
  // mutations (typing, reset, $0, bulk) — it also clears the redo stack,
  // since the user has branched away from whatever redo timeline existed.
  // Push the current bidValues onto the undo stack. For user-driven
  // mutations only — also clears the redo stack since the user has
  // branched away from whatever redo timeline existed. Writes to both the
  // ref and state so stale-captured callbacks (e.g. a toast Undo button
  // fired from an older render) can still read the latest stack.
  function pushUndoSnapshot() {
    const snapshot = { ...bidValuesRef.current };
    const nextUndo = [...undoStackRef.current, snapshot];
    undoStackRef.current = nextUndo;
    redoStackRef.current = [];
    setUndoStack(nextUndo);
    setRedoStack([]);
  }

  function setBidValue(
    playerId: string,
    value: string,
    options?: { discrete?: boolean },
  ) {
    // Discrete actions ($0 button, reset, bulk, undo) always push a new
    // snapshot. Continuous typing in the same field reuses the snapshot
    // already on top of the stack so we don't flood it with per-keystroke
    // entries.
    const isDiscrete = options?.discrete === true;
    const shouldPush =
      isDiscrete || lastContinuousBidField.current !== playerId;
    if (shouldPush) {
      pushUndoSnapshot();
    }
    lastContinuousBidField.current = isDiscrete ? null : playerId;

    setBidValues((current) => {
      const next = { ...current, [playerId]: sanitizeBidInput(value) };
      bidValuesRef.current = next;
      return next;
    });
    scheduleAutoSaveBids();
  }

  function resetBidValue(playerId: string) {
    pushUndoSnapshot();
    lastContinuousBidField.current = null;
    setBidValues((current) => {
      const next = { ...current };
      delete next[playerId];
      bidValuesRef.current = next;
      return next;
    });
    scheduleAutoSaveBids();
  }

  function applyBulkBids(mode: "suggested" | "zero" | "clear") {
    if (!data?.currentRound) return;
    const players = data.currentRound.players;
    pushUndoSnapshot();
    lastContinuousBidField.current = null;
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
      bidValuesRef.current = next;
      return next;
    });
    scheduleAutoSaveBids();
  }

  function undoLastBidChange() {
    const stack = undoStackRef.current;
    if (!stack.length) return;
    const restored = stack[stack.length - 1];
    const currentSnapshot = { ...bidValuesRef.current };

    const nextUndo = stack.slice(0, -1);
    const nextRedo = [...redoStackRef.current, currentSnapshot];
    undoStackRef.current = nextUndo;
    redoStackRef.current = nextRedo;
    bidValuesRef.current = restored;
    lastContinuousBidField.current = null;

    setBidValues(restored);
    setUndoStack(nextUndo);
    setRedoStack(nextRedo);
    scheduleAutoSaveBids();
  }

  function redoLastBidChange() {
    const stack = redoStackRef.current;
    if (!stack.length) return;
    const restored = stack[stack.length - 1];
    const currentSnapshot = { ...bidValuesRef.current };

    const nextRedo = stack.slice(0, -1);
    const nextUndo = [...undoStackRef.current, currentSnapshot];
    redoStackRef.current = nextRedo;
    undoStackRef.current = nextUndo;
    bidValuesRef.current = restored;
    lastContinuousBidField.current = null;

    setBidValues(restored);
    setRedoStack(nextRedo);
    setUndoStack(nextUndo);
    scheduleAutoSaveBids();
  }

  // Keep undoHandlerRef pointed at the latest undo function so a toast
  // button fired from an older render closure still runs current logic.
  undoHandlerRef.current = undoLastBidChange;

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
      <main className="mx-auto flex w-full max-w-[96rem] flex-col gap-6 px-4 py-10 sm:px-6 lg:px-8">
        <section className="space-y-2">
          <div className="h-3 w-24 animate-pulse rounded bg-muted" />
          <div className="h-9 w-72 animate-pulse rounded bg-muted" />
          <div className="flex gap-3">
            <div className="h-4 w-24 animate-pulse rounded bg-muted" />
            <div className="h-4 w-28 animate-pulse rounded bg-muted" />
            <div className="h-4 w-32 animate-pulse rounded bg-muted" />
          </div>
        </section>
        <div className="flex flex-wrap gap-2">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-9 w-24 animate-pulse rounded bg-muted" />
          ))}
        </div>
        <section className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <Card>
            <CardHeader>
              <div className="h-5 w-40 animate-pulse rounded bg-muted" />
              <div className="h-4 w-64 animate-pulse rounded bg-muted" />
            </CardHeader>
            <CardContent className="space-y-3">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-4 py-2">
                  <div className="h-10 w-10 animate-pulse rounded-full bg-muted" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-32 animate-pulse rounded bg-muted" />
                    <div className="h-3 w-24 animate-pulse rounded bg-muted" />
                  </div>
                  <div className="h-4 w-16 animate-pulse rounded bg-muted" />
                </div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <div className="h-5 w-36 animate-pulse rounded bg-muted" />
              <div className="h-4 w-56 animate-pulse rounded bg-muted" />
            </CardHeader>
            <CardContent>
              <div className="h-48 w-full animate-pulse rounded bg-muted" />
            </CardContent>
          </Card>
        </section>
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
    <main className="mx-auto flex w-full max-w-[96rem] flex-col gap-4 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <button
          type="button"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => startTransition(() => router.push("/"))}
        >
          ←
        </button>
        <h1 className="text-lg font-semibold tracking-tight text-foreground">
          {data.league.name}
        </h1>
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {PHASE_LABELS[data.league.phase] ?? data.league.phase}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
          <span>{data.members.length} managers · {data.availablePlayers.length} players · {Math.max(0, data.members.length * data.league.rosterSize - data.rosters.reduce((sum, r) => sum + r.players.length, 0))} picks left</span>
          <span>Roster <span className="font-medium text-foreground">{data.league.rosterSize}</span> · Budget <span className="font-medium text-foreground">${data.league.budgetPerTeam}</span> · Min <span className="font-medium text-foreground">${data.league.minBid}</span></span>
          {data.currentRound ? (
            <span>Round <span className="font-medium text-foreground">{data.currentRound.roundNumber}</span> · Max bid <span className="font-medium text-foreground">${data.currentRound.myMaxBid}</span></span>
          ) : null}
        </div>
      </div>

      {error ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <LiveGamesTicker
        rosteredPlayers={rosteredPlayersMap}
        leagueId={data.league.id}
        rosters={data.rosters.map((r) => ({
          userId: r.userId,
          name: r.name,
          players: r.players.map((p) => ({
            playerId: p.playerId,
            playerName: p.playerName,
            playerTeam: p.playerTeam,
          })),
        }))}
        livePoints={data.livePoints ?? {}}
        simPlayerProjections={
          leagueSimResults
            ? Object.fromEntries(
                leagueSimResults.players.map((p) => [
                  p.espnId,
                  {
                    byGamePts: p.projectedPointsByGame,
                    byGameProb: p.projectedGamesByGame,
                    avgPpg:
                      p.projectedGames > 0
                        ? p.projectedPoints / p.projectedGames
                        : p.ppg,
                  },
                ]),
              )
            : undefined
        }
      />

      <section className="rounded-2xl border border-border/80 bg-background/90 p-2">
        <div className="flex flex-nowrap gap-1 overflow-x-auto sm:gap-2">
          {getLeagueTabOrder(data.league.phase, data.league.isCommissioner, data.league.isMember).map((tabId) => {
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
                  <div className="flex items-start gap-3 rounded-lg border border-border/80 bg-muted/40 px-3 py-3">
                    <input
                      id="league-public-settings"
                      type="checkbox"
                      checked={leagueIsPublic}
                      onChange={(event) => setLeagueIsPublic(event.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary"
                    />
                    <div className="space-y-1">
                      <Label htmlFor="league-public-settings" className="cursor-pointer">
                        Public league
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Anyone with the link can view standings, chart, simulator, and reveal. Other tabs stay private to members.
                      </p>
                    </div>
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
                    <span>{typeof member.totalPoints === "number" ? member.totalPoints.toFixed(1) : member.totalPoints} proj. pts</span>
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
            <p className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
              <span className="font-semibold uppercase tracking-wide text-muted-foreground">
                Replacement
              </span>
              <span className="text-foreground tabular-nums">
                {projectionPool.replacementPts}
              </span>
              projected pts — the first player outside a full draft pool.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={showDraftedPlayers}
                onChange={(e) => setShowDraftedPlayers(e.target.checked)}
                className="rounded"
              />
              Show drafted players
            </label>
            <div className="overflow-auto rounded-xl border border-border/80">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/60 text-xs tracking-[0.18em] text-muted-foreground uppercase">
                  <tr>
                    <th className="px-3 py-3 text-right font-medium">#</th>
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
                    {showDraftedPlayers ? <th className="px-3 py-3 text-left font-medium">Owner</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {(data.allPlayers ?? data.availablePlayers.map((p) => ({ ...p, draftedBy: null })))
                    .filter((player) => showDraftedPlayers || !player.draftedBy)
                    .sort((a, b) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0))
                    .map((player) => {
                      const drafted = player.draftedBy;
                      return (
                        <tr
                          key={player.id}
                          className={[
                            "border-t border-border/70",
                            drafted ? "bg-muted/10" : "",
                          ].join(" ")}
                        >
                          <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                            {projectionPool.rankById.get(player.id) ?? "—"}
                          </td>
                          <td className="px-3 py-3 font-medium text-foreground">
                            <div className={`flex items-center gap-2 ${drafted ? "opacity-60" : ""}`}>
                              <PlayerAvatar espnId={player.id} team={player.team} size={28} />
                              {player.name}<InjuryBadge status={player.injuryStatus} />
                            </div>
                          </td>
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
                          {showDraftedPlayers ? (
                            <td className="px-3 py-3 text-sm text-muted-foreground">
                              {drafted ? (
                                <span>
                                  <span className="font-medium">{drafted.name}</span>
                                  <span className="ml-1 tabular-nums">${drafted.acquisitionBid}</span>
                                </span>
                              ) : "—"}
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
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

      {activeTab === "draft" && data.auctionState && viewerUserId ? (
        <AuctionDraftPanel
          leagueId={leagueId}
          data={data}
          viewerUserId={viewerUserId}
          onRefresh={() => loadLeague({ silent: true })}
        />
      ) : null}

      {activeTab === "draft" && data.snakeState && viewerUserId ? (
        <SnakeDraftPanel
          leagueId={leagueId}
          data={data}
          viewerUserId={viewerUserId}
          onRefresh={() => loadLeague({ silent: true })}
        />
      ) : null}

      {activeTab === "draft" && !data.auctionState && !data.snakeState ? (
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
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  <span>Format: {data.currentRound.eligiblePlayerMode.replace("_", " ")}</span>
                  <span>Max bid: ${data.currentRound.myMaxBid}</span>
                  <span>
                    Deadline:
                    {" "}
                    {data.currentRound.deadlineAt
                      ? new Date(data.currentRound.deadlineAt).toLocaleString()
                      : "None"}
                  </span>
                  <span>
                    Replacement pts:{" "}
                    <span className="tabular-nums font-medium text-foreground">
                      {projectionPool.replacementPts}
                    </span>
                  </span>
                </div>

                <div className="space-y-4">
                  <div>
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium text-foreground">Submission Status</p>
                      <div className="flex items-center gap-3">
                        {data.league.isCommissioner ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => { setShowAddPlayers(true); setAddPlayerQuery(""); }}
                            className="h-7 text-xs"
                          >
                            + Add Players
                          </Button>
                        ) : null}
                      <p className="text-xs text-muted-foreground">
                        {
                          data.currentRound.submissionStatuses.filter((s) => s.submittedAt)
                            .length
                        }{" "}
                        / {data.currentRound.submissionStatuses.length} submitted
                      </p>
                      </div>
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                      {[...data.currentRound.submissionStatuses]
                        .sort((a, b) => {
                          const aRoster = data.rosters.find((r) => r.userId === a.userId);
                          const bRoster = data.rosters.find((r) => r.userId === b.userId);
                          const aFull = (aRoster?.players.length ?? 0) >= data.league.rosterSize ? 1 : 0;
                          const bFull = (bRoster?.players.length ?? 0) >= data.league.rosterSize ? 1 : 0;
                          if (aFull !== bFull) return aFull - bFull;
                          const aBudget = data.members.find((m) => m.userId === a.userId)?.remainingBudget ?? 0;
                          const bBudget = data.members.find((m) => m.userId === b.userId)?.remainingBudget ?? 0;
                          return bBudget - aBudget;
                        })
                        .map((submission) => {
                        const submitted = Boolean(submission.submittedAt);
                        const member = data.members.find((m) => m.userId === submission.userId);
                        const roster = data.rosters.find((r) => r.userId === submission.userId);
                        const rosterFull = (roster?.players.length ?? 0) >= data.league.rosterSize;
                        const priority = data.priorityOrder.find((p) => p.userId === submission.userId);
                        return (
                          <div
                            key={submission.userId}
                            className="group relative"
                          >
                            <div
                              className={[
                                "flex flex-col gap-1 rounded-lg border px-3 py-2 text-sm transition-colors md:cursor-default cursor-pointer",
                                rosterFull
                                  ? "border-border/40 bg-muted/30 opacity-50"
                                  : submitted
                                    ? "border-emerald-500/40 bg-emerald-500/10 text-foreground"
                                    : "border-border/70 bg-background",
                                expandedManagerRoster === submission.userId ? "md:rounded-lg rounded-b-none" : "",
                              ].join(" ")}
                              onClick={() => setExpandedManagerRoster(
                                expandedManagerRoster === submission.userId ? null : submission.userId,
                              )}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="flex min-w-0 items-center gap-2">
                                  <span
                                    aria-hidden
                                    className={[
                                      "inline-flex h-1.5 w-1.5 shrink-0 rounded-full",
                                      rosterFull
                                        ? "bg-muted-foreground/40"
                                        : submitted
                                          ? "bg-emerald-500"
                                          : "animate-pulse bg-amber-500",
                                    ].join(" ")}
                                  />
                                  <span className={`truncate${rosterFull ? " text-muted-foreground" : ""}`}>{submission.name}</span>
                                </span>
                                <span className="flex items-center gap-2 shrink-0 text-[11px] tabular-nums text-muted-foreground">
                                  <span>${member?.remainingBudget ?? "?"}</span>
                                  <span>{roster?.players.length ?? 0}/{data.league.rosterSize}</span>
                                </span>
                              </div>
                              <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                                <span>
                                  Tiebreak #{priority?.draftPriority ?? "?"}
                                </span>
                                <span>
                                  {rosterFull
                                    ? "Roster full"
                                    : submitted
                                      ? formatRelativeTime(submission.submittedAt!)
                                      : "Waiting"}
                                </span>
                              </div>
                            </div>
                            {/* Desktop: hover popup */}
                            {roster && roster.players.length > 0 && (
                              <div className="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden w-64 rounded-lg border border-border bg-popover p-2 shadow-lg md:group-hover:pointer-events-auto md:group-hover:block">
                                <div className="space-y-1">
                                  {roster.players
                                    .slice()
                                    .sort((a, b) => b.totalPoints - a.totalPoints)
                                    .map((p) => (
                                      <div key={p.playerId} className="flex items-center gap-2 rounded px-2 py-1 text-xs">
                                        <PlayerAvatar espnId={p.playerId} team={p.playerTeam} size={20} />
                                        <span className="truncate font-medium">{p.playerName}</span>
                                        <span className="ml-auto tabular-nums text-muted-foreground">${p.acquisitionBid}</span>
                                      </div>
                                    ))}
                                </div>
                              </div>
                            )}
                            {/* Mobile: click to expand inline */}
                            {expandedManagerRoster === submission.userId && roster && roster.players.length > 0 && (
                              <div className="md:hidden rounded-b-lg border border-t-0 border-border/70 bg-muted/20 px-3 py-2 space-y-1">
                                {roster.players
                                  .slice()
                                  .sort((a, b) => b.totalPoints - a.totalPoints)
                                  .map((p) => (
                                    <div key={p.playerId} className="flex items-center gap-2 rounded px-1 py-1 text-xs">
                                      <PlayerAvatar espnId={p.playerId} team={p.playerTeam} size={20} />
                                      <span className="truncate font-medium">{p.playerName}</span>
                                      <span className="ml-auto tabular-nums text-muted-foreground">${p.acquisitionBid}</span>
                                    </div>
                                  ))}
                              </div>
                            )}
                            {expandedManagerRoster === submission.userId && roster && roster.players.length === 0 && (
                              <div className="md:hidden rounded-b-lg border border-t-0 border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                                No drafted players yet.
                              </div>
                            )}
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

                    <div className="flex flex-wrap items-center gap-2 border-y border-border/60 bg-muted/20 px-3 py-2 -mx-3 sm:mx-0 sm:rounded-lg sm:border">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Quick:
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
                      <div className="ml-auto flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={undoLastBidChange}
                          disabled={undoStack.length === 0}
                          title="Undo last bid change"
                          aria-label="Undo last bid change"
                        >
                          ↶ Undo
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={redoLastBidChange}
                          disabled={redoStack.length === 0}
                          title="Redo last undone change"
                          aria-label="Redo last undone change"
                        >
                          Redo ↷
                        </Button>
                      </div>
                    </div>
                    <div className="flex flex-col gap-3 md:hidden">
                      {filteredBidPlayers.map((player) => (
                        <div
                          key={player.id}
                          className="overflow-hidden rounded-2xl border border-border/80 bg-card shadow-sm"
                        >
                          <div className="px-4 pt-4">
                            <div className="flex items-center justify-between gap-3">
                              <div className="flex items-center gap-2 min-w-0">
                                <PlayerAvatar espnId={player.id} team={player.team} size={28} />
                                <p className="truncate text-base font-semibold text-foreground">
                                  {player.name}<InjuryBadge status={player.injuryStatus} />
                                </p>
                              </div>
                              <p className="shrink-0 text-base font-bold tabular-nums text-foreground">
                                ${player.suggestedValue}
                              </p>
                            </div>
                            <div className="mt-0.5 flex items-baseline justify-between gap-3">
                              <p className="min-w-0 truncate text-xs text-muted-foreground">
                                {player.team} ·{" "}
                                {formatConferenceSeed(player.conference, player.seed)} ·
                                Proj{" "}
                                {player.totalPoints !== null
                                  ? Math.round(player.totalPoints)
                                  : "—"}{" "}
                                pts
                              </p>
                              <p className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
                                Suggested
                              </p>
                            </div>
                          </div>
                          <div className="mt-3 flex items-center gap-1 border-t border-border/60 bg-muted/30 px-3 py-3">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => resetBidValue(player.id)}
                              aria-label={`Reset bid for ${player.name}`}
                              title="Reset to default"
                            >
                              <RefreshIcon className="size-3.5" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => setBidValue(player.id, "0", { discrete: true })}
                              title="Pass (bid $0)"
                              aria-label={`Pass on ${player.name}`}
                              className="px-1 text-xs font-semibold tabular-nums"
                            >
                              $0
                            </Button>
                            <div className="relative ml-auto w-28">
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
                            <th className="px-3 py-3 text-right font-medium">Proj. Pts</th>
                            <th className="px-3 py-3 text-right font-medium">Proj. GP</th>
                            <th className="px-3 py-3 text-right font-medium">Your Bid</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredBidPlayers.map((player) => (
                            <tr key={player.id} className="border-t border-border/70">
                              <td className="px-3 py-3 font-medium text-foreground">
                                <div className="flex items-center gap-2">
                                  <PlayerAvatar espnId={player.id} team={player.team} size={28} />
                                  {player.name}<InjuryBadge status={player.injuryStatus} />
                                </div>
                              </td>
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
                                    variant="ghost"
                                    size="icon-xs"
                                    onClick={() => setBidValue(player.id, "0", { discrete: true })}
                                    title="Pass (bid $0)"
                                    aria-label={`Pass on ${player.name}`}
                                    className="px-1.5 text-[11px] font-semibold tabular-nums"
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
                    <div className="flex flex-col gap-3 md:flex-row md:justify-end md:gap-3">
                      <Button
                        onClick={() => void submitBids()}
                        disabled={submitPending}
                        className="h-12 w-full text-base md:h-9 md:w-auto md:text-sm"
                      >
                        {submitPending ? "Saving..." : "Submit Bids"}
                      </Button>
                      {data.league.isCommissioner ? (
                        <>
                        <Button
                          variant="outline"
                          onClick={() => setShowCloseConfirm(true)}
                          disabled={closePending}
                          className="h-12 w-full text-base md:h-9 md:w-auto md:text-sm"
                        >
                          {closePending ? "Closing..." : "Close Round and Reveal"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => { setShowAddPlayers(true); setAddPlayerQuery(""); }}
                          className="text-xs"
                        >
                          + Add Players to Round
                        </Button>
                        </>
                      ) : null}
                    </div>
                    {/* Add Players Modal */}
                    {showAddPlayers && data.league.isCommissioner && data.currentRound ? (
                      <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-16" onClick={() => setShowAddPlayers(false)}>
                        <div className="bg-background border rounded-lg shadow-lg w-full max-w-lg mx-4 max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-between px-4 py-3 border-b">
                            <div>
                              <p className="font-semibold text-sm">Add Players to Round {data.currentRound.roundNumber}</p>
                              <p className="text-xs text-muted-foreground">
                                {(() => {
                                  const inRound = new Set(data.currentRound!.players.map((rp) => rp.id));
                                  return data.availablePlayers.filter((p) => !inRound.has(p.id)).length;
                                })()} players not in this round
                              </p>
                            </div>
                            <button onClick={() => setShowAddPlayers(false)} className="text-muted-foreground hover:text-foreground text-lg px-2">&times;</button>
                          </div>
                          <div className="px-4 py-2 border-b">
                            <Input
                              placeholder="Search players..."
                              value={addPlayerQuery}
                              onChange={(e) => setAddPlayerQuery(e.target.value)}
                              className="h-8 text-sm"
                              autoFocus
                            />
                          </div>
                          <div className="flex-1 overflow-y-auto px-4 py-2 space-y-1">
                            {(() => {
                              const inRound = new Set(data.currentRound!.players.map((rp) => rp.id));
                              const q = addPlayerQuery.trim().toLowerCase();
                              return data.availablePlayers
                                .filter((p) => {
                                  if (inRound.has(p.id)) return false;
                                  if (q && ![p.name, p.team].join(" ").toLowerCase().includes(q)) return false;
                                  return true;
                                })
                                .sort((a, b) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0))
                                .slice(0, 50)
                                .map((p) => (
                                  <div key={p.id} className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/50">
                                    <div className="flex items-center gap-2 min-w-0">
                                      <PlayerAvatar espnId={p.id} team={p.team} size={24} />
                                      <span className="truncate font-medium">{p.name}</span>
                                      <span className="text-xs text-muted-foreground">{p.team}</span>
                                      <InjuryBadge status={p.injuryStatus} />
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                      <span className="text-xs tabular-nums text-muted-foreground">${p.suggestedValue}</span>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-6 text-xs"
                                        onClick={async () => {
                                          try {
                                            await appApiFetch(
                                              `/leagues/${leagueId}/draft/rounds/${data.currentRound!.id}/add-players`,
                                              { method: "POST", body: JSON.stringify({ playerIds: [p.id] }) },
                                            );
                                            toast.success(`Added ${p.name}`);
                                            void loadLeague();
                                          } catch (err) {
                                            toast.error(err instanceof Error ? err.message : "Failed to add player");
                                          }
                                        }}
                                      >
                                        Add
                                      </Button>
                                    </div>
                                  </div>
                                ));
                            })()}
                          </div>
                        </div>
                      </div>
                    ) : null}
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
                              <Label>Teams</Label>
                              <div className="max-h-48 overflow-y-auto rounded-lg border border-border px-1 py-1">
                                {(() => {
                                  const teamSet = new Map<string, { conf: string; seed: number | null; count: number }>();
                                  for (const p of data.availablePlayers) {
                                    const existing = teamSet.get(p.team);
                                    if (existing) { existing.count++; }
                                    else { teamSet.set(p.team, { conf: p.conference, seed: p.seed, count: 1 }); }
                                  }
                                  const selectedTeams = new Set(parseTeamsInput(presetTeams));
                                  return [...teamSet.entries()]
                                    .sort((a, b) => {
                                      const confCmp = a[1].conf.localeCompare(b[1].conf);
                                      if (confCmp !== 0) return confCmp;
                                      return (a[1].seed ?? 99) - (b[1].seed ?? 99);
                                    })
                                    .map(([team, info]) => (
                                      <label
                                        key={team}
                                        className="flex items-center gap-2 rounded px-2 py-1 text-sm cursor-pointer hover:bg-muted/50"
                                      >
                                        <input
                                          type="checkbox"
                                          className="rounded"
                                          checked={selectedTeams.has(team.toUpperCase())}
                                          onChange={(e) => {
                                            const current = parseTeamsInput(presetTeams);
                                            const upper = team.toUpperCase();
                                            if (e.target.checked) {
                                              setPresetTeams([...current, upper].join(", "));
                                            } else {
                                              setPresetTeams(current.filter((t) => t !== upper).join(", "));
                                            }
                                          }}
                                        />
                                        <span className="font-medium">{team}</span>
                                        <span className="text-xs text-muted-foreground">
                                          {info.conf} {info.seed ? `#${info.seed}` : ""} · {info.count} players
                                        </span>
                                      </label>
                                    ));
                                })()}
                              </div>
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

                      <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
                        <span>{selectedPlayerIds.length} selected</span>
                        <span>{filteredAvailablePlayers.length} visible</span>
                        <span>{data.availablePlayers.length} total remaining</span>
                        <label className="flex items-center gap-1.5 cursor-pointer ml-auto">
                          <input
                            type="checkbox"
                            checked={showOnlySelected}
                            onChange={(e) => setShowOnlySelected(e.target.checked)}
                            className="rounded"
                          />
                          Show only selected
                        </label>
                      </div>

                      {/* Mobile: Open Round button above player list */}
                      <div className="md:hidden">
                        {openRoundError ? (
                          <p className="text-sm text-destructive mb-2">{openRoundError}</p>
                        ) : null}
                        <Button type="submit" disabled={openRoundPending} className="w-full">
                          {openRoundPending ? "Opening..." : `Open Round (${selectedPlayerIds.length} players)`}
                        </Button>
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
                                  <div className="flex items-center gap-2">
                                    <PlayerAvatar espnId={player.id} team={player.team} size={28} />
                                    <div>
                                      <p className="font-medium text-foreground">{player.name}</p>
                                      <p className="text-sm text-muted-foreground">
                                        {player.team} · {player.conference} · Seed {player.seed ?? "-"}
                                      </p>
                                    </div>
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
                                  <td className="px-3 py-3 font-medium text-foreground">
                                    <div className="flex items-center gap-2">
                                      <PlayerAvatar espnId={player.id} team={player.team} size={28} />
                                      {player.name}<InjuryBadge status={player.injuryStatus} />
                                    </div>
                                  </td>
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
                    : "The commissioner has not started a draft yet. Check the Commissioner tab to start a sealed-bid round, live auction, or snake draft."}
                </p>
              </CardContent>
            </Card>
          )}
        </>
      ) : null}

      {activeTab === "reveal" ? (
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
            <CardContent>
              {data.lastResolvedRound ? (
                data.lastResolvedRound.results.length ? (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {data.lastResolvedRound.results.map((result) => {
                      const note = result.isAutoAssigned
                        ? "auto-assigned"
                        : result.wonByTiebreak
                          ? "tiebreak"
                          : null;
                      return (
                        <div
                          key={result.playerId}
                          className="flex items-center gap-3 rounded-xl border border-border/60 bg-muted/10 px-3 py-2.5"
                        >
                          <PlayerAvatar espnId={result.playerId} team={result.playerTeam} size={40} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-foreground">
                              {result.playerName}
                            </p>
                            <p className="text-[11px] tabular-nums text-muted-foreground">
                              {result.playerTeam} · ${result.suggestedValue}
                              {result.totalPoints != null ? ` · ${result.totalPoints.toFixed(0)} pts` : ""}
                            </p>
                            <div className="mt-0.5 flex items-center gap-1.5">
                              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-200">
                                👑 {result.winnerName} · ${result.winningBid}
                              </span>
                              {note ? (
                                <span className="text-[10px] text-muted-foreground">{note}</span>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
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
                                    {row.playerTeam} · ${row.suggestedValue}
                                    {row.totalPoints != null ? ` · ${row.totalPoints.toFixed(0)} pts` : ""}
                                  </p>
                                </div>
                                <div className="flex flex-wrap items-center gap-1.5">
                                  {row.winnerName ? (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-200">
                                    <span aria-hidden>👑</span>
                                    {row.winnerName}
                                    {row.winningBid !== null ? (
                                      <span className="tabular-nums">
                                        · $
                                        {row.winningBid}
                                      </span>
                                    ) : null}
                                  </span>
                                  ) : (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                                    Undrafted — returned to pool
                                  </span>
                                  )}
                                  {row.runnerUpName ? (
                                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-400/10 dark:text-amber-200">
                                      2nd · {shortenNames(row.runnerUpName, shortNameByFull)}
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
                                          {bid.isAutoDefault && bid.amount != null && bid.amount > 0 ? (
                                            <span className="ml-1 text-[9px] font-normal text-muted-foreground/60">auto</span>
                                          ) : null}
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
                              <th
                                className="cursor-pointer select-none px-2 py-2 text-right font-medium hover:text-foreground"
                                onClick={() => setHistoryMetric((m) => m === "pts" ? "varp" : "pts")}
                                title="Click to toggle"
                              >
                                {historyMetric === "pts" ? "Pts/$" : "VARP/$"}
                              </th>
                              {round.participants.map((participant, pIdx) => {
                                const first = participant.name.split(" ")[0] ?? participant.name;
                                const isLast = pIdx === round.participants.length - 1;
                                return (
                                  <th
                                    key={participant.userId}
                                    className={`px-2 py-2 text-right font-medium${isLast ? " pr-3" : ""}`}
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
                                      {row.totalPoints != null ? ` · ${row.totalPoints.toFixed(0)} pts` : ""}
                                    </div>
                                  </td>
                                  <td className="px-3 py-3 align-middle">
                                    {row.winnerName ? (
                                    <div className="inline-flex min-w-[8rem] flex-col rounded-lg bg-emerald-500/15 px-3 py-1.5 dark:bg-emerald-400/10">
                                      <span className="text-sm font-semibold text-emerald-900 dark:text-emerald-100">
                                        {row.winnerName}
                                      </span>
                                      <span className="text-xs tabular-nums text-emerald-700 dark:text-emerald-300">
                                        {row.winningBid !== null ? `$${row.winningBid}` : "—"}
                                      </span>
                                    </div>
                                    ) : (
                                    <div className="inline-flex min-w-[8rem] flex-col rounded-lg bg-muted/40 px-3 py-1.5">
                                      <span className="text-sm font-medium text-muted-foreground">Undrafted</span>
                                      <span className="text-[10px] text-muted-foreground/70">Returned to pool</span>
                                    </div>
                                    )}
                                  </td>
                                  <td className="px-3 py-3 align-middle">
                                    {row.runnerUpName ? (
                                    <div className="inline-flex min-w-[8rem] flex-col rounded-lg bg-amber-500/10 px-3 py-1.5 dark:bg-amber-400/10">
                                      <span className="text-sm font-semibold text-amber-900 dark:text-amber-100" title={row.runnerUpName}>
                                        {shortenNames(row.runnerUpName, shortNameByFull)}
                                      </span>
                                      <span className="text-xs tabular-nums text-amber-700 dark:text-amber-300">
                                        {row.runnerUpBid === null
                                          ? "—"
                                          : row.runnerUpBid === 0
                                            ? "Pass"
                                            : `$${row.runnerUpBid}`}
                                      </span>
                                    </div>
                                    ) : (
                                    <div className="inline-flex min-w-[8rem] flex-col rounded-lg bg-muted/20 px-3 py-1.5">
                                      <span className="text-sm text-muted-foreground/50">—</span>
                                    </div>
                                    )}
                                  </td>
                                  {(() => {
                                    const pts = row.totalPoints ?? 0;
                                    const bid = row.winningBid ?? 0;
                                    const hasBid = row.winnerName && bid > 0;
                                    const val = hasBid
                                      ? historyMetric === "pts"
                                        ? pts / bid
                                        : Math.max(0, pts - projectionPool.replacementPts) / bid
                                      : null;
                                    return (
                                      <td className="px-2 py-3 text-right align-middle">
                                        <span className="text-sm tabular-nums text-muted-foreground">
                                          {val != null ? val.toFixed(1) : "—"}
                                        </span>
                                      </td>
                                    );
                                  })()}
                                  {row.bids.map((bid, bidIdx) => {
                                    const maxAllowed = bid.maxAllowed ?? Infinity;
                                    const isInvalid = bid.amount != null && bid.amount > 0 && bid.amount > maxAllowed;
                                    const display =
                                      bid.amount === null
                                        ? "—"
                                        : bid.amount === 0
                                          ? "Pass"
                                          : `$${bid.amount}`;
                                    const isWin = bid.isWinningBid;
                                    const isRunnerUp = !isWin && bid.isSecondPlaceBid && !isInvalid;
                                    const isAuto = bid.isAutoDefault;
                                    const isLastBid = bidIdx === row.bids.length - 1;
                                    return (
                                      <td
                                        key={bid.userId}
                                        className={`px-2 py-3 text-right align-middle${isLastBid ? " pr-3" : ""}`}
                                      >
                                        <span className="inline-flex flex-col items-end">
                                          <span
                                            className={[
                                              "inline-block min-w-[3rem] text-sm tabular-nums transition-colors",
                                              isInvalid
                                                ? "line-through text-red-500/70 dark:text-red-400/70"
                                                : isWin
                                                  ? "font-semibold text-emerald-700 dark:text-emerald-300"
                                                  : isRunnerUp
                                                    ? "font-medium text-amber-700 dark:text-amber-300"
                                                    : bid.amount === 0
                                                      ? "italic text-muted-foreground/70"
                                                      : bid.amount === null
                                                        ? "text-muted-foreground/50"
                                                        : "text-muted-foreground",
                                            ].join(" ")}
                                            title={isInvalid ? `Over max allowed ($${maxAllowed})` : undefined}
                                          >
                                            {display}
                                            {isAuto && bid.amount != null && bid.amount > 0 ? (
                                              <span className="ml-0.5 text-[9px] text-muted-foreground/60" title="Auto-bid">
                                                A
                                              </span>
                                            ) : null}
                                          </span>
                                          {isWin && row.winnerRemainingBudget !== null && row.winnerRemainingSlots !== null ? (
                                            <span className="text-[10px] tabular-nums text-emerald-700/70 dark:text-emerald-300/70">
                                              ${row.winnerRemainingBudget} · {row.winnerRemainingSlots}
                                            </span>
                                          ) : null}
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

      {activeTab === "simulator" ? (
        <SimulatorTab
          leagueId={leagueId}
          leagueName={data.league.name}
          leagueData={{
            rosters: data.rosters,
            members: data.members,
            availablePlayers: data.availablePlayers,
            league: {
              budgetPerTeam: data.league.budgetPerTeam,
              minBid: data.league.minBid,
              rosterSize: data.league.rosterSize,
            },
            viewerUserId: viewerUserId ?? undefined,
          }}
        />
      ) : null}

      {activeTab === "standings" ? (
        <StandingsPanel
          leagueId={leagueId}
          rosters={data.rosters}
          livePoints={data.livePoints ?? {}}
          isScoring={data.league.phase === "scoring"}
        />
      ) : null}

      {activeTab === "chart" ? (
        <LeagueChartPanel
          leagueId={leagueId}
          viewerEmail={session?.user?.email ?? null}
          projections={leagueProjections}
          refetchProjections={refetchLeagueProjections}
          rosters={data.rosters.map((r) => ({
            userId: r.userId,
            name: r.name,
            players: r.players.map((p) => ({
              playerId: p.playerId,
              playerName: p.playerName,
              playerTeam: p.playerTeam,
            })),
          }))}
        />
      ) : null}

      {activeTab === "commissioner" && data.league.isCommissioner ? (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Commissioner Tools</CardTitle>
              <CardDescription>
                Manage rosters and budgets. Actions here override normal draft rules.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Start Auction Draft */}
              {!data.currentRound && !data.auctionState && !data.snakeState && data.league.phase !== "scoring" ? (
                <div>
                  <h3 className="text-sm font-semibold text-foreground mb-3">Start Live Auction Draft</h3>
                  <p className="text-xs text-muted-foreground mb-4">
                    Managers take turns nominating players. Anyone can outbid. Timer resets on each bid.
                  </p>
                  <form
                    className="flex flex-wrap gap-3 items-end"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const form = e.currentTarget;
                      const fd = new FormData(form);
                      try {
                        const result = await appApiFetch<{ ok: boolean; error?: string }>(
                          `/leagues/${leagueId}/auction/start`,
                          {
                            method: "POST",
                            body: JSON.stringify({
                              bidTimerSeconds: parseInt(fd.get("bidTimer") as string) || 10,
                              nominationTimerSeconds: parseInt(fd.get("nomTimer") as string) || 30,
                              orderMode: fd.get("orderMode") || "draft_priority",
                            }),
                          },
                        );
                        if (result.ok) {
                          toast.success("Auction started!");
                          loadLeague();
                        } else {
                          toast.error(result.error ?? "Failed to start auction");
                        }
                      } catch {
                        toast.error("Failed to start auction");
                      }
                    }}
                  >
                    <div>
                      <Label className="text-xs">Bid Timer (sec)</Label>
                      <Input type="number" name="bidTimer" defaultValue={10} min={5} max={60} className="w-24" />
                    </div>
                    <div>
                      <Label className="text-xs">Nomination Timer (sec)</Label>
                      <Input type="number" name="nomTimer" defaultValue={30} min={15} max={120} className="w-24" />
                    </div>
                    <div>
                      <Label className="text-xs">Order</Label>
                      <select name="orderMode" className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm">
                        <option value="draft_priority">Draft Priority</option>
                        <option value="random">Random</option>
                      </select>
                    </div>
                    <Button type="submit">Start Auction</Button>
                  </form>
                </div>
              ) : null}

              {/* Start Snake Draft */}
              {!data.currentRound && !data.auctionState && !data.snakeState && data.league.phase !== "scoring" ? (
                <div>
                  <h3 className="text-sm font-semibold text-foreground mb-3">Start Snake Draft</h3>
                  <p className="text-xs text-muted-foreground mb-4">
                    Managers take turns picking players in a serpentine order. Each round reverses the pick direction.
                  </p>
                  <form
                    className="flex flex-wrap gap-3 items-end"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const fd = new FormData(e.currentTarget);
                      const timed = fd.get("timed") === "true";
                      try {
                        const result = await appApiFetch<{ ok: boolean; error?: string }>(
                          `/leagues/${leagueId}/snake/start`,
                          {
                            method: "POST",
                            body: JSON.stringify({
                              timed,
                              pickTimerSeconds: parseInt(fd.get("pickTimer") as string) || 30,
                              orderMode: fd.get("orderMode") || "draft_priority",
                            }),
                          },
                        );
                        if (result.ok) {
                          toast.success("Snake draft started!");
                          loadLeague();
                        } else {
                          toast.error(result.error ?? "Failed to start snake draft");
                        }
                      } catch {
                        toast.error("Failed to start snake draft");
                      }
                    }}
                  >
                    <div>
                      <Label className="text-xs">Mode</Label>
                      <select name="timed" className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm">
                        <option value="true">Timed</option>
                        <option value="false">Untimed</option>
                      </select>
                    </div>
                    <div>
                      <Label className="text-xs">Pick Timer (sec)</Label>
                      <Input type="number" name="pickTimer" defaultValue={30} min={10} max={120} className="w-24" />
                    </div>
                    <div>
                      <Label className="text-xs">Order</Label>
                      <select name="orderMode" className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm">
                        <option value="draft_priority">Draft Priority</option>
                        <option value="random">Random</option>
                      </select>
                    </div>
                    <Button type="submit">Start Snake Draft</Button>
                  </form>
                </div>
              ) : null}

              {/* Remove Player from Roster */}
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-3">Remove Player from Roster</h3>
                <p className="text-xs text-muted-foreground mb-4">
                  Remove a player and refund the acquisition cost. The player returns to the available pool.
                </p>
                {data.rosters.filter((r) => r.players.length > 0).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No players have been drafted yet.</p>
                ) : (
                  <div className="space-y-4">
                    {data.rosters
                      .filter((r) => r.players.length > 0)
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((roster) => (
                        <div key={roster.userId} className="rounded-xl border border-border/80 px-4 py-3">
                          <p className="font-medium text-foreground mb-2">{roster.name}</p>
                          <div className="space-y-1.5">
                            {roster.players
                              .slice()
                              .sort((a, b) => b.acquisitionBid - a.acquisitionBid)
                              .map((player) => (
                                <div
                                  key={player.playerId}
                                  className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2 text-sm"
                                >
                                  <div className="flex items-center gap-2 min-w-0">
                                    <PlayerAvatar espnId={player.playerId} team={player.playerTeam} size={28} />
                                    <div className="min-w-0">
                                      <p className="font-medium text-foreground truncate">{player.playerName}</p>
                                      <p className="text-xs text-muted-foreground">{player.playerTeam} &middot; ${player.acquisitionBid}</p>
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    className={buttonVariants({ variant: "destructive", size: "sm" })}
                                    onClick={() =>
                                      setRemovePlayerTarget({
                                        playerId: player.playerId,
                                        playerName: player.playerName,
                                        ownerName: roster.name,
                                        acquisitionBid: player.acquisitionBid,
                                      })
                                    }
                                  >
                                    Remove &amp; Refund
                                  </button>
                                </div>
                              ))}
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </div>

              {/* Budget Adjustment */}
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-3">Adjust Budget</h3>
                <p className="text-xs text-muted-foreground mb-4">
                  Add or remove money from a manager&apos;s budget. Positive = add money, negative = deduct.
                </p>
                <form
                  className="flex flex-col gap-3 sm:flex-row sm:items-end"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const form = e.currentTarget;
                    const fd = new FormData(form);
                    const userId = fd.get("userId") as string;
                    const amount = Number(fd.get("amount"));
                    const reason = (fd.get("reason") as string).trim();
                    if (!userId || !amount || !reason) {
                      toast.error("All fields are required and amount must be non-zero");
                      return;
                    }
                    try {
                      await appApiFetch(`/leagues/${leagueId}/members/${userId}/budget`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ amount, reason }),
                      });
                      const memberName = data.members.find((m) => m.userId === userId)?.name ?? "Member";
                      toast.success(`${amount > 0 ? "Added" : "Deducted"} $${Math.abs(amount)} ${amount > 0 ? "to" : "from"} ${memberName}'s budget`);
                      form.reset();
                      await loadLeague();
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : "Failed to adjust budget");
                    }
                  }}
                >
                  <div className="flex-1">
                    <Label htmlFor="budget-member">Manager</Label>
                    <select
                      id="budget-member"
                      name="userId"
                      className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      required
                    >
                      <option value="">Select...</option>
                      {data.members.map((m) => (
                        <option key={m.userId} value={m.userId}>
                          {m.name} (${m.remainingBudget} remaining)
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="w-24">
                    <Label htmlFor="budget-amount">Amount</Label>
                    <Input id="budget-amount" name="amount" type="number" placeholder="e.g. 10" className="mt-1" required />
                  </div>
                  <div className="flex-1">
                    <Label htmlFor="budget-reason">Reason</Label>
                    <Input id="budget-reason" name="reason" type="text" placeholder="e.g. Luka refund" className="mt-1" required />
                  </div>
                  <Button type="submit" size="sm">Apply</Button>
                </form>
              </div>
            </CardContent>
          </Card>

          {/* Action Log */}
          {data.actions && data.actions.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Action Log</CardTitle>
                <CardDescription>Audit trail of all league actions.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto rounded-xl border border-border/80">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 font-medium">#</th>
                        <th className="px-3 py-2 font-medium">Type</th>
                        <th className="px-3 py-2 font-medium">Details</th>
                        <th className="px-3 py-2 text-right font-medium">Amount</th>
                        <th className="px-3 py-2 font-medium">Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.actions.map((action) => {
                        const meta = action.metadata as Record<string, unknown> | null;
                        const memberName = action.userId
                          ? data.members.find((m) => m.userId === action.userId)?.name ?? "Unknown"
                          : null;
                        const playerName = (meta?.playerName as string) ?? action.playerId;
                        let details = "";
                        if (action.type === "draft_award") {
                          details = `${playerName} → ${memberName}`;
                        } else if (action.type === "roster_remove") {
                          details = `${playerName} removed from ${memberName}`;
                        } else if (action.type === "roster_add") {
                          details = `${playerName} added to ${memberName}`;
                        } else if (action.type === "budget_adjust") {
                          details = `${memberName}: ${(meta?.reason as string) ?? ""}`;
                        } else if (action.type === "round_opened" || action.type === "round_closed") {
                          details = `Round ${(meta?.roundNumber as number) ?? "?"}`;
                        }

                        return (
                          <tr key={action.id} className="border-t border-border/60">
                            <td className="px-3 py-2 tabular-nums text-muted-foreground">{action.sequenceNumber}</td>
                            <td className="px-3 py-2">
                              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                                {ACTION_TYPE_LABELS[action.type] ?? action.type}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-foreground">{details}</td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {action.amount !== null ? (() => {
                                const isRefund =
                                  action.type === "roster_remove" ||
                                  action.type === "auction_undo_award";
                                const isSpend =
                                  action.type === "draft_award" ||
                                  action.type === "roster_add" ||
                                  action.type === "auction_award";
                                const signedAmount = isRefund
                                  ? Math.abs(action.amount)
                                  : isSpend
                                    ? -Math.abs(action.amount)
                                    : action.amount;
                                const isCredit = signedAmount > 0;
                                return (
                                  <span className={isCredit ? "text-green-600" : "text-red-600"}>
                                    {isCredit ? "+" : "-"}${Math.abs(signedAmount)}
                                  </span>
                                );
                              })() : (
                                <span className="text-muted-foreground">-</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {new Date(action.createdAt).toLocaleDateString()}
                            </td>
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
      ) : null}

      <ConfirmDialog
        open={removePlayerTarget !== null}
        title={`Remove ${removePlayerTarget?.playerName} and refund $${removePlayerTarget?.acquisitionBid}?`}
        description={
          <p>
            This will remove {removePlayerTarget?.playerName} from {removePlayerTarget?.ownerName}&apos;s roster
            and refund ${removePlayerTarget?.acquisitionBid} to their budget. The player will be available for future draft rounds.
          </p>
        }
        confirmLabel="Remove & Refund"
        destructive
        loading={removePlayerPending}
        onCancel={() => {
          if (!removePlayerPending) setRemovePlayerTarget(null);
        }}
        onConfirm={() => void removePlayerFromRoster()}
      />

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
