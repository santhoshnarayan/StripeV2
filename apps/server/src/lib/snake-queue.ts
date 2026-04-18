import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  snakeState,
  leagueAction,
  rosterEntry,
  league,
} from "@repo/db";
import type { SSEStreamingApi } from "hono/streaming";
import { getPlayerPoolForAuction } from "./player-pool.js";

// ---------- Types ----------

type SnakeStateRow = typeof snakeState.$inferSelect;
type TransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type SnakeEvent =
  | { type: "pick"; userId: string; playerId: string; playerName: string; playerTeam: string }
  | { type: "pick_timeout"; expectedExpiresAt: Date }
  | { type: "pause"; actorUserId: string }
  | { type: "resume"; actorUserId: string }
  | { type: "undo_pick"; actorUserId: string; playerId?: string }
  | { type: "end"; actorUserId: string };

export type EventResult =
  | { ok: true; outcome: string; data?: Record<string, unknown> }
  | { ok: false; error: string };

type QueueEntry = {
  event: SnakeEvent;
  resolve: (r: EventResult) => void;
  reject: (e: Error) => void;
};

// ---------- Helpers ----------

async function nextSequenceNumber(tx: TransactionClient, leagueId: string): Promise<number> {
  const result = await tx
    .select({ maxSeq: sql<number>`COALESCE(MAX(${leagueAction.sequenceNumber}), 0)` })
    .from(leagueAction)
    .where(eq(leagueAction.leagueId, leagueId));
  return (result[0]?.maxSeq ?? 0) + 1;
}

export function generateSnakeOrder(orderedUserIds: string[], totalRounds: number): string[] {
  const pickOrder: string[] = [];
  for (let round = 0; round < totalRounds; round++) {
    if (round % 2 === 0) {
      pickOrder.push(...orderedUserIds);
    } else {
      pickOrder.push(...[...orderedUserIds].reverse());
    }
  }
  return pickOrder;
}

// ---------- SnakeEngine ----------

export class SnakeEngine {
  private queue: QueueEntry[] = [];
  private processing = false;
  private pickTimer: ReturnType<typeof setTimeout> | null = null;
  private sseClients = new Set<SSEStreamingApi>();
  private state: SnakeStateRow;

  constructor(initialState: SnakeStateRow) {
    this.state = initialState;
  }

  // --- Public API ---

