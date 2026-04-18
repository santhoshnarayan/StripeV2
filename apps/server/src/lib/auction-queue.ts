import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  auctionState,
  leagueAction,
  rosterEntry,
  league,
  leagueMember,
  user,
} from "@repo/db";
import type { SSEStreamingApi } from "hono/streaming";

// ---------- Types ----------

type AuctionStateRow = typeof auctionState.$inferSelect;
type TransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type AuctionEvent =
  | { type: "nominate"; userId: string; playerId: string; playerName: string; playerTeam: string; openingBid: number }
  | { type: "bid"; userId: string; amount: number; receivedAt: Date }
  | { type: "settle"; expectedExpiresAt: Date }
  | { type: "nomination_timeout" }
  | { type: "pause"; actorUserId: string }
  | { type: "resume"; actorUserId: string }
  | { type: "undo_award"; actorUserId: string; playerId?: string }
  | { type: "end"; actorUserId: string };

export type EventResult =
  | { ok: true; outcome: string; data?: Record<string, unknown> }
  | { ok: false; error: string };

type QueueEntry = {
  event: AuctionEvent;
  resolve: (r: EventResult) => void;
  reject: (e: Error) => void;
};

export type SSEEvent = {
  event: string;
  data: Record<string, unknown>;
};

// ---------- Helpers (duplicated from app.ts to avoid circular deps) ----------

async function nextSequenceNumber(tx: TransactionClient, leagueId: string): Promise<number> {
  const result = await tx
    .select({ maxSeq: sql<number>`COALESCE(MAX(${leagueAction.sequenceNumber}), 0)` })
    .from(leagueAction)
    .where(eq(leagueAction.leagueId, leagueId));
  return (result[0]?.maxSeq ?? 0) + 1;
}

// ---------- AuctionEngine ----------

export class AuctionEngine {
  private queue: QueueEntry[] = [];
  private processing = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private nominationTimer: ReturnType<typeof setTimeout> | null = null;
  private sseClients = new Set<SSEStreamingApi>();
  private state: AuctionStateRow;

  constructor(initialState: AuctionStateRow) {
    this.state = initialState;
  }

  // --- Public API ---

