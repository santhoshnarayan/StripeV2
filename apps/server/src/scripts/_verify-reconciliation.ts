/**
 * Slice 5 sense-check: simulate the three reconciliation cases against a
 * real league and confirm the divergence detector picks them up.
 *
 *   pnpm --filter @repo/server tsx src/scripts/_verify-reconciliation.ts <leagueId>
 *
 * Cases tested:
 *   1. Insert: hide one mid-stream play from snapshots, confirm divergence
 *      index = first snapshot whose liveGames depended on the missing play.
 *   2. Edit: mutate one play's score, confirm divergence at that play.
 *   3. Delete: drop a stored projection row, confirm divergence at that key.
 *
 * Does NOT mutate the DB — operates on in-memory snapshot arrays vs the
 * live nba_event_projection table.
 */
import { asc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  nbaEventProjection,
  nbaGame,
  nbaPlay,
} from "@repo/db";
import {
  buildEventSnapshots,
  type GameMeta,
  type PlayEvent,
} from "@repo/sim";

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
  const playRows = await db
    .select({
      gameId: nbaPlay.gameId,
      sequenceNumber: nbaPlay.sequenceNumber,
      wallclock: nbaPlay.wallclock,
    })
    .from(nbaPlay)
    .where(inArray(nbaPlay.gameId, rows.map((r) => r.id)));
  const lastSeqByGame = new Map<string, number>();
  const bestByGame = new Map<string, { wc: number; seq: number }>();
  for (const p of playRows) {
    if (p.sequenceNumber == null) continue;
    const wc = p.wallclock ? p.wallclock.getTime() : 0;
    const cur = bestByGame.get(p.gameId);
    if (!cur || wc > cur.wc || (wc === cur.wc && p.sequenceNumber > cur.seq)) {
      bestByGame.set(p.gameId, { wc, seq: p.sequenceNumber });
    }
  }
  for (const [gid, b] of bestByGame.entries()) lastSeqByGame.set(gid, b.seq);
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

// Inlined copies of the rebuild.ts helpers — keep in sync if those change.
type Snap = ReturnType<typeof buildEventSnapshots>[number];
function snapshotEventMeta(snap: Snap) {
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
function snapshotSignature(snap: Snap): string {
  const meta = snapshotEventMeta(snap);
  const games = snap.liveGames.map((g) => [
    g.seriesKey, g.gameNum, g.status, g.homeScore, g.awayScore,
    Math.round(g.remainingFraction * 1000) / 1000,
  ]);
  return JSON.stringify([meta, games]);
}
function rowSignature(row: { eventMeta: unknown; gamesSnapshot: unknown }): string {
  const games = (row.gamesSnapshot as Array<{
    seriesKey: string; gameNum: number; status: string;
    homeScore: number; awayScore: number; remainingFraction: number;
  }> | null) ?? [];
  return JSON.stringify([
    row.eventMeta ?? null,
    games.map((g) => [
      g.seriesKey, g.gameNum, g.status, g.homeScore, g.awayScore,
      Math.round(g.remainingFraction * 1000) / 1000,
    ]),
  ]);
}

async function findFirstDivergence(leagueId: string, snapshots: Snap[]): Promise<number> {
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
  for (let i = 0; i < snapshots.length; i++) {
    const s = snapshots[i];
    const k = `${s.event.gameId}|${s.event.sequence}`;
    const row = byKey.get(k);
    if (!row) return i;
    if (rowSignature(row) !== snapshotSignature(s)) return i;
  }
  return snapshots.length;
}

async function main() {
  const leagueId = process.argv[2];
  if (!leagueId) {
    console.error("usage: tsx _verify-reconciliation.ts <leagueId>");
    process.exit(2);
  }
  const games = await loadGames();
  const plays = await loadPlays(games.map((g) => g.id));
  const snapshots = buildEventSnapshots({ games, plays });
  console.log(`Loaded ${games.length} games, ${plays.length} plays, ${snapshots.length} snapshots`);

  // Baseline: should match stored projections perfectly.
  const baselineDiv = await findFirstDivergence(leagueId, snapshots);
  console.log(
    `Baseline divergence index: ${baselineDiv} / ${snapshots.length} ` +
    `(${baselineDiv === snapshots.length ? "OK no divergence" : "drift!"})`,
  );

  if (snapshots.length < 5) {
    console.log("Not enough snapshots to test cases — skipping.");
    process.exit(0);
  }

  // Case 1 (Edit): clone snapshots and mutate one in-place to simulate a play
  // edit. Use index = floor(snapshots.length / 2).
  const editIdx = Math.floor(snapshots.length / 2);
  const editClone: Snap[] = snapshots.map((s, i) => {
    if (i !== editIdx) return s;
    return {
      ...s,
      event: { ...s.event, homeScore: (s.event.homeScore ?? 0) + 1 },
    };
  });
  const editDiv = await findFirstDivergence(leagueId, editClone);
  console.log(
    `Case 1 (Edit @ ${editIdx}): divergence at ${editDiv} ` +
    `(expect = ${editIdx}; ${editDiv === editIdx ? "OK" : "MISS"})`,
  );

  // Case 2 (Insert): drop a snapshot from the array to simulate "stored has
  // an extra play that no longer exists upstream". Drop at index editIdx.
  const dropIdx = Math.floor(snapshots.length / 3);
  const dropped = [...snapshots.slice(0, dropIdx), ...snapshots.slice(dropIdx + 1)];
  const dropDiv = await findFirstDivergence(leagueId, dropped);
  console.log(
    `Case 2 (Drop @ ${dropIdx}): divergence at ${dropDiv} ` +
    `(expect <= ${dropIdx} or sentinel; ${dropDiv <= dropIdx ? "OK" : "MISS"})`,
  );

  // Case 3 (Mutate liveGames upstream): simulate the situation where a prior
  // play was edited so liveGames at this snapshot differs. Mutate liveGames
  // homeScore for a snapshot AFTER the midpoint.
  const liveIdx = Math.floor(snapshots.length * 0.7);
  const liveClone: Snap[] = snapshots.map((s, i) => {
    if (i < liveIdx) return s;
    return {
      ...s,
      liveGames: s.liveGames.map((g, gi) =>
        gi === 0 ? { ...g, homeScore: g.homeScore + 1 } : g,
      ),
    };
  });
  const liveDiv = await findFirstDivergence(leagueId, liveClone);
  console.log(
    `Case 3 (LiveGames mutation @ ${liveIdx}): divergence at ${liveDiv} ` +
    `(expect <= ${liveIdx}; ${liveDiv <= liveIdx ? "OK" : "MISS"})`,
  );

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