  async enqueue(event: SnakeEvent): Promise<EventResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ event, resolve, reject });
      this.drain();
    });
  }

  getStateSnapshot(): Record<string, unknown> {
    return {
      status: this.state.status,
      timed: this.state.timed,
      pickTimerSeconds: this.state.pickTimerSeconds,
      pickOrder: this.state.pickOrder,
      currentPickIndex: this.state.currentPickIndex,
      currentPickerUserId: this.state.currentPickerUserId,
      totalPicks: this.state.totalPicks,
      currentRound: this.state.currentRound,
      totalRounds: this.state.totalRounds,
      expiresAt: this.state.expiresAt?.toISOString() ?? null,
      leagueId: this.state.leagueId,
    };
  }

  addClient(stream: SSEStreamingApi) {
    this.sseClients.add(stream);
  }

  removeClient(stream: SSEStreamingApi) {
    this.sseClients.delete(stream);
  }

  restartPickTimer(delayMs: number, expectedExpiresAt: Date) {
    this.clearPickTimer();
    this.pickTimer = setTimeout(() => {
      this.enqueue({ type: "pick_timeout", expectedExpiresAt });
    }, delayMs);
  }

  destroy() {
    this.clearPickTimer();
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

  private async processEvent(event: SnakeEvent): Promise<EventResult> {
    switch (event.type) {
      case "pick":
        return this.handlePick(event);
      case "pick_timeout":
        return this.handlePickTimeout(event);
      case "pause":
        return this.handlePause(event);
      case "resume":
        return this.handleResume(event);
      case "undo_pick":
        return this.handleUndoPick(event);
      case "end":
        return this.handleEnd(event);
    }
  }

  // --- Event handlers ---

  private async handlePick(event: Extract<SnakeEvent, { type: "pick" }>): Promise<EventResult> {
    if (this.state.status !== "picking") {
      return { ok: false, error: "Not in picking phase" };
    }
    if (event.userId !== this.state.currentPickerUserId) {
      return { ok: false, error: "Not your turn to pick" };
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

    // Get league config for minBid
    const leagueRows = await db.select().from(league).where(eq(league.id, this.state.leagueId)).limit(1);
    if (leagueRows.length === 0) return { ok: false, error: "League not found" };
    const leagueRow = leagueRows[0];

    const now = new Date();
    const pickOrder = this.state.pickOrder as string[];
    const memberCount = new Set(pickOrder).size;
    const pickIndex = this.state.currentPickIndex;
    const round = Math.floor(pickIndex / memberCount) + 1;

    // Count existing roster entries for acquisition order
    const rosterCount = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(rosterEntry)
      .where(and(eq(rosterEntry.leagueId, this.state.leagueId), eq(rosterEntry.userId, event.userId)));
    const acquisitionOrder = (rosterCount[0]?.count ?? 0) + 1;

    await db.transaction(async (tx) => {
      await tx.insert(rosterEntry).values({
        id: randomUUID(),
        leagueId: this.state.leagueId,
        userId: event.userId,
        playerId: event.playerId,
        playerName: event.playerName,
        playerTeam: event.playerTeam,
        acquisitionOrder,
        acquisitionBid: leagueRow.minBid,
        createdAt: now,
        updatedAt: now,
      });

      const seq = await nextSequenceNumber(tx, this.state.leagueId);
      await tx.insert(leagueAction).values({
        id: randomUUID(),
        leagueId: this.state.leagueId,
        type: "snake_pick",
        userId: event.userId,
        playerId: event.playerId,
        amount: leagueRow.minBid,
        actorUserId: event.userId,
        sequenceNumber: seq,
        metadata: { playerName: event.playerName, playerTeam: event.playerTeam, pickIndex, round },
        createdAt: now,
      });

      await tx
        .update(snakeState)
        .set({ totalPicks: this.state.totalPicks + 1, updatedAt: now })
        .where(eq(snakeState.id, this.state.id));
    });

    this.state.totalPicks += 1;
    this.clearPickTimer();

    this.broadcast("pick", {
      playerId: event.playerId,
      playerName: event.playerName,
      playerTeam: event.playerTeam,
      pickerUserId: event.userId,
      pickIndex,
      round,
    });

    await this.advanceToNextPick();

    return { ok: true, outcome: "picked", data: { playerId: event.playerId, playerName: event.playerName } };
  }

  private async handlePickTimeout(event: Extract<SnakeEvent, { type: "pick_timeout" }>): Promise<EventResult> {
    // Stale check
    if (
      this.state.status !== "picking" ||
      !this.state.expiresAt ||
      event.expectedExpiresAt.getTime() !== this.state.expiresAt.getTime()
    ) {
      return { ok: true, outcome: "stale_pick_timeout" };
    }

    // Get league config
    const leagueRows = await db.select().from(league).where(eq(league.id, this.state.leagueId)).limit(1);
    if (leagueRows.length === 0) return { ok: false, error: "League not found" };
    const leagueRow = leagueRows[0];

    const pickOrder = this.state.pickOrder as string[];
    const memberCount = new Set(pickOrder).size;
    const pickIndex = this.state.currentPickIndex;
    const round = Math.floor(pickIndex / memberCount) + 1;
    const pickerUserId = this.state.currentPickerUserId!;

    // Find best available player
    const rosteredPlayers = await db
      .select({ playerId: rosterEntry.playerId })
      .from(rosterEntry)
      .where(eq(rosterEntry.leagueId, this.state.leagueId));
    const rosteredIds = new Set(rosteredPlayers.map((r) => r.playerId));

    const players = await getPlayerPoolForAuction({
      managers: memberCount,
      rosterSize: leagueRow.rosterSize,
      budgetPerTeam: leagueRow.budgetPerTeam,
      minBid: leagueRow.minBid,
    });

    const bestAvailable = players.find((p) => !rosteredIds.has(p.id));

    if (!bestAvailable) {
      // No players available, skip this pick
      const now = new Date();
      await db.transaction(async (tx) => {
        const seq = await nextSequenceNumber(tx, this.state.leagueId);
        await tx.insert(leagueAction).values({
          id: randomUUID(),
          leagueId: this.state.leagueId,
          type: "snake_auto_pick",
          userId: pickerUserId,
          sequenceNumber: seq,
          metadata: { pickIndex, round, reason: "timeout_no_players" },
          createdAt: now,
        });
      });

      this.broadcast("auto_pick", { pickIndex, round, skipped: true, reason: "no_players_available" });
      await this.advanceToNextPick();
      return { ok: true, outcome: "skipped_no_players" };
    }

    // Auto-pick the best available player
    const now = new Date();
    const rosterCount = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(rosterEntry)
      .where(and(eq(rosterEntry.leagueId, this.state.leagueId), eq(rosterEntry.userId, pickerUserId)));
    const acquisitionOrder = (rosterCount[0]?.count ?? 0) + 1;

    await db.transaction(async (tx) => {
      await tx.insert(rosterEntry).values({
        id: randomUUID(),
        leagueId: this.state.leagueId,
        userId: pickerUserId,
        playerId: bestAvailable.id,
        playerName: bestAvailable.name,
        playerTeam: bestAvailable.team,
        acquisitionOrder,
        acquisitionBid: leagueRow.minBid,
        isAutoAssigned: true,
        createdAt: now,
        updatedAt: now,
      });

      const seq = await nextSequenceNumber(tx, this.state.leagueId);
      await tx.insert(leagueAction).values({
        id: randomUUID(),
        leagueId: this.state.leagueId,
        type: "snake_auto_pick",
        userId: pickerUserId,
        playerId: bestAvailable.id,
        amount: leagueRow.minBid,
        actorUserId: pickerUserId,
        sequenceNumber: seq,
        metadata: { playerName: bestAvailable.name, playerTeam: bestAvailable.team, pickIndex, round, reason: "timeout" },
        createdAt: now,
      });

      await tx
        .update(snakeState)
        .set({ totalPicks: this.state.totalPicks + 1, updatedAt: now })
        .where(eq(snakeState.id, this.state.id));
    });

    this.state.totalPicks += 1;

    this.broadcast("auto_pick", {
      playerId: bestAvailable.id,
      playerName: bestAvailable.name,
      playerTeam: bestAvailable.team,
      pickerUserId,
      pickIndex,
      round,
    });

    await this.advanceToNextPick();

    return { ok: true, outcome: "auto_picked", data: { playerId: bestAvailable.id, playerName: bestAvailable.name } };
  }

  private async handlePause(event: Extract<SnakeEvent, { type: "pause" }>): Promise<EventResult> {
    if (!this.state.timed) {
      return { ok: false, error: "Cannot pause an untimed draft" };
    }
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
        type: "snake_pause",
        actorUserId: event.actorUserId,
        sequenceNumber: seq,
        metadata: {},
        createdAt: now,
      });
      await tx
        .update(snakeState)
        .set({
          status: "paused",
          statusBeforePause: statusBefore,
          pausedAt: now,
          updatedAt: now,
        })
        .where(eq(snakeState.id, this.state.id));
    });

    this.state.status = "paused";
    this.state.statusBeforePause = statusBefore;
    this.state.pausedAt = now;

    this.clearPickTimer();

    this.broadcast("pause", { pausedAt: now.toISOString() });

    return { ok: true, outcome: "paused" };
  }

  private async handleResume(event: Extract<SnakeEvent, { type: "resume" }>): Promise<EventResult> {
    if (this.state.status !== "paused") {
      return { ok: false, error: "Draft is not paused" };
    }

    const now = new Date();
    const restoredStatus = this.state.statusBeforePause ?? "picking";
    const expiresAt = new Date(now.getTime() + this.state.pickTimerSeconds * 1000);

    await db.transaction(async (tx) => {
      const seq = await nextSequenceNumber(tx, this.state.leagueId);
      await tx.insert(leagueAction).values({
        id: randomUUID(),
        leagueId: this.state.leagueId,
        type: "snake_resume",
        actorUserId: event.actorUserId,
        sequenceNumber: seq,
        metadata: {},
        createdAt: now,
      });
      await tx
        .update(snakeState)
        .set({
          status: restoredStatus,
          statusBeforePause: null,
          pausedAt: null,
          expiresAt,
          updatedAt: now,
        })
        .where(eq(snakeState.id, this.state.id));
    });

    this.state.status = restoredStatus;
    this.state.statusBeforePause = null;
    this.state.pausedAt = null;
    this.state.expiresAt = expiresAt;

    this.restartPickTimer(this.state.pickTimerSeconds * 1000, expiresAt);

    this.broadcast("resume", {
      status: restoredStatus,
      expiresAt: expiresAt.toISOString(),
    });

    return { ok: true, outcome: "resumed" };
  }

  private async handleUndoPick(event: Extract<SnakeEvent, { type: "undo_pick" }>): Promise<EventResult> {
    let targetPlayerId = event.playerId;

    if (!targetPlayerId) {
      // Undo latest pick
      const latestPick = await db
        .select()
        .from(leagueAction)
        .where(
          and(
            eq(leagueAction.leagueId, this.state.leagueId),
            inArray(leagueAction.type, ["snake_pick", "snake_auto_pick"]),
          ),
        )
        .orderBy(sql`${leagueAction.sequenceNumber} DESC`)
        .limit(1);

      if (latestPick.length === 0) {
        return { ok: false, error: "No picks to undo" };
      }
      targetPlayerId = latestPick[0].playerId!;
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

    // Check if this is the most recent pick (for rewind logic)
    const latestPick = await db
      .select()
      .from(leagueAction)
      .where(
        and(
          eq(leagueAction.leagueId, this.state.leagueId),
          inArray(leagueAction.type, ["snake_pick", "snake_auto_pick"]),
        ),
      )
      .orderBy(sql`${leagueAction.sequenceNumber} DESC`)
      .limit(1);

    const isLatestPick = latestPick.length > 0 && latestPick[0].playerId === targetPlayerId;

    await db.transaction(async (tx) => {
      await tx.delete(rosterEntry).where(eq(rosterEntry.id, rosterRow.id));

      const seq = await nextSequenceNumber(tx, this.state.leagueId);
      await tx.insert(leagueAction).values({
        id: randomUUID(),
        leagueId: this.state.leagueId,
        type: "snake_undo_pick",
        userId: rosterRow.userId,
        playerId: targetPlayerId,
        amount: -rosterRow.acquisitionBid,
        actorUserId: event.actorUserId,
        sequenceNumber: seq,
        metadata: { playerName: rosterRow.playerName },
        createdAt: now,
      });

      const newTotalPicks = Math.max(0, this.state.totalPicks - 1);
      const updates: Record<string, unknown> = {
        totalPicks: newTotalPicks,
        updatedAt: now,
      };

      // If undoing the most recent pick, rewind to let the same drafter repick
      if (isLatestPick && this.state.currentPickIndex > 0) {
        const pickOrder = this.state.pickOrder as string[];
        const prevIndex = this.state.currentPickIndex - 1;
        const memberCount = new Set(pickOrder).size;
        updates.currentPickIndex = prevIndex;
        updates.currentPickerUserId = pickOrder[prevIndex];
        updates.currentRound = Math.floor(prevIndex / memberCount) + 1;
        if (this.state.timed) {
          const expiresAt = new Date(now.getTime() + this.state.pickTimerSeconds * 1000);
          updates.expiresAt = expiresAt;
        }
      }

      await tx.update(snakeState).set(updates).where(eq(snakeState.id, this.state.id));

      // Update in-memory state
      this.state.totalPicks = newTotalPicks;
      if (isLatestPick && this.state.currentPickIndex > 0) {
        const pickOrder = this.state.pickOrder as string[];
        const prevIndex = this.state.currentPickIndex - 1;
        const memberCount = new Set(pickOrder).size;
        this.state.currentPickIndex = prevIndex;
        this.state.currentPickerUserId = pickOrder[prevIndex];
        this.state.currentRound = Math.floor(prevIndex / memberCount) + 1;
        if (this.state.timed) {
          this.state.expiresAt = new Date(now.getTime() + this.state.pickTimerSeconds * 1000);
          this.clearPickTimer();
          this.restartPickTimer(this.state.pickTimerSeconds * 1000, this.state.expiresAt);
        }
      }
    });

    this.broadcast("undo_pick", {
      playerId: targetPlayerId,
      playerName: rosterRow.playerName,
      userId: rosterRow.userId,
      rewound: isLatestPick,
      currentPickerUserId: this.state.currentPickerUserId,
      currentPickIndex: this.state.currentPickIndex,
      expiresAt: this.state.expiresAt?.toISOString() ?? null,
    });

    return { ok: true, outcome: "pick_undone", data: { playerId: targetPlayerId, playerName: rosterRow.playerName } };
  }

  private async handleEnd(event: Extract<SnakeEvent, { type: "end" }>): Promise<EventResult> {
    if (this.state.status === "completed") {
      return { ok: false, error: "Draft already ended" };
    }

    await this.completeDraft("commissioner_ended", event.actorUserId);
    return { ok: true, outcome: "ended" };
  }

  // --- Internal helpers ---

  private async advanceToNextPick() {
    const pickOrder = this.state.pickOrder as string[];
    const nextIndex = this.state.currentPickIndex + 1;

    if (nextIndex >= pickOrder.length) {
      await this.completeDraft("complete");
      return;
    }

    const nextPicker = pickOrder[nextIndex];
    const memberCount = new Set(pickOrder).size;
    const nextRound = Math.floor(nextIndex / memberCount) + 1;
    const now = new Date();

    let expiresAt: Date | null = null;
    if (this.state.timed) {
      expiresAt = new Date(now.getTime() + this.state.pickTimerSeconds * 1000);
    }

    await db
      .update(snakeState)
      .set({
        currentPickIndex: nextIndex,
        currentPickerUserId: nextPicker,
        currentRound: nextRound,
        expiresAt,
        updatedAt: now,
      })
      .where(eq(snakeState.id, this.state.id));

    this.state.currentPickIndex = nextIndex;
    this.state.currentPickerUserId = nextPicker;
    this.state.currentRound = nextRound;
    this.state.expiresAt = expiresAt;

    if (this.state.timed && expiresAt) {
      this.restartPickTimer(this.state.pickTimerSeconds * 1000, expiresAt);
    }

    this.broadcast("next_pick", {
      pickerUserId: nextPicker,
      pickIndex: nextIndex,
      round: nextRound,
      expiresAt: expiresAt?.toISOString() ?? null,
    });
  }

  private async completeDraft(reason: string, actorUserId?: string) {
    const now = new Date();

    await db.transaction(async (tx) => {
      const seq = await nextSequenceNumber(tx, this.state.leagueId);
      await tx.insert(leagueAction).values({
        id: randomUUID(),
        leagueId: this.state.leagueId,
        type: "snake_end",
        actorUserId: actorUserId ?? null,
        sequenceNumber: seq,
        metadata: { reason, totalPicks: this.state.totalPicks },
        createdAt: now,
      });

      await tx
        .update(snakeState)
        .set({ status: "completed", updatedAt: now })
        .where(eq(snakeState.id, this.state.id));

      await tx
        .update(league)
        .set({ phase: "scoring", updatedAt: now })
        .where(eq(league.id, this.state.leagueId));
    });

    this.state.status = "completed";
    this.clearPickTimer();

    this.broadcast("end", { reason, totalPicks: this.state.totalPicks });

    removeSnakeDraft(this.state.leagueId);
  }

  private broadcast(eventName: string, data: Record<string, unknown>) {
    const payload = JSON.stringify(data);
    for (const client of this.sseClients) {
      client.writeSSE({ event: eventName, data: payload }).catch(() => {
        this.sseClients.delete(client);
      });
    }
  }

  private clearPickTimer() {
    if (this.pickTimer) {
      clearTimeout(this.pickTimer);
      this.pickTimer = null;
    }
  }
}