  async enqueue(event: AuctionEvent): Promise<EventResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ event, resolve, reject });
      this.drain();
    });
  }

  getStateSnapshot(): Record<string, unknown> {
    return {
      status: this.state.status,
      bidTimerSeconds: this.state.bidTimerSeconds,
      nominationTimerSeconds: this.state.nominationTimerSeconds,
      nominationOrder: this.state.nominationOrder,
      nominationIndex: this.state.nominationIndex,
      currentNominatorUserId: this.state.currentNominatorUserId,
      currentPlayerId: this.state.currentPlayerId,
      currentPlayerName: this.state.currentPlayerName,
      currentPlayerTeam: this.state.currentPlayerTeam,
      highBidAmount: this.state.highBidAmount,
      highBidUserId: this.state.highBidUserId,
      expiresAt: this.state.expiresAt?.toISOString() ?? null,
      totalAwards: this.state.totalAwards,
      leagueId: this.state.leagueId,
    };
  }

  addClient(stream: SSEStreamingApi) {
    this.sseClients.add(stream);
  }

  removeClient(stream: SSEStreamingApi) {
    this.sseClients.delete(stream);
  }

  restartSettleTimer(delayMs: number, expectedExpiresAt: Date) {
    this.clearSettleTimer();
    this.settleTimer = setTimeout(() => {
      this.enqueue({ type: "settle", expectedExpiresAt });
    }, delayMs);
  }

  restartNominationTimer(delayMs: number) {
    this.clearNominationTimer();
    this.nominationTimer = setTimeout(() => {
      this.enqueue({ type: "nomination_timeout" });
    }, delayMs);
  }

  destroy() {
    this.clearSettleTimer();
    this.clearNominationTimer();
    // Close SSE clients
    this.sseClients.clear();
  }

  get leagueId(): string {
    return this.state.leagueId;
  }

  get currentStatus(): string {
    return this.state.status;
  }

  // --- Queue processing ---

  private async drain() {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length > 0) {
      const entry = this.queue.shift()!;
      try {
        const result = await this.processEvent(entry.event);
        entry.resolve(result);
      } catch (err) {
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
    this.processing = false;
  }

  private async processEvent(event: AuctionEvent): Promise<EventResult> {
    switch (event.type) {
      case "nominate":
        return this.handleNominate(event);
      case "bid":
        return this.handleBid(event);
      case "settle":
        return this.handleSettle(event);
      case "nomination_timeout":
        return this.handleNominationTimeout();
      case "pause":
        return this.handlePause(event);
      case "resume":
        return this.handleResume(event);
      case "undo_award":
        return this.handleUndoAward(event);
      case "end":
        return this.handleEnd(event);
    }
  }

  // --- Event handlers ---

  private async handleNominate(event: Extract<AuctionEvent, { type: "nominate" }>): Promise<EventResult> {
    if (this.state.status !== "nominating") {
      return { ok: false, error: "Not in nomination phase" };
    }
    if (event.userId !== this.state.currentNominatorUserId) {
      return { ok: false, error: "Not your turn to nominate" };
    }

    // Check player isn't already rostered
    const existing = await db
      .select({ id: rosterEntry.id })
      .from(rosterEntry)
      .where(and(eq(rosterEntry.leagueId, this.state.leagueId), eq(rosterEntry.playerId, event.playerId)))
      .limit(1);
    if (existing.length > 0) {
      return { ok: false, error: "Player is already rostered" };
    }

    // Validate budget
    const budgetCheck = await this.checkBudget(event.userId, event.openingBid);
    if (!budgetCheck.ok) return budgetCheck;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.state.bidTimerSeconds * 1000);

    await db.transaction(async (tx) => {
      const seq = await nextSequenceNumber(tx, this.state.leagueId);
      await tx.insert(leagueAction).values({
        id: randomUUID(),
        leagueId: this.state.leagueId,
        type: "auction_nominate",
        userId: event.userId,
        playerId: event.playerId,
        amount: event.openingBid,
        actorUserId: event.userId,
        sequenceNumber: seq,
        metadata: { playerName: event.playerName, playerTeam: event.playerTeam },
        createdAt: now,
      });
      await tx
        .update(auctionState)
        .set({
          status: "bidding",
          currentPlayerId: event.playerId,
          currentPlayerName: event.playerName,
          currentPlayerTeam: event.playerTeam,
          highBidAmount: event.openingBid,
          highBidUserId: event.userId,
          expiresAt,
          updatedAt: now,
        })
        .where(eq(auctionState.id, this.state.id));
    });

    // Update in-memory state
    this.state.status = "bidding";
    this.state.currentPlayerId = event.playerId;
    this.state.currentPlayerName = event.playerName;
    this.state.currentPlayerTeam = event.playerTeam;
    this.state.highBidAmount = event.openingBid;
    this.state.highBidUserId = event.userId;
    this.state.expiresAt = expiresAt;

    this.clearNominationTimer();
    this.restartSettleTimer(this.state.bidTimerSeconds * 1000, expiresAt);

    this.broadcast("nominate", {
      playerId: event.playerId,
      playerName: event.playerName,
      playerTeam: event.playerTeam,
      openingBid: event.openingBid,
      nominatorUserId: event.userId,
      expiresAt: expiresAt.toISOString(),
    });

    return { ok: true, outcome: "nominated" };
  }

  private async handleBid(event: Extract<AuctionEvent, { type: "bid" }>): Promise<EventResult> {
    if (this.state.status !== "bidding") {
      return { ok: false, error: "Not in bidding phase" };
    }

    const deadline = new Date(this.state.expiresAt!.getTime() + this.state.bufferMs);
    if (event.receivedAt > deadline) {
      // Log invalid bid for audit
      await this.logBid(event, false, "timer_expired");
      return { ok: false, error: "Bidding time expired" };
    }

    if (event.amount <= (this.state.highBidAmount ?? 0)) {
      await this.logBid(event, false, "bid_too_low");
      return { ok: false, error: "Bid must be higher than current high bid" };
    }

    if (event.userId === this.state.highBidUserId) {
      return { ok: false, error: "You are already the high bidder" };
    }

    // Validate budget
    const budgetCheck = await this.checkBudget(event.userId, event.amount);
    if (!budgetCheck.ok) {
      await this.logBid(event, false, "budget_exceeded");
      return budgetCheck;
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.state.bidTimerSeconds * 1000);
    const previousHigh = this.state.highBidAmount;

    await db.transaction(async (tx) => {
      const seq = await nextSequenceNumber(tx, this.state.leagueId);
      await tx.insert(leagueAction).values({
        id: randomUUID(),
        leagueId: this.state.leagueId,
        type: "auction_bid",
        userId: event.userId,
        playerId: this.state.currentPlayerId,
        amount: event.amount,
        actorUserId: event.userId,
        sequenceNumber: seq,
        metadata: { valid: true, previousHigh },
        createdAt: now,
      });
      await tx
        .update(auctionState)
        .set({
          highBidAmount: event.amount,
          highBidUserId: event.userId,
          expiresAt,
          updatedAt: now,
        })
        .where(eq(auctionState.id, this.state.id));
    });

    // Update in-memory state
    this.state.highBidAmount = event.amount;
    this.state.highBidUserId = event.userId;
    this.state.expiresAt = expiresAt;

    this.clearSettleTimer();
    this.restartSettleTimer(this.state.bidTimerSeconds * 1000, expiresAt);

    this.broadcast("bid", {
      userId: event.userId,
      amount: event.amount,
      playerId: this.state.currentPlayerId,
      expiresAt: expiresAt.toISOString(),
    });

    return { ok: true, outcome: "high_bid", data: { amount: event.amount } };
  }

  private async handleSettle(event: Extract<AuctionEvent, { type: "settle" }>): Promise<EventResult> {
    // Stale check — if a newer bid moved the deadline, this settle is outdated
    if (
      this.state.status !== "bidding" ||
      !this.state.expiresAt ||
      event.expectedExpiresAt.getTime() !== this.state.expiresAt.getTime()
    ) {
      return { ok: true, outcome: "stale_settle_discarded" };
    }

    const winnerId = this.state.highBidUserId!;
    const winAmount = this.state.highBidAmount!;
    const playerId = this.state.currentPlayerId!;
    const playerName = this.state.currentPlayerName!;
    const playerTeam = this.state.currentPlayerTeam!;
    const now = new Date();

    // Count existing roster entries for acquisition order
    const rosterCount = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(rosterEntry)
      .where(and(eq(rosterEntry.leagueId, this.state.leagueId), eq(rosterEntry.userId, winnerId)));
    const acquisitionOrder = (rosterCount[0]?.count ?? 0) + 1;

    const nominationOrder = this.state.nominationOrder as string[];
    const nextIndex = (this.state.nominationIndex + 1) % nominationOrder.length;
    const nextNominator = nominationOrder[nextIndex];
    const newTotalAwards = this.state.totalAwards + 1;

    await db.transaction(async (tx) => {
      // Award: create roster entry
      await tx.insert(rosterEntry).values({
        id: randomUUID(),
        leagueId: this.state.leagueId,
        userId: winnerId,
        playerId,
        playerName,
        playerTeam,
        acquisitionOrder,
        acquisitionBid: winAmount,
        createdAt: now,
        updatedAt: now,
      });

      // Log auction_award action
      const seq = await nextSequenceNumber(tx, this.state.leagueId);
      await tx.insert(leagueAction).values({
        id: randomUUID(),
        leagueId: this.state.leagueId,
        type: "auction_award",
        userId: winnerId,
        playerId,
        amount: winAmount,
        actorUserId: winnerId,
        sequenceNumber: seq,
        metadata: { playerName, playerTeam, nominatorUserId: this.state.currentNominatorUserId },
        createdAt: now,
      });

      // Advance nomination
      await tx
        .update(auctionState)
        .set({
          status: "nominating",
          currentPlayerId: null,
          currentPlayerName: null,
          currentPlayerTeam: null,
          highBidAmount: null,
          highBidUserId: null,
          expiresAt: null,
          nominationIndex: nextIndex,
          currentNominatorUserId: nextNominator,
          totalAwards: newTotalAwards,
          updatedAt: now,
        })
        .where(eq(auctionState.id, this.state.id));
    });

    // Update in-memory state
    this.state.status = "nominating";
    this.state.currentPlayerId = null;
    this.state.currentPlayerName = null;
    this.state.currentPlayerTeam = null;
    this.state.highBidAmount = null;
    this.state.highBidUserId = null;
    this.state.expiresAt = null;
    this.state.nominationIndex = nextIndex;
    this.state.currentNominatorUserId = nextNominator;
    this.state.totalAwards = newTotalAwards;

    this.clearSettleTimer();

    // Broadcast award
    this.broadcast("award", {
      playerId,
      playerName,
      playerTeam,
      winnerUserId: winnerId,
      amount: winAmount,
    });

    // Check if draft is complete
    const isComplete = await this.checkDraftComplete();
    if (isComplete) {
      await this.completeDraft("complete");
      return { ok: true, outcome: "awarded_and_draft_complete" };
    }

    // Broadcast next nomination turn
    this.broadcast("nominate_turn", {
      nominatorUserId: nextNominator,
      nominationIndex: nextIndex,
    });

    // Start nomination timer
    this.restartNominationTimer(this.state.nominationTimerSeconds * 1000);

    return { ok: true, outcome: "awarded", data: { playerId, winnerId: winnerId, amount: winAmount } };
  }

  private async handleNominationTimeout(): Promise<EventResult> {
    if (this.state.status !== "nominating") {
      return { ok: true, outcome: "stale_nomination_timeout" };
    }

    // Auto-pass: advance to next nominator
    const now = new Date();
    const nominationOrder = this.state.nominationOrder as string[];
    const nextIndex = (this.state.nominationIndex + 1) % nominationOrder.length;
    const nextNominator = nominationOrder[nextIndex];

    await db.transaction(async (tx) => {
      const seq = await nextSequenceNumber(tx, this.state.leagueId);
      await tx.insert(leagueAction).values({
        id: randomUUID(),
        leagueId: this.state.leagueId,
        type: "auction_pass",
        userId: this.state.currentNominatorUserId,
        sequenceNumber: seq,
        metadata: { reason: "timeout" },
        createdAt: now,
      });
      await tx
        .update(auctionState)
        .set({
          nominationIndex: nextIndex,
          currentNominatorUserId: nextNominator,
          updatedAt: now,
        })
        .where(eq(auctionState.id, this.state.id));
    });

    this.state.nominationIndex = nextIndex;
    this.state.currentNominatorUserId = nextNominator;

    this.broadcast("nominate_turn", {
      nominatorUserId: nextNominator,
      nominationIndex: nextIndex,
      previousPassedUserId: this.state.currentNominatorUserId,
      reason: "timeout",
    });

    this.restartNominationTimer(this.state.nominationTimerSeconds * 1000);

    return { ok: true, outcome: "nomination_passed" };
  }

  private async handlePause(event: Extract<AuctionEvent, { type: "pause" }>): Promise<EventResult> {
    if (this.state.status === "paused" || this.state.status === "completed") {
      return { ok: false, error: "Cannot pause in current state" };
    }

    const now = new Date();
    const statusBefore = this.state.status;

    await db.transaction(async (tx) => {
      const seq = await nextSequenceNumber(tx, this.state.leagueId);
      await tx.insert(leagueAction).values({
        id: randomUUID(),
        leagueId: this.state.leagueId,
        type: "auction_pause",
        actorUserId: event.actorUserId,
        sequenceNumber: seq,
        metadata: {},
        createdAt: now,
      });
      await tx
        .update(auctionState)
        .set({
          status: "paused",
          statusBeforePause: statusBefore,
          pausedAt: now,
          updatedAt: now,
        })
        .where(eq(auctionState.id, this.state.id));
    });

    this.state.status = "paused";
    this.state.statusBeforePause = statusBefore;
    this.state.pausedAt = now;

    this.clearSettleTimer();
    this.clearNominationTimer();

    this.broadcast("pause", { pausedAt: now.toISOString() });

    return { ok: true, outcome: "paused" };
  }

  private async handleResume(event: Extract<AuctionEvent, { type: "resume" }>): Promise<EventResult> {
    if (this.state.status !== "paused") {
      return { ok: false, error: "Auction is not paused" };
    }

    const now = new Date();
    const restoredStatus = this.state.statusBeforePause ?? "nominating";
    let expiresAt: Date | null = null;

    if (restoredStatus === "bidding") {
      // Full timer reset on resume
      expiresAt = new Date(now.getTime() + this.state.bidTimerSeconds * 1000);
    }

    await db.transaction(async (tx) => {
      const seq = await nextSequenceNumber(tx, this.state.leagueId);
      await tx.insert(leagueAction).values({
        id: randomUUID(),
        leagueId: this.state.leagueId,
        type: "auction_resume",
        actorUserId: event.actorUserId,
        sequenceNumber: seq,
        metadata: {},
        createdAt: now,
      });
      await tx
        .update(auctionState)
        .set({
          status: restoredStatus,
          statusBeforePause: null,
          pausedAt: null,
          expiresAt,
          updatedAt: now,
        })
        .where(eq(auctionState.id, this.state.id));
    });

    this.state.status = restoredStatus;
    this.state.statusBeforePause = null;
    this.state.pausedAt = null;
    this.state.expiresAt = expiresAt;

    if (restoredStatus === "bidding" && expiresAt) {
      this.restartSettleTimer(this.state.bidTimerSeconds * 1000, expiresAt);
    } else if (restoredStatus === "nominating") {
      this.restartNominationTimer(this.state.nominationTimerSeconds * 1000);
    }

    this.broadcast("resume", {
      status: restoredStatus,
      expiresAt: expiresAt?.toISOString() ?? null,
    });

    return { ok: true, outcome: "resumed" };
  }

  private async handleUndoAward(event: Extract<AuctionEvent, { type: "undo_award" }>): Promise<EventResult> {
    // Find the award to undo
    let targetPlayerId = event.playerId;

    if (!targetPlayerId) {
      // Undo latest award
      const latestAward = await db
        .select()
        .from(leagueAction)
        .where(
          and(
            eq(leagueAction.leagueId, this.state.leagueId),
            eq(leagueAction.type, "auction_award"),
          ),
        )
        .orderBy(sql`${leagueAction.sequenceNumber} DESC`)
        .limit(1);

      if (latestAward.length === 0) {
        return { ok: false, error: "No awards to undo" };
      }
      targetPlayerId = latestAward[0].playerId!;
    }

    // Find the roster entry
    const entry = await db
      .select()
      .from(rosterEntry)
      .where(
        and(
          eq(rosterEntry.leagueId, this.state.leagueId),
          eq(rosterEntry.playerId, targetPlayerId),
        ),
      )
      .limit(1);

    if (entry.length === 0) {
      return { ok: false, error: "Player not found on any roster" };
    }

    const rosterRow = entry[0];
    const now = new Date();

    await db.transaction(async (tx) => {
      // Delete roster entry
      await tx.delete(rosterEntry).where(eq(rosterEntry.id, rosterRow.id));

      // Log undo action
      const seq = await nextSequenceNumber(tx, this.state.leagueId);
      await tx.insert(leagueAction).values({
        id: randomUUID(),
        leagueId: this.state.leagueId,
        type: "auction_undo_award",
        userId: rosterRow.userId,
        playerId: targetPlayerId,
        amount: -rosterRow.acquisitionBid,
        actorUserId: event.actorUserId,
        sequenceNumber: seq,
        metadata: { playerName: rosterRow.playerName },
        createdAt: now,
      });

      // Decrement total awards
      await tx
        .update(auctionState)
        .set({
          totalAwards: Math.max(0, this.state.totalAwards - 1),
          updatedAt: now,
        })
        .where(eq(auctionState.id, this.state.id));
    });

    this.state.totalAwards = Math.max(0, this.state.totalAwards - 1);

    this.broadcast("undo_award", {
      playerId: targetPlayerId,
      playerName: rosterRow.playerName,
      userId: rosterRow.userId,
      refundAmount: rosterRow.acquisitionBid,
    });

    return { ok: true, outcome: "award_undone", data: { playerId: targetPlayerId, playerName: rosterRow.playerName } };
  }

  private async handleEnd(event: Extract<AuctionEvent, { type: "end" }>): Promise<EventResult> {
    if (this.state.status === "completed") {
      return { ok: false, error: "Auction already ended" };
    }

    await this.completeDraft("commissioner_ended", event.actorUserId);
    return { ok: true, outcome: "ended" };
  }

  // --- Internal helpers ---

  private async logBid(
    event: Extract<AuctionEvent, { type: "bid" }>,
    valid: boolean,
    reason?: string,
  ) {
    const now = new Date();
    await db.transaction(async (tx) => {
      const seq = await nextSequenceNumber(tx, this.state.leagueId);
      await tx.insert(leagueAction).values({
        id: randomUUID(),
        leagueId: this.state.leagueId,
        type: "auction_bid",
        userId: event.userId,
        playerId: this.state.currentPlayerId,
        amount: event.amount,
        actorUserId: event.userId,
        sequenceNumber: seq,
        metadata: { valid, reason, previousHigh: this.state.highBidAmount },
        createdAt: now,
      });
    });
  }

  private async checkBudget(userId: string, bidAmount: number): Promise<EventResult> {
    // Get roster count and total spent for this user
    const rosterRows = await db
      .select({
        count: sql<number>`COUNT(*)`,
        spent: sql<number>`COALESCE(SUM(${rosterEntry.acquisitionBid}), 0)`,
      })
      .from(rosterEntry)
      .where(and(eq(rosterEntry.leagueId, this.state.leagueId), eq(rosterEntry.userId, userId)));

    // Get league config
    const leagueRows = await db.select().from(league).where(eq(league.id, this.state.leagueId)).limit(1);
    if (leagueRows.length === 0) return { ok: false, error: "League not found" };
    const leagueRow = leagueRows[0];

    // Get budget adjustments
    const adjRows = await db
      .select({ total: sql<number>`COALESCE(SUM(${leagueAction.amount}), 0)` })
      .from(leagueAction)
      .where(
        and(
          eq(leagueAction.leagueId, this.state.leagueId),
          eq(leagueAction.type, "budget_adjust"),
          eq(leagueAction.userId, userId),
        ),
      );

    const rosterCount = rosterRows[0]?.count ?? 0;
    const spentBudget = rosterRows[0]?.spent ?? 0;
    const adjustment = adjRows[0]?.total ?? 0;
    const remainingBudget = leagueRow.budgetPerTeam + adjustment - spentBudget;
    const remainingSlots = leagueRow.rosterSize - rosterCount;

    if (remainingSlots <= 0) {
      return { ok: false, error: "Roster is full" };
    }

    // Max bid: leave $minBid for each remaining empty slot (excluding this one)
    const maxBid = remainingBudget - (remainingSlots - 1) * leagueRow.minBid;
    if (bidAmount > maxBid) {
      return { ok: false, error: `Bid exceeds max allowed ($${maxBid})` };
    }

    if (bidAmount < leagueRow.minBid) {
      return { ok: false, error: `Bid must be at least $${leagueRow.minBid}` };
    }

    return { ok: true, outcome: "budget_ok" };
  }

  private async checkDraftComplete(): Promise<boolean> {
    // Check if all rosters are full
    const leagueRows = await db.select().from(league).where(eq(league.id, this.state.leagueId)).limit(1);
    if (leagueRows.length === 0) return true;
    const leagueRow = leagueRows[0];

    const memberCount = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(leagueMember)
      .where(and(eq(leagueMember.leagueId, this.state.leagueId), eq(leagueMember.status, "active")));

    const rosterCount = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(rosterEntry)
      .where(eq(rosterEntry.leagueId, this.state.leagueId));

    const totalSlots = (memberCount[0]?.count ?? 0) * leagueRow.rosterSize;
    const filledSlots = rosterCount[0]?.count ?? 0;

    return filledSlots >= totalSlots;
  }

  private async completeDraft(reason: string, actorUserId?: string) {
    const now = new Date();

    await db.transaction(async (tx) => {
      const seq = await nextSequenceNumber(tx, this.state.leagueId);
      await tx.insert(leagueAction).values({
        id: randomUUID(),
        leagueId: this.state.leagueId,
        type: "auction_end",
        actorUserId: actorUserId ?? null,
        sequenceNumber: seq,
        metadata: { reason, totalAwards: this.state.totalAwards },
        createdAt: now,
      });

      await tx
        .update(auctionState)
        .set({ status: "completed", updatedAt: now })
        .where(eq(auctionState.id, this.state.id));

      await tx
        .update(league)
        .set({ phase: "scoring", updatedAt: now })
        .where(eq(league.id, this.state.leagueId));
    });

    this.state.status = "completed";
    this.clearSettleTimer();
    this.clearNominationTimer();

    this.broadcast("end", { reason, totalAwards: this.state.totalAwards });

    removeAuction(this.state.leagueId);
  }

  private broadcast(eventName: string, data: Record<string, unknown>) {
    const payload = JSON.stringify(data);
    for (const client of this.sseClients) {
      client.writeSSE({ event: eventName, data: payload }).catch(() => {
        this.sseClients.delete(client);
      });
    }
  }

  private clearSettleTimer() {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
  }

  private clearNominationTimer() {
    if (this.nominationTimer) {
      clearTimeout(this.nominationTimer);
      this.nominationTimer = null;
    }
  }
}

