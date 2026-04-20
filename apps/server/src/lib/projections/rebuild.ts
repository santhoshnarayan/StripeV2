import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  league,
  leagueMember,
  nbaEventProjection,
  nbaGame,
  nbaPlay,
  nbaProjectionJob,
  rosterEntry,
  user,
} from "@repo/db";
import {
  DEFAULT_SIM_CONFIG,
  buildEventSnapshots,
  computeManagerProjections,
  runTournamentSim,
  type EventSnapshot,
  type GameMeta,
  type LiveGameState,
  type PlayEvent,
  type RosterInput,
  type SimData,
} from "@repo/sim";
import { loadActualsByGame } from "../sim/merge-playoff-minutes.js";

const SIM_COUNT_PER_EVENT = 2_000;

type RebuildMode = "full" | "incremental" | "actuals-only";

interface RebuildParams {
  leagueId: string;
  requestedByUserId: string | null;
  mode?: RebuildMode;
}

interface StaticSimData {
  bracket: SimData["bracket"];
  netRatings: SimData["netRatings"];
  simPlayers: SimData["simPlayers"];
  playoffMinutes: SimData["playoffMinutes"];
  adjustments: SimData["adjustments"];
  injuries: SimData["injuries"];
  actualsByGame: NonNullable<SimData["actualsByGame"]>;
}

let staticSimDataCache: StaticSimData | null = null;

async function loadStaticSimData(): Promise<StaticSimData> {
  if (staticSimDataCache) return staticSimDataCache;
  const dataDir = path.resolve(process.cwd(), "src/data");
  const [bracket, netRatings, simPlayers, playoffMinutes, adjustments, injuries] =
    await Promise.all([
      readFile(path.join(dataDir, "nba-bracket-2026.json"), "utf8"),
      readFile(path.join(dataDir, "nba-net-ratings-2026.json"), "utf8"),
      readFile(path.join(dataDir, "nba-players-2026.json"), "utf8"),
      readFile(path.join(dataDir, "nba-playoff-minutes-2026.json"), "utf8"),
      readFile(path.join(dataDir, "nba-adjustments-2026.json"), "utf8"),
      readFile(path.join(dataDir, "nba-injuries-2026.json"), "utf8"),
    ]);
  const actualsByGame = await loadActualsByGame(dataDir);
  staticSimDataCache = {
    bracket: JSON.parse(bracket),
    netRatings: JSON.parse(netRatings),
    simPlayers: JSON.parse(simPlayers),
    playoffMinutes: JSON.parse(playoffMinutes),
    adjustments: JSON.parse(adjustments),
    injuries: JSON.parse(injuries),
    actualsByGame,
  };
  return staticSimDataCache;
}

async function loadGames(): Promise<GameMeta[]> {
  const rows = await db
    .select({
      id: nbaGame.id,
      seriesKey: nbaGame.seriesKey,
      gameNum: nbaGame.gameNum,
      home: nbaGame.homeTeamAbbrev,
      away: nbaGame.awayTeamAbbrev,
      status: nbaGame.status,
    })
    .from(nbaGame)
    .where(sql`${nbaGame.seriesKey} is not null`)
    .orderBy(asc(nbaGame.date));

  if (rows.length === 0) return [];

  // The "terminal" play for a game is the one with the latest wallclock —
  // NOT max(sequence). ESPN sometimes appends correction/late plays with
  // higher sequence numbers but earlier wallclocks (e.g. seq 728-730 with
  // wc 19:35:58 after seq 727 "End of Game" with wc 19:46:15). Picking
  // max(sequence) marked games as "post" too early in chronological order.
  const allTerminalRows = await db
    .select({
      gameId: nbaPlay.gameId,
      sequenceNumber: nbaPlay.sequenceNumber,
      wallclock: nbaPlay.wallclock,
    })
    .from(nbaPlay)
    .where(inArray(nbaPlay.gameId, rows.map((r) => r.id)));
  const lastSeqByGame = new Map<string, number>();
  const bestByGame = new Map<string, { wc: number; seq: number }>();
  for (const p of allTerminalRows) {
    if (p.sequenceNumber == null) continue;
    const wc = p.wallclock ? p.wallclock.getTime() : 0;
    const cur = bestByGame.get(p.gameId);
    if (
      !cur ||
      wc > cur.wc ||
      (wc === cur.wc && p.sequenceNumber > cur.seq)
    ) {
      bestByGame.set(p.gameId, { wc, seq: p.sequenceNumber });
    }
  }
  for (const [gid, b] of bestByGame.entries()) {
    lastSeqByGame.set(gid, b.seq);
  }

  return rows
    .filter((r) => r.home && r.away)
    .map((r) => ({
      id: r.id,
      seriesKey: r.seriesKey,
      gameNum: r.gameNum,
      homeTeamAbbrev: r.home!,
      awayTeamAbbrev: r.away!,
      status: (r.status ?? "pre") as GameMeta["status"],
      lastPlaySequence: lastSeqByGame.get(r.id) ?? null,
    }));
}