// ---------- Registry ----------

const activeSnakeDrafts = new Map<string, SnakeEngine>();

export function getSnakeDraft(leagueId: string): SnakeEngine | undefined {
  return activeSnakeDrafts.get(leagueId);
}

export function startSnakeDraft(leagueId: string, state: SnakeStateRow): SnakeEngine {
  const existing = activeSnakeDrafts.get(leagueId);
  if (existing) existing.destroy();

  const engine = new SnakeEngine(state);
  activeSnakeDrafts.set(leagueId, engine);
  return engine;
}

export function removeSnakeDraft(leagueId: string) {
  const engine = activeSnakeDrafts.get(leagueId);
  if (engine) {
    engine.destroy();
    activeSnakeDrafts.delete(leagueId);
  }
}

// ---------- Recovery ----------

export async function recoverSnakeDrafts() {
  const activeRows = await db
    .select()
    .from(snakeState)
    .where(inArray(snakeState.status, ["picking", "paused"]));

  for (const row of activeRows) {
    const engine = startSnakeDraft(row.leagueId, row);
    const now = new Date();

    if (row.status === "picking" && row.timed && row.expiresAt) {
      if (row.expiresAt <= now) {
        console.log(`[snake] League ${row.leagueId}: auto-picking expired turn`);
        engine.enqueue({ type: "pick_timeout", expectedExpiresAt: row.expiresAt });
      } else {
        const remainingMs = row.expiresAt.getTime() - now.getTime();
        console.log(`[snake] League ${row.leagueId}: resuming timer with ${remainingMs}ms remaining`);
        engine.restartPickTimer(remainingMs, row.expiresAt);
      }
    } else if (row.status === "picking" && !row.timed) {
      console.log(`[snake] League ${row.leagueId}: untimed draft, no timers`);
    } else if (row.status === "paused") {
      console.log(`[snake] League ${row.leagueId}: draft is paused, no timers`);
    }
  }

  console.log(`[snake] Recovered ${activeRows.length} active snake draft(s)`);
}