// ---------- Registry ----------

const activeAuctions = new Map<string, AuctionEngine>();

export function getAuction(leagueId: string): AuctionEngine | undefined {
  return activeAuctions.get(leagueId);
}

export function startAuction(leagueId: string, state: AuctionStateRow): AuctionEngine {
  const existing = activeAuctions.get(leagueId);
  if (existing) existing.destroy();

  const engine = new AuctionEngine(state);
  activeAuctions.set(leagueId, engine);
  return engine;
}

export function removeAuction(leagueId: string) {
  const engine = activeAuctions.get(leagueId);
  if (engine) {
    engine.destroy();
    activeAuctions.delete(leagueId);
  }
}

// ---------- Recovery ----------

export async function recoverAuctions() {
  const activeRows = await db
    .select()
    .from(auctionState)
    .where(inArray(auctionState.status, ["nominating", "bidding", "paused"]));

  for (const row of activeRows) {
    const engine = startAuction(row.leagueId, row);
    const now = new Date();

    if (row.status === "bidding" && row.expiresAt) {
      if (row.expiresAt <= now) {
        console.log(`[auction] League ${row.leagueId}: settling expired auction`);
        engine.enqueue({ type: "settle", expectedExpiresAt: row.expiresAt });
      } else {
        const remainingMs = row.expiresAt.getTime() - now.getTime();
        console.log(`[auction] League ${row.leagueId}: resuming timer with ${remainingMs}ms remaining`);
        engine.restartSettleTimer(remainingMs, row.expiresAt);
      }
    } else if (row.status === "nominating") {
      console.log(`[auction] League ${row.leagueId}: restarting nomination timer`);
      engine.restartNominationTimer(row.nominationTimerSeconds * 1000);
    } else if (row.status === "paused") {
      console.log(`[auction] League ${row.leagueId}: auction is paused, no timers`);
    }
  }

  console.log(`[auction] Recovered ${activeRows.length} active auction(s)`);
}