async function loadPlays(gameIds: string[]): Promise<PlayEvent[]> {
  if (gameIds.length === 0) return [];
  const rows = await db
    .select()
    .from(nbaPlay)
    .where(inArray(nbaPlay.gameId, gameIds))
    .orderBy(asc(nbaPlay.updatedAt), asc(nbaPlay.gameId), asc(nbaPlay.sequenceNumber));
  return rows.map((r) => ({
    gameId: r.gameId,
    sequence: r.sequenceNumber ?? 0,
    period: r.periodNumber,
    clock: r.clockDisplay,
    updatedAt: r.updatedAt,
    wallclock: r.wallclock,
    scoringPlay: r.isScoringPlay === true,
    scoreValue: r.scoreValue,
    homeScore: r.homeScore,
    awayScore: r.awayScore,
    teamAbbrev: r.teamAbbrev,
    playerIds: Array.isArray(r.playerIds) ? (r.playerIds as string[]).map(String) : [],
    text: r.text,
  }));
}

async function loadRosters(leagueId: string): Promise<{
  rosters: RosterInput[];
  userNames: Map<string, string>;
}> {
  const rows = await db
    .select({
      userId: rosterEntry.userId,
      playerId: rosterEntry.playerId,
    })
    .from(rosterEntry)
    .where(eq(rosterEntry.leagueId, leagueId));

  const memberRows = await db
    .select({
      userId: leagueMember.userId,
    })
    .from(leagueMember)
    .where(
      and(eq(leagueMember.leagueId, leagueId), eq(leagueMember.status, "active")),
    );

  const userNames = new Map<string, string>();
  if (memberRows.length) {
    const nameRows = await db
      .select({ id: user.id, name: user.name, email: user.email })
      .from(user)
      .where(
        inArray(
          user.id,
          memberRows.map((m) => m.userId),
        ),
      );
    for (const r of nameRows) {
      userNames.set(r.id, r.name || r.email || r.id);
    }
  }

  const byUser = new Map<string, string[]>();
  for (const r of rows) {
    const arr = byUser.get(r.userId) ?? [];
    arr.push(r.playerId);
    byUser.set(r.userId, arr);
  }

  const rosters: RosterInput[] = memberRows.map((m) => ({
    userId: m.userId,
    name: userNames.get(m.userId) ?? m.userId,
    playerIds: byUser.get(m.userId) ?? [],
  }));

  return { rosters, userNames };
}

function rosterActualPoints(
  rosters: RosterInput[],
  cumulativePointsByPlayer: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rosters) {
    let total = 0;
    for (const pid of r.playerIds) {
      total += cumulativePointsByPlayer[pid] ?? 0;
    }
    out[r.userId] = total;
  }
  return out;
}

