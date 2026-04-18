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
  staticSimDataCache = {
    bracket: JSON.parse(bracket),
    netRatings: JSON.parse(netRatings),
    simPlayers: JSON.parse(simPlayers),
    playoffMinutes: JSON.parse(playoffMinutes),
    adjustments: JSON.parse(adjustments),
    injuries: JSON.parse(injuries),
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

  const lastSeqRows = await db
    .select({
      gameId: nbaPlay.gameId,
      lastSeq: sql<number>`max(${nbaPlay.sequenceNumber})`,
    })
    .from(nbaPlay)
    .where(
      inArray(
        nbaPlay.gameId,
        rows.map((r) => r.id),
      ),
    )
    .groupBy(nbaPlay.gameId);
  const lastSeqByGame = new Map(lastSeqRows.map((r) => [r.gameId, r.lastSeq]));

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

async function loadExistingProjectionKeys(
  leagueId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({
      gameId: nbaEventProjection.gameId,
      sequence: nbaEventProjection.sequence,
    })
    .from(nbaEventProjection)
    .where(eq(nbaEventProjection.leagueId, leagueId));
  const s = new Set<string>();
  for (const r of rows) s.add(`${r.gameId}|${r.sequence}`);
  return s;
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

  // Incremental: only compute + upsert rows we don't already have, and delete
  // any stale rows whose (gameId, sequence) is no longer in the current
  // snapshot set (e.g., plays corrected/removed upstream).
  const existingKeys = await loadExistingProjectionKeys(params.leagueId);
  const currentKeys = new Set(
    snapshots.map((s) => `${s.event.gameId}|${s.event.sequence}`),
  );
  const staleKeys = [...existingKeys].filter((k) => !currentKeys.has(k));
  if (staleKeys.length > 0) {
    const tuples = staleKeys.map((k) => {
      const [gameId, seqStr] = k.split("|");
      return { gameId, sequence: Number(seqStr) };
    });
    const byGame = new Map<string, number[]>();
    for (const t of tuples) {
      const arr = byGame.get(t.gameId) ?? [];
      arr.push(t.sequence);
      byGame.set(t.gameId, arr);
    }
    for (const [gameId, seqs] of byGame.entries()) {
      await db
        .delete(nbaEventProjection)
        .where(
          and(
            eq(nbaEventProjection.leagueId, params.leagueId),
            eq(nbaEventProjection.gameId, gameId),
            inArray(nbaEventProjection.sequence, seqs),
          ),
        );
    }
  }

  let processed = 0;
  for (const snap of snapshots) {
    const key = `${snap.event.gameId}|${snap.event.sequence}`;
    if (existingKeys.has(key)) {
      processed++;
      continue;
    }
    await processSnapshot(params.leagueId, snap, rosters, baseSimData);
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