async function runSnapshotSim(
  baseSimData: StaticSimData,
  liveGames: LiveGameState[],
  rosters: RosterInput[],
) {
  const simData: SimData = {
    ...baseSimData,
    liveGames,
  };
  const results = await runTournamentSim(simData, {
    ...DEFAULT_SIM_CONFIG,
    sims: SIM_COUNT_PER_EVENT,
  });
  const projections = computeManagerProjections(results, rosters);
  const projByUser: Record<
    string,
    {
      mean: number;
      stddev: number;
      p10: number;
      p90: number;
      winProb: number;
    }
  > = {};
  for (const p of projections) {
    projByUser[p.userId] = {
      mean: p.mean,
      stddev: p.stddev,
      p10: p.p10,
      p90: p.p90,
      winProb: p.winProbability,
    };
  }
  return projByUser;
}

/** Cheap signature of a snapshot's *upstream* state: if anything before this
 *  point in the play stream changed (insert / delete / edit), `liveGames`
 *  shifts. So `(eventMeta, liveGames)` is a sufficient identity check.
 *  Used by reconciliation to find the first divergence. */
function snapshotSignature(snap: EventSnapshot): string {
  const meta = snapshotEventMeta(snap);
  const games = snap.liveGames.map((g) => [
    g.seriesKey,
    g.gameNum,
    g.status,
    g.homeScore,
    g.awayScore,
    Math.round(g.remainingFraction * 1000) / 1000,
  ]);
  return JSON.stringify([meta, games]);
}

/** Mirror of snapshotSignature, computed from a stored row. */
function rowSignature(row: {
  eventMeta: unknown;
  gamesSnapshot: unknown;
}): string {
  const games = (row.gamesSnapshot as Array<{
    seriesKey: string;
    gameNum: number;
    status: string;
    homeScore: number;
    awayScore: number;
    remainingFraction: number;
  }> | null) ?? [];
  return JSON.stringify([
    row.eventMeta ?? null,
    games.map((g) => [
      g.seriesKey,
      g.gameNum,
      g.status,
      g.homeScore,
      g.awayScore,
      Math.round(g.remainingFraction * 1000) / 1000,
    ]),
  ]);
}

/** Walk current snapshots vs stored projections in chronological order and
 *  return the index of the first divergence (or snapshots.length if all match
 *  through the existing tail). Divergence triggers truncate-and-rebuild from
 *  that point forward.
 *
 *  Algorithm covers all three reconciliation cases:
 *    - play inserted upstream: stored row's liveGames signature mismatches
 *    - play deleted upstream: stored (gameId, sequence) no longer present
 *    - play edited: eventMeta differs
 */
async function findFirstDivergence(
  leagueId: string,
  snapshots: EventSnapshot[],
): Promise<{ firstStaleIndex: number; staleKeys: Set<string> }> {
  const stored = await db
    .select({
      gameId: nbaEventProjection.gameId,
      sequence: nbaEventProjection.sequence,
      eventMeta: nbaEventProjection.eventMeta,
      gamesSnapshot: nbaEventProjection.gamesSnapshot,
    })
    .from(nbaEventProjection)
    .where(eq(nbaEventProjection.leagueId, leagueId));
  const byKey = new Map<string, (typeof stored)[number]>();
  for (const r of stored) byKey.set(`${r.gameId}|${r.sequence}`, r);

  let firstStaleIndex = snapshots.length;
  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    const key = `${snap.event.gameId}|${snap.event.sequence}`;
    const row = byKey.get(key);
    if (!row) {
      // New snapshot — divergence from this point. (Even though *this* row
      // is just missing, an earlier insert/edit may have shifted `liveGames`
      // for later rows that DO exist, so we still rebuild forward.)
      firstStaleIndex = i;
      break;
    }
    if (rowSignature(row) !== snapshotSignature(snap)) {
      firstStaleIndex = i;
      break;
    }
  }

  // Anything stored whose key is not in the current snapshot set, OR whose
  // index falls at/after firstStaleIndex, is stale.
  const currentKeysAfterDivergence = new Set<string>();
  for (let i = firstStaleIndex; i < snapshots.length; i++) {
    const snap = snapshots[i];
    currentKeysAfterDivergence.add(`${snap.event.gameId}|${snap.event.sequence}`);
  }
  const currentAllKeys = new Set(
    snapshots.map((s) => `${s.event.gameId}|${s.event.sequence}`),
  );
  const staleKeys = new Set<string>();
  for (const key of byKey.keys()) {
    if (!currentAllKeys.has(key) || currentKeysAfterDivergence.has(key)) {
      staleKeys.add(key);
    }
  }
  return { firstStaleIndex, staleKeys };
}

async function deleteProjectionKeys(
  leagueId: string,
  keys: Iterable<string>,
): Promise<void> {
  const byGame = new Map<string, number[]>();
  for (const k of keys) {
    const [gameId, seqStr] = k.split("|");
    const arr = byGame.get(gameId) ?? [];
    arr.push(Number(seqStr));
    byGame.set(gameId, arr);
  }
  for (const [gameId, seqs] of byGame.entries()) {
    if (seqs.length === 0) continue;
    await db
      .delete(nbaEventProjection)
      .where(
        and(
          eq(nbaEventProjection.leagueId, leagueId),
          eq(nbaEventProjection.gameId, gameId),
          inArray(nbaEventProjection.sequence, seqs),
        ),
      );
  }
}

// ─── Public API ────────────────────────────────────────────────────

/** Create a queued job row and kick off processing in the background. */
export async function enqueueProjectionRebuild(
  params: RebuildParams,
): Promise<string> {
  const jobId = randomUUID();
  await db.insert(nbaProjectionJob).values({
    id: jobId,
    leagueId: params.leagueId,
    status: "queued",
    processedEvents: 0,
    requestedByUserId: params.requestedByUserId,
  });

  // Fire and forget — bound by the static sim data cache, so we just do work.
  void runProjectionRebuild(jobId, params).catch(async (err) => {
    console.error("[projections] rebuild failed", { jobId, err });
    try {
      await db
        .update(nbaProjectionJob)
        .set({
          status: "failed",
          lastError: err instanceof Error ? err.message : String(err),
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(nbaProjectionJob.id, jobId));
    } catch {
      /* swallow */
    }
  });

  return jobId;
}

/** Jobs older than this with status queued/running are presumed dead (process
 *  crashed or restarted mid-rebuild). The auto-trigger will ignore them so
 *  fresh rebuilds can be enqueued without manual intervention. */
const ZOMBIE_JOB_THRESHOLD_MS = 15 * 60 * 1000;

/** Returns true if this league has a queued or running rebuild job younger
 *  than the zombie threshold. Used by the live-update auto-trigger to coalesce
 *  ingest bursts (we don't want to start a fresh sim every cron tick if the
 *  previous one is still running) — but stale jobs from a crashed/restarted
 *  process are ignored so the auto-trigger self-heals. */
async function hasInFlightRebuild(leagueId: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - ZOMBIE_JOB_THRESHOLD_MS);
  const rows = await db
    .select({ id: nbaProjectionJob.id })
    .from(nbaProjectionJob)
    .where(
      and(
        eq(nbaProjectionJob.leagueId, leagueId),
        inArray(nbaProjectionJob.status, ["queued", "running"]),
        sql`${nbaProjectionJob.updatedAt} >= ${cutoff}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** On server boot, mark any queued/running rebuild jobs as failed so the
 *  auto-trigger isn't blocked by zombie rows from a previous process. The
 *  staleness guard inside hasInFlightRebuild also handles this defensively,
 *  but explicit cleanup keeps the job table tidy. */
export async function recoverProjectionJobs(): Promise<number> {
  const result = await db
    .update(nbaProjectionJob)
    .set({
      status: "failed",
      lastError: "process restarted before completion",
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(inArray(nbaProjectionJob.status, ["queued", "running"]))
    .returning({ id: nbaProjectionJob.id });
  return result.length;
}

/** Auto-triggered from the live-ingest cron after a syncLiveGames batch.
 *  Enqueues an incremental rebuild for every active league, but only if no
 *  job is already in flight for that league. The reconciliation step inside
 *  runProjectionRebuild handles play inserts/edits/deletes correctly without
 *  needing a hint about *which* play changed. */
export async function autoTriggerLiveRebuilds(): Promise<{
  enqueued: number;
  skipped: number;
}> {
  const leagues = await db
    .select({ id: league.id, phase: league.phase })
    .from(league);
  let enqueued = 0;
  let skipped = 0;
  for (const lg of leagues) {
    // "drafting" / "complete" leagues still want live updates during playoffs
    // — only filter out leagues that haven't started.
    if (lg.phase === "invite") {
      skipped++;
      continue;
    }
    if (await hasInFlightRebuild(lg.id)) {
      skipped++;
      continue;
    }
    await enqueueProjectionRebuild({
      leagueId: lg.id,
      requestedByUserId: null,
      mode: "incremental",
    });
    enqueued++;
  }
  return { enqueued, skipped };
}

async function runProjectionRebuild(
  jobId: string,
  params: RebuildParams,
): Promise<void> {
  const leagueRow = await db
    .select()
    .from(league)
    .where(eq(league.id, params.leagueId))
    .limit(1);
  if (leagueRow.length === 0) throw new Error(`league not found: ${params.leagueId}`);

  await db
    .update(nbaProjectionJob)
    .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
    .where(eq(nbaProjectionJob.id, jobId));

  const baseSimData = await loadStaticSimData();
  const games = await loadGames();
  const plays = await loadPlays(games.map((g) => g.id));
  const snapshots = buildEventSnapshots({ games, plays });
  const { rosters } = await loadRosters(params.leagueId);

  const mode = params.mode ?? "incremental";

  await db
    .update(nbaProjectionJob)
    .set({ totalEvents: snapshots.length, updatedAt: new Date() })
    .where(eq(nbaProjectionJob.id, jobId));

  if (mode === "actuals-only") {
    // Fast path: recompute only actualPoints + cumulative metadata for every
    // event. Skip Monte Carlo entirely. Used after a fix to the snapshot
    // builder (e.g. wallclock sort change) where projections are still valid
    // but actuals need to be refreshed. Orders of magnitude faster than full.
    let processed = 0;
    for (const snap of snapshots) {
      const actualPoints = rosterActualPoints(rosters, snap.cumulativePointsByPlayer);
      await db
        .update(nbaEventProjection)
        .set({
          actualPoints,
          eventMeta: snapshotEventMeta(snap),
          gamesSnapshot: snap.liveGames,
          computedAt: new Date(),
        })
        .where(
          and(
            eq(nbaEventProjection.leagueId, params.leagueId),
            eq(nbaEventProjection.gameId, snap.event.gameId),
            eq(nbaEventProjection.sequence, snap.event.sequence),
          ),
        );
      processed++;
      if (processed % 50 === 0) {
        await db
          .update(nbaProjectionJob)
          .set({ processedEvents: processed, updatedAt: new Date() })
          .where(eq(nbaProjectionJob.id, jobId));
      }
    }
    await db
      .update(nbaProjectionJob)
      .set({
        processedEvents: processed,
        status: "completed",
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(nbaProjectionJob.id, jobId));
    return;
  }

  if (mode === "full") {
    // Atomic replace: compute every projection row first (slow Monte Carlo
    // work happens outside of any transaction), then DELETE + bulk INSERT
    // inside a single transaction. Readers see either the full old table
    // or the full new table — never a half-rebuilt chart.
    const computed: Array<Awaited<ReturnType<typeof buildSnapshotRow>>> = [];
    let processed = 0;
    for (const snap of snapshots) {
      computed.push(await buildSnapshotRow(params.leagueId, snap, rosters, baseSimData));
      processed++;
      if (processed % 10 === 0) {
        await db
          .update(nbaProjectionJob)
          .set({ processedEvents: processed, updatedAt: new Date() })
          .where(eq(nbaProjectionJob.id, jobId));
      }
    }

    await db.transaction(async (tx) => {
      await tx
        .delete(nbaEventProjection)
        .where(eq(nbaEventProjection.leagueId, params.leagueId));
      for (let i = 0; i < computed.length; i += 100) {
        const batch = computed.slice(i, i + 100);
        if (batch.length > 0) await tx.insert(nbaEventProjection).values(batch);
      }
    });

    await db
      .update(nbaProjectionJob)
      .set({
        processedEvents: processed,
        status: "completed",
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(nbaProjectionJob.id, jobId));
    return;
  }

  // Incremental + reconciliation:
  //   1. Walk snapshots vs stored rows. Find first divergence (insert /
  //      delete / edit upstream).
  //   2. Drop all stored rows from the divergence point forward, plus any
  //      orphaned (gameId, sequence) keys no longer in the snapshot set.
  //   3. Re-run sims for snapshots[firstStaleIndex..end] only. Anything
  //      before is bit-identical so we trust the cache.
  const { firstStaleIndex, staleKeys } = await findFirstDivergence(
    params.leagueId,
    snapshots,
  );
  if (staleKeys.size > 0) await deleteProjectionKeys(params.leagueId, staleKeys);

  let processed = firstStaleIndex; // earlier snapshots count as "already done"
  await db
    .update(nbaProjectionJob)
    .set({ processedEvents: processed, updatedAt: new Date() })
    .where(eq(nbaProjectionJob.id, jobId));

  for (let i = firstStaleIndex; i < snapshots.length; i++) {
    await processSnapshot(params.leagueId, snapshots[i], rosters, baseSimData);
    processed++;
    if (processed % 10 === 0) {
      await db
        .update(nbaProjectionJob)
        .set({ processedEvents: processed, updatedAt: new Date() })
        .where(eq(nbaProjectionJob.id, jobId));
    }
  }

  await db
    .update(nbaProjectionJob)
    .set({
      processedEvents: processed,
      status: "completed",
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(nbaProjectionJob.id, jobId));
}

function snapshotEventMeta(snap: EventSnapshot) {
  return {
    text: snap.event.text,
    teamAbbrev: snap.event.teamAbbrev,
    playerIds: snap.event.playerIds,
    scoreValue: snap.event.scoreValue,
    period: snap.event.period,
    clock: snap.event.clock,
    homeScore: snap.event.homeScore,
    awayScore: snap.event.awayScore,
    wallclock: snap.event.wallclock ? snap.event.wallclock.toISOString() : null,
  };
}

async function buildSnapshotRow(
  leagueId: string,
  snap: EventSnapshot,
  rosters: RosterInput[],
  baseSimData: StaticSimData,
) {
  const actualPoints = rosterActualPoints(rosters, snap.cumulativePointsByPlayer);
  const projectedPoints = await runSnapshotSim(baseSimData, snap.liveGames, rosters);
  return {
    leagueId,
    gameId: snap.event.gameId,
    sequence: snap.event.sequence,
    updatedAtEvent: snap.event.updatedAt,
    kind: snap.event.kind,
    actualPoints,
    projectedPoints,
    eventMeta: snapshotEventMeta(snap),
    gamesSnapshot: snap.liveGames,
    simCount: SIM_COUNT_PER_EVENT,
  };
}

async function processSnapshot(
  leagueId: string,
  snap: EventSnapshot,
  rosters: RosterInput[],
  baseSimData: StaticSimData,
): Promise<void> {
  const row = await buildSnapshotRow(leagueId, snap, rosters, baseSimData);
  await db
    .insert(nbaEventProjection)
    .values(row)
    .onConflictDoUpdate({
      target: [
        nbaEventProjection.leagueId,
        nbaEventProjection.gameId,
        nbaEventProjection.sequence,
      ],
      set: {
        updatedAtEvent: row.updatedAtEvent,
        kind: row.kind,
        actualPoints: row.actualPoints,
        projectedPoints: row.projectedPoints,
        eventMeta: row.eventMeta,
        gamesSnapshot: row.gamesSnapshot,
        simCount: row.simCount,
        computedAt: new Date(),
      },
    });
}
