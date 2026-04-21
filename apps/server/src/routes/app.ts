import { randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  auctionState,
  draftBid,
  draftRound,
  draftRoundPlayer,
  draftSubmission,
  league,
  leagueInvite,
  leagueAction,
  leagueMember,
  nbaEventProjection,
  nbaGame,
  nbaPlay,
  nbaPlayerGameStats,
  nbaProjectionJob,
  nbaTeamGameStats,
  nbaWinProb,
  rosterEntry,
  snakeState,
  user,
} from "@repo/db";
import { auth } from "../auth.js";
import { decryptBidAmount, encryptBidAmount } from "../lib/bid-crypto.js";
import { loadActualsByGame } from "../lib/sim/merge-playoff-minutes.js";
import { streamSSE } from "hono/streaming";
import {
  getAuction,
  startAuction,
  type EventResult,
} from "../lib/auction-queue.js";
import {
  getSnakeDraft,
  startSnakeDraft,
  generateSnakeOrder,
} from "../lib/snake-queue.js";
import {
  auctionConfigFromLeague,
  getPlayerPoolForAuction,
  getPlayerPoolMapForAuction,
  type AuctionConfig,
  type PlayerPoolEntry,
} from "../lib/player-pool.js";
import { computeLivePointsByPlayer } from "../lib/espn-nba/ingest.js";
import { enqueueProjectionRebuild } from "../lib/projections/rebuild.js";

const LEAGUE_CREATOR_EMAIL = "santhoshnarayan@gmail.com";
const MAX_ACTIVE_MEMBERS = 16;

type AppSession = Awaited<ReturnType<typeof auth.api.getSession>>;
type TransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

type MemberRow = Awaited<ReturnType<typeof getLeagueMembers>>[number];

type MemberState = {
  userId: string;
  rosterCount: number;
  remainingBudget: number;
  remainingRosterSlots: number;
  totalPoints: number;
};

const createLeagueSchema = z.object({
  name: z.string().min(2).max(120),
  rosterSize: z.number().int().min(8).max(12).default(10),
});

const inviteSchema = z.object({
  emails: z.array(z.string().email()).min(1),
});

const openRoundSchema = z.object({
  mode: z.enum(["selected", "all_remaining"]),
  playerIds: z.array(z.string()).optional(),
  deadlineAt: z.string().datetime().nullable().optional(),
});

const submitBidsSchema = z.object({
  bids: z.record(z.string(), z.number().int().min(0)).default({}),
});

const updateLeagueSettingsSchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    rosterSize: z.number().int().min(8).max(12).optional(),
  })
  .refine((value) => typeof value.name === "string" || typeof value.rosterSize === "number", {
    message: "Provide at least one setting to update",
  });

export const appRouter = new Hono<{
  Variables: {
    session: AppSession;
  };
}>();

appRouter.use("*", async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set("session", session);
  await next();
});

function getRequiredSession(c: { get: (key: "session") => AppSession }) {
  return c.get("session");
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

appRouter.get("/players", async (c) => {
  // Public players page — the caller can override the league assumption via
  // query params so the same page can model different league shapes.
  const parseIntParam = (raw: string | undefined, fallback: number, lo: number, hi: number) => {
    if (!raw) return fallback;
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(hi, Math.max(lo, value));
  };

  const config: AuctionConfig = {
    managers: parseIntParam(c.req.query("managers"), 8, 2, 20),
    rosterSize: parseIntParam(c.req.query("rosterSize"), 9, 1, 20),
    budgetPerTeam: parseIntParam(c.req.query("budget"), 200, 10, 10_000),
    minBid: parseIntParam(c.req.query("minBid"), 1, 0, 100),
  };

  const players = await getPlayerPoolForAuction(config);

  return c.json({
    assumption: config,
    players,
  });
});

// Simulation data endpoint — static reference data (bracket, team ratings,
// player stats with LEBRON/WAR, projected playoff minutes). ~120KB JSON,
// served once per client session. No auth required.
// Invalidate cache on every deploy by keying on a build-time constant
let simDataCache: string | null = null;

appRouter.get("/sim-data", async (c) => {
  // Allow ?bust= param to force rebuild (for dev)
  if (c.req.query("bust") || !simDataCache) {
    simDataCache = null;
  }
  if (!simDataCache) {
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
    simDataCache = JSON.stringify({
      bracket: JSON.parse(bracket),
      netRatings: JSON.parse(netRatings),
      simPlayers: JSON.parse(simPlayers),
      playoffMinutes: JSON.parse(playoffMinutes),
      adjustments: JSON.parse(adjustments),
      injuries: JSON.parse(injuries),
      actualsByGame,
    });
  }
  return c.body(simDataCache, 200, {
    "content-type": "application/json",
    "cache-control": "public, max-age=300",
  });
});

// ───────────────────────── Live NBA scoring (additive) ─────────────────────

// Team-abbrev → seed lookup built from the bracket JSON. Includes both conference
// seeds and play-in seeds (9 and 10) so every rostered team has a seed label.
let teamSeedCache: Map<string, number> | null = null;
async function getTeamSeedMap(): Promise<Map<string, number>> {
  if (teamSeedCache) return teamSeedCache;
  const dataDir = path.resolve(process.cwd(), "src/data");
  const raw = await readFile(path.join(dataDir, "nba-bracket-2026.json"), "utf8");
  const bracket = JSON.parse(raw) as {
    eastSeeds: Array<[number, string]>;
    westSeeds: Array<[number, string]>;
    eastPlayin?: Array<[number, string]>;
    westPlayin?: Array<[number, string]>;
  };
  const map = new Map<string, number>();
  for (const [seed, team] of [
    ...bracket.eastSeeds,
    ...bracket.westSeeds,
    ...(bracket.eastPlayin ?? []),
    ...(bracket.westPlayin ?? []),
  ]) {
    map.set(team, seed);
  }
  teamSeedCache = map;
  return map;
}

// Top projected scorers by team — used for pre-game hover tooltips on the ticker.
// Reads the static simPlayers JSON once and caches. Limits to top 5 per team
// by ppg since that's the universe we ever surface.
type TopProjected = { playerId: string; playerName: string; ppg: number };
let topProjectedCache: Map<string, TopProjected[]> | null = null;
async function getTopProjectedByTeam(): Promise<Map<string, TopProjected[]>> {
  if (topProjectedCache) return topProjectedCache;
  const dataDir = path.resolve(process.cwd(), "src/data");
  const raw = await readFile(path.join(dataDir, "nba-players-2026.json"), "utf8");
  const rows = JSON.parse(raw) as Array<{
    espn_id: string;
    name: string;
    team: string;
    ppg: number | null;
  }>;
  const byTeam = new Map<string, TopProjected[]>();
  for (const r of rows) {
    if (!r.team || !r.espn_id) continue;
    const arr = byTeam.get(r.team) ?? [];
    arr.push({ playerId: r.espn_id, playerName: r.name, ppg: r.ppg ?? 0 });
    byTeam.set(r.team, arr);
  }
  for (const [team, arr] of byTeam.entries()) {
    arr.sort((a, b) => b.ppg - a.ppg);
    byTeam.set(team, arr.slice(0, 5));
  }
  topProjectedCache = byTeam;
  return byTeam;
}

appRouter.get("/nba/live-ticker", async (c) => {
  // Show today's + recently-ended games. Compact payload for the header ticker.
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const endOfTomorrow = new Date(start);
  endOfTomorrow.setDate(start.getDate() + 2);

  const [rows, seedByTeam, topProjected] = await Promise.all([
    db
      .select()
      .from(nbaGame)
      .where(and(gte(nbaGame.date, start), lt(nbaGame.date, endOfTomorrow)))
      .orderBy(asc(nbaGame.startTime)),
    getTeamSeedMap(),
    getTopProjectedByTeam(),
  ]);

  // Pull actual per-player stats for any live/post games so hover tooltips
  // can show real leaders instead of projections.
  const activeIds = rows
    .filter((g) => g.status === "in" || g.status === "post")
    .map((g) => g.id);
  const statsByGame = new Map<
    string,
    Array<{ playerId: string; playerName: string; teamAbbrev: string; points: number }>
  >();
  if (activeIds.length > 0) {
    const statRows = await db
      .select({
        gameId: nbaPlayerGameStats.gameId,
        playerId: nbaPlayerGameStats.playerId,
        playerName: nbaPlayerGameStats.playerName,
        teamAbbrev: nbaPlayerGameStats.teamAbbrev,
        points: nbaPlayerGameStats.points,
      })
      .from(nbaPlayerGameStats)
      .where(inArray(nbaPlayerGameStats.gameId, activeIds));
    for (const s of statRows) {
      const arr = statsByGame.get(s.gameId) ?? [];
      arr.push({
        playerId: s.playerId,
        playerName: s.playerName,
        teamAbbrev: s.teamAbbrev,
        points: s.points ?? 0,
      });
      statsByGame.set(s.gameId, arr);
    }
  }

  function buildLeaders(
    gameId: string,
    status: string,
    home: string | null,
    away: string | null,
  ): {
    source: "actual" | "projected";
    home: Array<{ playerId: string; playerName: string; value: number }>;
    away: Array<{ playerId: string; playerName: string; value: number }>;
  } {
    // Return enough players that the client can show all drafted players in
    // the game (rosters typically max out ~8-9 per NBA team, so 10 covers it).
    const ACTUAL_LIMIT = 10;
    const PROJECTED_LIMIT = 8;
    if ((status === "in" || status === "post") && statsByGame.has(gameId)) {
      const list = statsByGame.get(gameId)!;
      const pick = (team: string | null) =>
        team
          ? list
              .filter((s) => s.teamAbbrev === team)
              .sort((a, b) => b.points - a.points)
              .slice(0, ACTUAL_LIMIT)
              .map((s) => ({ playerId: s.playerId, playerName: s.playerName, value: s.points }))
          : [];
      return { source: "actual", home: pick(home), away: pick(away) };
    }
    const pickProj = (team: string | null) =>
      (team ? topProjected.get(team) ?? [] : [])
        .slice(0, PROJECTED_LIMIT)
        .map((p) => ({ playerId: p.playerId, playerName: p.playerName, value: p.ppg }));
    return { source: "projected", home: pickProj(home), away: pickProj(away) };
  }

  return c.json({
    games: rows.map((g) => {
      const leaders = buildLeaders(g.id, g.status, g.homeTeamAbbrev, g.awayTeamAbbrev);
      return {
        id: g.id,
        date: g.date,
        startTime: g.startTime,
        homeTeam: g.homeTeamAbbrev,
        awayTeam: g.awayTeamAbbrev,
        homeSeed: g.homeTeamAbbrev ? seedByTeam.get(g.homeTeamAbbrev) ?? null : null,
        awaySeed: g.awayTeamAbbrev ? seedByTeam.get(g.awayTeamAbbrev) ?? null : null,
        homeScore: g.homeScore,
        awayScore: g.awayScore,
        status: g.status,
        period: g.period,
        displayClock: g.displayClock,
        broadcast: g.broadcast,
        seriesKey: g.seriesKey,
        gameNum: g.gameNum,
        leaders,
      };
    }),
  });
});

appRouter.get("/nba/scoreboard", async (c) => {
  const dateParam = c.req.query("date");
  let dayStart: Date;
  if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    dayStart = new Date(`${dateParam}T00:00:00`);
  } else {
    dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
  }
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayStart.getDate() + 1);
  const rows = await db
    .select()
    .from(nbaGame)
    .where(and(gte(nbaGame.date, dayStart), lt(nbaGame.date, dayEnd)))
    .orderBy(asc(nbaGame.startTime));
  return c.json({ date: dayStart.toISOString(), games: rows });
});

appRouter.get("/nba/games/:eventId", async (c) => {
  const eventId = c.req.param("eventId");
  const [game] = await db.select().from(nbaGame).where(eq(nbaGame.id, eventId)).limit(1);
  if (!game) return c.json({ error: "not_found" }, 404);
  const teamStats = await db
    .select()
    .from(nbaTeamGameStats)
    .where(eq(nbaTeamGameStats.gameId, eventId));
  const playerStats = await db
    .select()
    .from(nbaPlayerGameStats)
    .where(eq(nbaPlayerGameStats.gameId, eventId));
  return c.json({ game, teamStats, playerStats });
});

appRouter.get("/nba/games/:eventId/pbp", async (c) => {
  const eventId = c.req.param("eventId");
  const rows = await db
    .select()
    .from(nbaPlay)
    .where(eq(nbaPlay.gameId, eventId))
    .orderBy(asc(nbaPlay.sequenceNumber));
  // Map DB schema (matches ESPN SDK shape) onto the API response the frontend
  // game-detail view consumes. Keeps FE decoupled from DB column renames.
  const plays = rows.map((r) => ({
    id: r.id,
    gameId: r.gameId,
    sequence: r.sequenceNumber,
    period: r.periodNumber,
    clock: r.clockDisplay,
    scoringPlay: r.isScoringPlay === true,
    scoreValue: r.scoreValue,
    text: r.text,
    shortText: r.shortText,
    typeText: r.typeText,
    homeScore: r.homeScore,
    awayScore: r.awayScore,
    teamAbbrev: r.teamAbbrev,
    playerIds: r.playerIds,
    coordinateX: r.coordinateX,
    coordinateY: r.coordinateY,
    wallclock: r.wallclock,
  }));
  return c.json({ plays });
});

appRouter.get("/nba/games/:eventId/win-probability", async (c) => {
  const eventId = c.req.param("eventId");
  const rows = await db
    .select()
    .from(nbaWinProb)
    .where(eq(nbaWinProb.gameId, eventId))
    .orderBy(asc(nbaWinProb.sequence));
  return c.json({ points: rows });
});

appRouter.get("/nba/sim-live-games", async (c) => {
  // Return LiveGameState-shaped payload for the web simulator.
  const games = await db
    .select()
    .from(nbaGame)
    .where(sql`${nbaGame.seriesKey} IS NOT NULL AND ${nbaGame.status} IN ('in','post')`)
    .orderBy(asc(nbaGame.startTime));

  if (games.length === 0) return c.json({ games: [] });

  const gameIds = games.map((g) => g.id);
  const playerRows = await db
    .select({
      gameId: nbaPlayerGameStats.gameId,
      playerId: nbaPlayerGameStats.playerId,
      points: nbaPlayerGameStats.points,
    })
    .from(nbaPlayerGameStats)
    .where(inArray(nbaPlayerGameStats.gameId, gameIds));

  const ptsByGame = new Map<string, Record<string, number>>();
  for (const r of playerRows) {
    const bag = ptsByGame.get(r.gameId) ?? {};
    bag[r.playerId] = (bag[r.playerId] ?? 0) + (r.points ?? 0);
    ptsByGame.set(r.gameId, bag);
  }

  const computeFrac = (status: string, period: number | null, displayClock: string | null) => {
    if (status === "post") return 0;
    if (status === "pre") return 1;
    if (period == null) return 1;
    let secondsLeft = 0;
    if (displayClock) {
      const [mm, ss] = displayClock.split(":");
      const m = Number.parseInt(mm ?? "0", 10) || 0;
      const s = Number.parseFloat(ss ?? "0") || 0;
      secondsLeft = m * 60 + s;
    }
    if (period <= 4) {
      const remainingQuarters = 4 - period;
      const remainingSeconds = remainingQuarters * 720 + secondsLeft;
      return Math.max(0, Math.min(1, remainingSeconds / (48 * 60)));
    }
    return Math.max(0, Math.min(0.15, secondsLeft / (48 * 60)));
  };

  return c.json({
    games: games.map((g) => ({
      seriesKey: g.seriesKey,
      gameNum: g.gameNum,
      status: g.status,
      homeTeam: g.homeTeamAbbrev,
      awayTeam: g.awayTeamAbbrev,
      homeScore: g.homeScore ?? 0,
      awayScore: g.awayScore ?? 0,
      remainingFraction: computeFrac(g.status, g.period, g.displayClock),
      playerPoints: ptsByGame.get(g.id) ?? {},
    })),
  });
});

appRouter.get("/nba/schedule", async (c) => {
  const rows = await db
    .select()
    .from(nbaGame)
    .where(sql`${nbaGame.seriesKey} IS NOT NULL`)
    .orderBy(asc(nbaGame.date));
  const bySeries: Record<
    string,
    Array<{
      id: string;
      gameNum: number | null;
      date: Date | null;
      startTime: Date | null;
      status: string;
      homeScore: number | null;
      awayScore: number | null;
      homeTeam: string | null;
      awayTeam: string | null;
      period: number | null;
      displayClock: string | null;
    }>
  > = {};
  for (const g of rows) {
    if (!g.seriesKey) continue;
    if (!bySeries[g.seriesKey]) bySeries[g.seriesKey] = [];
    bySeries[g.seriesKey].push({
      id: g.id,
      gameNum: g.gameNum,
      date: g.date,
      startTime: g.startTime,
      status: g.status,
      homeScore: g.homeScore,
      awayScore: g.awayScore,
      homeTeam: g.homeTeamAbbrev,
      awayTeam: g.awayTeamAbbrev,
      period: g.period,
      displayClock: g.displayClock,
    });
  }
  return c.json({ series: bySeries });
});

// Per-player per-game point log for every rostered player in a league.
// Powers the "detailed scoring" view — rows are players, columns are games.
appRouter.get("/leagues/:leagueId/game-logs", async (c) => {
  const session = getRequiredSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  const access = await getLeagueAccess(session.user.id, c.req.param("leagueId"));
  if (!access) return c.json({ error: "League not found" }, 404);

  const rosterRows = await db
    .select({ userId: rosterEntry.userId, playerId: rosterEntry.playerId })
    .from(rosterEntry)
    .where(eq(rosterEntry.leagueId, access.league.id));

  const rosteredPlayerIds = Array.from(new Set(rosterRows.map((r) => r.playerId)));
  if (rosteredPlayerIds.length === 0) {
    return c.json({ games: [], statsByPlayer: {} });
  }

  const games = await db
    .select({
      id: nbaGame.id,
      date: nbaGame.date,
      startTime: nbaGame.startTime,
      homeTeamAbbrev: nbaGame.homeTeamAbbrev,
      awayTeamAbbrev: nbaGame.awayTeamAbbrev,
      homeScore: nbaGame.homeScore,
      awayScore: nbaGame.awayScore,
      status: nbaGame.status,
      seriesKey: nbaGame.seriesKey,
      gameNum: nbaGame.gameNum,
    })
    .from(nbaGame)
    .where(sql`${nbaGame.seriesKey} IS NOT NULL`)
    .orderBy(asc(nbaGame.date));

  const stats = await db
    .select({
      playerId: nbaPlayerGameStats.playerId,
      gameId: nbaPlayerGameStats.gameId,
      points: nbaPlayerGameStats.points,
      minutes: nbaPlayerGameStats.minutes,
      dnp: nbaPlayerGameStats.dnp,
      teamAbbrev: nbaPlayerGameStats.teamAbbrev,
    })
    .from(nbaPlayerGameStats)
    .where(inArray(nbaPlayerGameStats.playerId, rosteredPlayerIds));

  const statsByPlayer: Record<string, Record<string, { points: number; minutes: number | null; dnp: boolean; teamAbbrev: string | null }>> = {};
  for (const s of stats) {
    const bag = statsByPlayer[s.playerId] ?? {};
    bag[s.gameId] = {
      points: s.points ?? 0,
      minutes: s.minutes,
      dnp: s.dnp ?? false,
      teamAbbrev: s.teamAbbrev,
    };
    statsByPlayer[s.playerId] = bag;
  }

  return c.json({ games, statsByPlayer });
});

// Cumulative fantasy points per manager over the postseason calendar.
// Includes completed AND in-progress games so today's live scoring shows on the
// current day's bucket. Powers the "scoring over time" overlay chart.
appRouter.get("/leagues/:leagueId/scoring-timeline", async (c) => {
  const session = getRequiredSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  const access = await getLeagueAccess(session.user.id, c.req.param("leagueId"));
  if (!access) return c.json({ error: "League not found" }, 404);

  const rosterRows = await db
    .select({ userId: rosterEntry.userId, playerId: rosterEntry.playerId })
    .from(rosterEntry)
    .where(eq(rosterEntry.leagueId, access.league.id));

  if (rosterRows.length === 0) {
    return c.json({ managers: [], points: [] });
  }

  const members = await getLeagueMembers(access.league.id);
  const managersById = new Map<string, MemberRow>();
  for (const m of members) {
    if (m.userId) managersById.set(m.userId, m);
  }

  const rosteredPlayerIds = Array.from(new Set(rosterRows.map((r) => r.playerId)));
  const playerToUser = new Map<string, string>();
  for (const r of rosterRows) playerToUser.set(r.playerId, r.userId);

  const statRows = await db
    .select({
      playerId: nbaPlayerGameStats.playerId,
      gameId: nbaPlayerGameStats.gameId,
      points: nbaPlayerGameStats.points,
      gameDate: nbaGame.date,
      status: nbaGame.status,
    })
    .from(nbaPlayerGameStats)
    .innerJoin(nbaGame, eq(nbaGame.id, nbaPlayerGameStats.gameId))
    .where(
      and(
        inArray(nbaPlayerGameStats.playerId, rosteredPlayerIds),
        sql`${nbaGame.status} in ('post','in')`,
        isNotNull(nbaGame.seriesKey),
      ),
    );

  // Bucket points by day (YYYY-MM-DD) and manager.
  const byDay = new Map<string, Map<string, number>>();
  for (const s of statRows) {
    const userId = playerToUser.get(s.playerId);
    if (!userId) continue;
    if (!s.gameDate) continue;
    const day = new Date(s.gameDate).toISOString().slice(0, 10);
    const dayMap = byDay.get(day) ?? new Map<string, number>();
    dayMap.set(userId, (dayMap.get(userId) ?? 0) + (s.points ?? 0));
    byDay.set(day, dayMap);
  }

  const managers = Array.from(managersById.values()).map((m) => ({
    userId: m.userId,
    name: m.name,
  }));

  // Build running totals: each timeline point is a day with cumulative totals per manager.
  const sortedDays = Array.from(byDay.keys()).sort();
  const cumulative = new Map<string, number>();
  for (const mgr of managers) cumulative.set(mgr.userId, 0);
  const points = sortedDays.map((day) => {
    const dayMap = byDay.get(day)!;
    for (const [userId, pts] of dayMap.entries()) {
      cumulative.set(userId, (cumulative.get(userId) ?? 0) + pts);
    }
    const snapshot: Record<string, number> = {};
    for (const [userId, total] of cumulative.entries()) {
      snapshot[userId] = total;
    }
    return { date: day, totals: snapshot };
  });

  return c.json({ managers, points });
});

// Fine-grained per-checkpoint timeseries for the NCAAM-style chart.
// Each checkpoint is a moment in time (scoring play, halftime, or game-end)
// with cumulative per-manager fantasy points and the associated game context.
// Frontend filters by resolution (game / half / scoring). Projected points
// and win prob are computed client-side from the sim.
//
// Play-in games are excluded: seriesKey matching can misattribute play-in
// games to r1 series when a seed overlap exists (e.g., a 7v8 play-in between
// the 7-seed and the play-in-winner 8-seed looks like the 2v7 R1 matchup's
// teams). We filter by R1_FLOOR_DATE below, which is the day the first real
// R1 playoff game tipped off — 2026-04-19 for the 2026 bracket.
const R1_FLOOR_DATE = new Date("2026-04-19T00:00:00Z");
appRouter.get("/leagues/:leagueId/timeseries", async (c) => {
  const session = getRequiredSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  const access = await getLeagueAccess(session.user.id, c.req.param("leagueId"));
  if (!access) return c.json({ error: "League not found" }, 404);

  const rosterRows = await db
    .select({ userId: rosterEntry.userId, playerId: rosterEntry.playerId })
    .from(rosterEntry)
    .where(eq(rosterEntry.leagueId, access.league.id));

  const members = await getLeagueMembers(access.league.id);
  const managers = members
    .filter((m) => m.userId)
    .map((m) => ({ userId: m.userId, name: m.name }));

  if (rosterRows.length === 0) {
    return c.json({ managers, checkpoints: [] });
  }

  const playerToUser = new Map<string, string>();
  for (const r of rosterRows) playerToUser.set(r.playerId, r.userId);
  const rosteredPlayerIds = Array.from(new Set(rosterRows.map((r) => r.playerId)));

  // Games with a seriesKey (i.e. playoff), ordered chronologically.
  const games = await db
    .select({
      id: nbaGame.id,
      date: nbaGame.date,
      startTime: nbaGame.startTime,
      homeTeam: nbaGame.homeTeamAbbrev,
      awayTeam: nbaGame.awayTeamAbbrev,
      homeScore: nbaGame.homeScore,
      awayScore: nbaGame.awayScore,
      status: nbaGame.status,
      seriesKey: nbaGame.seriesKey,
      gameNum: nbaGame.gameNum,
    })
    .from(nbaGame)
    .where(and(isNotNull(nbaGame.seriesKey), gte(nbaGame.date, R1_FLOOR_DATE)))
    .orderBy(asc(nbaGame.startTime));

  const finishedOrLive = games.filter((g) => g.status === "post" || g.status === "in");
  if (finishedOrLive.length === 0) {
    return c.json({ managers, checkpoints: [] });
  }
  const gameIds = finishedOrLive.map((g) => g.id);

  // Final per-player totals for reconciliation at game-end.
  const finalStats = await db
    .select({
      gameId: nbaPlayerGameStats.gameId,
      playerId: nbaPlayerGameStats.playerId,
      points: nbaPlayerGameStats.points,
    })
    .from(nbaPlayerGameStats)
    .where(
      and(
        inArray(nbaPlayerGameStats.gameId, gameIds),
        inArray(nbaPlayerGameStats.playerId, rosteredPlayerIds),
      ),
    );

  const finalByGame = new Map<string, Map<string, number>>();
  for (const s of finalStats) {
    const bag = finalByGame.get(s.gameId) ?? new Map<string, number>();
    bag.set(s.playerId, s.points ?? 0);
    finalByGame.set(s.gameId, bag);
  }

  // All scoring plays for these games, ordered by sequence.
  const plays = await db
    .select({
      gameId: nbaPlay.gameId,
      sequence: nbaPlay.sequenceNumber,
      period: nbaPlay.periodNumber,
      clock: nbaPlay.clockDisplay,
      scoreValue: nbaPlay.scoreValue,
      playerIds: nbaPlay.playerIds,
      text: nbaPlay.text,
      homeScore: nbaPlay.homeScore,
      awayScore: nbaPlay.awayScore,
    })
    .from(nbaPlay)
    .where(and(inArray(nbaPlay.gameId, gameIds), eq(nbaPlay.isScoringPlay, true)))
    .orderBy(asc(nbaPlay.gameId), asc(nbaPlay.sequenceNumber));

  type Checkpoint = {
    t: string;
    gameId: string;
    seriesKey: string | null;
    gameNum: number | null;
    homeTeam: string | null;
    awayTeam: string | null;
    homeScore: number | null;
    awayScore: number | null;
    period: number | null;
    clock: string | null;
    label: "play" | "half" | "end";
    eventText: string | null;
    pointsDelta: Record<string, number>;
  };

  const checkpoints: Checkpoint[] = [];

  for (const g of finishedOrLive) {
    const gamePlays = plays.filter((p) => p.gameId === g.id);
    const baseTime = g.startTime
      ? new Date(g.startTime).toISOString()
      : g.date
      ? new Date(g.date).toISOString()
      : new Date().toISOString();
    const running = new Map<string, number>();

    let halfEmitted = false;
    for (let i = 0; i < gamePlays.length; i++) {
      const p = gamePlays[i];
      const ids = Array.isArray(p.playerIds) ? (p.playerIds as unknown[]) : [];
      const scorerId = typeof ids[0] === "string" ? (ids[0] as string) : null;
      const score = p.scoreValue ?? 0;
      const delta: Record<string, number> = {};
      if (scorerId && score > 0) {
        const userId = playerToUser.get(scorerId);
        if (userId) {
          delta[userId] = score;
          running.set(scorerId, (running.get(scorerId) ?? 0) + score);
        }
      }
      // Emit a per-play checkpoint (delta may be empty for non-rostered scorers).
      const seqOffsetMs = (p.sequence ?? i) % 1_000_000;
      const t = new Date(new Date(baseTime).getTime() + seqOffsetMs).toISOString();
      checkpoints.push({
        t,
        gameId: g.id,
        seriesKey: g.seriesKey,
        gameNum: g.gameNum,
        homeTeam: g.homeTeam,
        awayTeam: g.awayTeam,
        homeScore: p.homeScore ?? null,
        awayScore: p.awayScore ?? null,
        period: p.period,
        clock: p.clock,
        label: "play",
        eventText: p.text ?? null,
        pointsDelta: delta,
      });

      // After end of Q2 (period transitions to 3+), emit a synthetic half marker.
      const nextPeriod = gamePlays[i + 1]?.period ?? null;
      if (!halfEmitted && (p.period ?? 0) === 2 && (nextPeriod ?? 0) >= 3) {
        checkpoints[checkpoints.length - 1].label = "half";
        halfEmitted = true;
      }
    }

    // Game-end reconciliation: for completed games, diff our scorer-only running
    // totals against the authoritative box score. Emit a reconciliation delta so
    // cumulative matches exactly (captures free throws / missing playerId rows).
    if (g.status === "post" && finalByGame.has(g.id)) {
      const final = finalByGame.get(g.id)!;
      const reconcile: Record<string, number> = {};
      for (const [playerId, truePts] of final.entries()) {
        const userId = playerToUser.get(playerId);
        if (!userId) continue;
        const already = running.get(playerId) ?? 0;
        const diff = truePts - already;
        if (diff !== 0) reconcile[userId] = (reconcile[userId] ?? 0) + diff;
      }
      const endT = g.startTime
        ? new Date(new Date(g.startTime).getTime() + 2 * 60 * 60 * 1000).toISOString()
        : new Date().toISOString();
      checkpoints.push({
        t: endT,
        gameId: g.id,
        seriesKey: g.seriesKey,
        gameNum: g.gameNum,
        homeTeam: g.homeTeam,
        awayTeam: g.awayTeam,
        homeScore: g.homeScore ?? null,
        awayScore: g.awayScore ?? null,
        period: null,
        clock: null,
        label: "end",
        eventText: "Final",
        pointsDelta: reconcile,
      });
    }
  }

  // Sort all checkpoints chronologically.
  checkpoints.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));

  return c.json({ managers, checkpoints });
});

function computeMaxBid(
  remainingBudget: number,
  remainingRosterSlots: number,
  minBid: number,
) {
  if (remainingRosterSlots <= 0) {
    return 0;
  }

  return Math.max(0, remainingBudget - (remainingRosterSlots - 1) * minBid);
}

function sampleGaussian(mean: number, stdDev: number) {
  const u1 = Math.random() || Number.MIN_VALUE;
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * stdDev;
}

// Default auto-bid: suggested value plus Gaussian noise with std dev = 10% of
// suggested value, clamped to [0, maxAllowed]. Used when a member does not
// submit an explicit bid for a player.
function sampleDefaultAutoBid(suggestedValue: number, maxAllowed: number) {
  const noisy = sampleGaussian(suggestedValue, Math.abs(suggestedValue) * 0.1);
  const rounded = Math.round(noisy);
  return Math.max(0, Math.min(maxAllowed, rounded));
}

function shuffle<T>(values: T[]) {
  const copy = [...values];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const nextIndex = randomInt(index + 1);
    const current = copy[index];
    copy[index] = copy[nextIndex];
    copy[nextIndex] = current;
  }

  return copy;
}

function moveWinnerToEnd(priorityOrder: string[], winnerUserId: string) {
  return [
    ...priorityOrder.filter((userId) => userId !== winnerUserId),
    winnerUserId,
  ];
}

// ---------- League action helpers ----------

async function nextSequenceNumber(
  tx: TransactionClient,
  leagueId: string,
): Promise<number> {
  const result = await tx
    .select({
      maxSeq: sql<number>`COALESCE(MAX(${leagueAction.sequenceNumber}), 0)`,
    })
    .from(leagueAction)
    .where(eq(leagueAction.leagueId, leagueId));

  return (result[0]?.maxSeq ?? 0) + 1;
}

async function getBudgetAdjustments(
  leagueId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      userId: leagueAction.userId,
      total: sql<number>`COALESCE(SUM(${leagueAction.amount}), 0)`,
    })
    .from(leagueAction)
    .where(
      and(
        eq(leagueAction.leagueId, leagueId),
        eq(leagueAction.type, "budget_adjust"),
      ),
    )
    .groupBy(leagueAction.userId);

  return new Map(
    rows
      .filter((r): r is typeof r & { userId: string } => r.userId !== null)
      .map((r) => [r.userId, r.total]),
  );
}

async function getLeagueAccess(userId: string, leagueId: string) {
  const membershipRows = await db
    .select()
    .from(leagueMember)
    .where(
      and(
        eq(leagueMember.leagueId, leagueId),
        eq(leagueMember.userId, userId),
        eq(leagueMember.status, "active"),
      ),
    )
    .limit(1);

  const membership = membershipRows[0];

  if (!membership) {
    return null;
  }

  const leagueRows = await db.select().from(league).where(eq(league.id, leagueId)).limit(1);
  const leagueRow = leagueRows[0];

  if (!leagueRow) {
    return null;
  }

  return {
    league: leagueRow,
    membership,
    isCommissioner: leagueRow.commissionerUserId === userId,
  };
}

async function getLeagueMembers(leagueId: string) {
  return db
    .select({
      membershipId: leagueMember.id,
      userId: user.id,
      name: user.name,
      email: user.email,
      role: leagueMember.role,
      status: leagueMember.status,
      draftPriority: leagueMember.draftPriority,
      createdAt: leagueMember.createdAt,
      updatedAt: leagueMember.updatedAt,
    })
    .from(leagueMember)
    .innerJoin(user, eq(leagueMember.userId, user.id))
    .where(
      and(eq(leagueMember.leagueId, leagueId), eq(leagueMember.status, "active")),
    );
}

async function getPendingLeagueInvites(leagueId: string) {
  const invites = await db
    .select()
    .from(leagueInvite)
    .where(
      and(eq(leagueInvite.leagueId, leagueId), eq(leagueInvite.status, "pending")),
    );

  const inviterIds = Array.from(new Set(invites.map((invite) => invite.invitedByUserId)));
  const inviters = inviterIds.length
    ? await db.select().from(user).where(inArray(user.id, inviterIds))
    : [];
  const inviterMap = new Map(inviters.map((inviter) => [inviter.id, inviter]));

  return invites.map((invite) => ({
    ...invite,
    invitedByName: inviterMap.get(invite.invitedByUserId)?.name ?? "Unknown",
  }));
}

function buildMemberStates(
  leagueRow: typeof league.$inferSelect,
  members: MemberRow[],
  rosterRows: Array<typeof rosterEntry.$inferSelect>,
  playerMap: Map<string, PlayerPoolEntry>,
  budgetAdjustments?: Map<string, number>,
) {
  return new Map<string, MemberState>(
    members.map((member) => {
      const roster = rosterRows.filter((entry) => entry.userId === member.userId);
      const rosterCount = roster.length;
      const spentBudget = roster.reduce((sum, entry) => sum + entry.acquisitionBid, 0);
      const adjustment = budgetAdjustments?.get(member.userId) ?? 0;
      const totalPoints = roster.reduce((sum, entry) => {
        return sum + (playerMap.get(entry.playerId)?.totalPoints ?? 0);
      }, 0);

      return [
        member.userId,
        {
          userId: member.userId,
          rosterCount,
          remainingBudget: leagueRow.budgetPerTeam + adjustment - spentBudget,
          remainingRosterSlots: leagueRow.rosterSize - rosterCount,
          totalPoints,
        },
      ];
    }),
  );
}

async function ensureDraftPriorityOrder(
  tx: TransactionClient,
  leagueId: string,
  members: MemberRow[],
  now: Date,
) {
  const hasMissingPriority = members.some((member) => member.draftPriority === null);

  if (!hasMissingPriority) {
    return [...members].sort(
      (left, right) => (left.draftPriority ?? 0) - (right.draftPriority ?? 0),
    );
  }

  const shuffledMembers = shuffle(members);

  for (const [index, member] of shuffledMembers.entries()) {
    await tx
      .update(leagueMember)
      .set({
        draftPriority: index + 1,
        updatedAt: now,
      })
      .where(eq(leagueMember.id, member.membershipId));
  }

  return shuffledMembers.map((member, index) => ({
    ...member,
    draftPriority: index + 1,
  }));
}

async function persistPriorityOrder(
  tx: TransactionClient,
  members: MemberRow[],
  orderedUserIds: string[],
  now: Date,
) {
  const membershipIdByUser = new Map(
    members.map((member) => [member.userId, member.membershipId]),
  );

  for (const [index, userId] of orderedUserIds.entries()) {
    const membershipId = membershipIdByUser.get(userId);

    if (!membershipId) {
      continue;
    }

    await tx
      .update(leagueMember)
      .set({
        draftPriority: index + 1,
        updatedAt: now,
      })
      .where(eq(leagueMember.id, membershipId));
  }
}

async function buildLeagueDetailResponse(leagueId: string, viewerUserId: string) {
  const access = await getLeagueAccess(viewerUserId, leagueId);

  if (!access) {
    return null;
  }

  const members = await getLeagueMembers(leagueId);
  const auctionConfig = auctionConfigFromLeague(access.league, members.length);
  const players = await getPlayerPoolForAuction(auctionConfig);
  const playerMap = new Map(players.map((player) => [player.id, player]));
  const pendingInvites = await getPendingLeagueInvites(leagueId);
  const rosterRows = await db
    .select()
    .from(rosterEntry)
    .where(eq(rosterEntry.leagueId, leagueId));
  const budgetAdj = await getBudgetAdjustments(leagueId);
  const memberStates = buildMemberStates(access.league, members, rosterRows, playerMap, budgetAdj);
  const rosteredPlayerIds = new Set(rosterRows.map((entry) => entry.playerId));
  const rosterByPlayerId = new Map(rosterRows.map((entry) => [entry.playerId, entry]));
  const memberByUserId = new Map(members.map((member) => [member.userId, member]));
  const availablePlayers = players.filter((player) => !rosteredPlayerIds.has(player.id));
  const draftedPlayers = players
    .filter((player) => rosteredPlayerIds.has(player.id))
    .map((player) => {
      const entry = rosterByPlayerId.get(player.id);
      const member = entry ? memberByUserId.get(entry.userId) : null;
      return {
        ...player,
        draftedBy:
          entry && member
            ? {
                userId: entry.userId,
                name: member.name,
                acquisitionBid: entry.acquisitionBid,
                isAutoAssigned: entry.isAutoAssigned ?? false,
              }
            : null,
      };
    });

  const openRound = (
    await db
      .select()
      .from(draftRound)
      .where(and(eq(draftRound.leagueId, leagueId), eq(draftRound.status, "open")))
      .orderBy(desc(draftRound.roundNumber))
      .limit(1)
  )[0] ?? null;

  const resolvedRounds = await db
    .select()
    .from(draftRound)
    .where(and(eq(draftRound.leagueId, leagueId), eq(draftRound.status, "resolved")))
    .orderBy(desc(draftRound.roundNumber));

  const latestResolvedRound = (
    await db
      .select()
      .from(draftRound)
      .where(and(eq(draftRound.leagueId, leagueId), eq(draftRound.status, "resolved")))
      .orderBy(desc(draftRound.roundNumber))
      .limit(1)
  )[0] ?? null;

  let currentRound: null | {
    id: string;
    roundNumber: number;
    status: string;
    eligiblePlayerMode: string;
    openedAt: Date;
    deadlineAt: Date | null;
    submissionStatuses: Array<{
      userId: string;
      name: string;
      submittedAt: Date | null;
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
  } = null;

  if (openRound) {
    const roundPlayers = await db
      .select()
      .from(draftRoundPlayer)
      .where(eq(draftRoundPlayer.roundId, openRound.id));
    const submissions = await db
      .select()
      .from(draftSubmission)
      .where(eq(draftSubmission.roundId, openRound.id));
    const viewerSubmission = submissions.find((submission) => submission.userId === viewerUserId);
    const explicitBidRows = viewerSubmission
      ? await db
          .select()
          .from(draftBid)
          .where(eq(draftBid.submissionId, viewerSubmission.id))
      : [];
    const explicitBidMap = new Map(
      explicitBidRows
        .filter((bid) => !bid.isAutoDefault)
        .map((bid) => [bid.playerId, decryptBidAmount(bid.encryptedAmount)]),
    );
    const viewerState = memberStates.get(viewerUserId);
    const myMaxBid = viewerState
      ? computeMaxBid(
          viewerState.remainingBudget,
          viewerState.remainingRosterSlots,
          access.league.minBid,
        )
      : 0;

    currentRound = {
      id: openRound.id,
      roundNumber: openRound.roundNumber,
      status: openRound.status,
      eligiblePlayerMode: openRound.eligiblePlayerMode,
      openedAt: openRound.openedAt,
      deadlineAt: openRound.deadlineAt,
      submissionStatuses: members
        .map((member) => {
          const submission = submissions.find((entry) => entry.userId === member.userId);
          return {
            userId: member.userId,
            name: member.name,
            submittedAt: submission?.submittedAt ?? null,
          };
        })
        .sort((left, right) => left.name.localeCompare(right.name)),
      myMaxBid,
      players: roundPlayers
        .map((roundPlayer) => playerMap.get(roundPlayer.playerId))
        .filter((player): player is NonNullable<typeof player> => Boolean(player))
        .map((player) => {
          const isAllRemainingRound = openRound.eligiblePlayerMode === "all_remaining";
          const defaultBid = (() => {
            if (isAllRemainingRound && player.suggestedValue < 2) {
              return 0;
            }

            return myMaxBid ? Math.min(player.suggestedValue, myMaxBid) : 0;
          })();
          const myExplicitBid = explicitBidMap.get(player.id) ?? null;

          return {
            id: player.id,
            name: player.name,
            team: player.team,
            conference: player.conference,
            seed: player.seed,
            gamesPlayed: player.gamesPlayed,
            minutesPerGame: player.minutesPerGame,
            pointsPerGame: player.pointsPerGame,
            suggestedValue: player.suggestedValue,
            totalPoints: player.totalPoints,
            totalGames: player.totalGames,
            injuryStatus: player.injuryStatus,
            defaultBid,
            myExplicitBid,
            myEffectiveBid: myExplicitBid ?? defaultBid,
          };
        }),
    };
  }

  const memberNameMap = new Map(members.map((member) => [member.userId, member.name]));
  const priorityOrder = members.every((member) => member.draftPriority !== null)
    ? [...members]
        .sort((left, right) => (left.draftPriority ?? 0) - (right.draftPriority ?? 0))
        .map((member) => ({
          userId: member.userId,
          name: member.name,
          draftPriority: member.draftPriority,
        }))
    : [];

  const maxRosterCount = Math.max(
    0,
    ...Array.from(memberStates.values()).map((state) => state.rosterCount),
  );

  const resolvedRoundIds = resolvedRounds.map((round) => round.id);
  const resolvedRoundPlayers = resolvedRoundIds.length
    ? await db
        .select()
        .from(draftRoundPlayer)
        .where(inArray(draftRoundPlayer.roundId, resolvedRoundIds))
    : [];
  const resolvedSubmissions = resolvedRoundIds.length
    ? await db
        .select()
        .from(draftSubmission)
        .where(inArray(draftSubmission.roundId, resolvedRoundIds))
    : [];
  const resolvedSubmissionIds = resolvedSubmissions.map((submission) => submission.id);
  const resolvedBidRows = resolvedSubmissionIds.length
    ? await db
        .select()
        .from(draftBid)
        .where(inArray(draftBid.submissionId, resolvedSubmissionIds))
    : [];
  const historyUserIds = Array.from(
    new Set([
      ...resolvedSubmissions.map((submission) => submission.userId),
      ...rosterRows
        .filter((entry) => entry.acquisitionRoundId !== null)
        .map((entry) => entry.userId),
    ]),
  ).filter((userId) => !memberNameMap.has(userId));
  const historyUsers = historyUserIds.length
    ? await db.select().from(user).where(inArray(user.id, historyUserIds))
    : [];
  const historyUserEntries: Array<[string, string]> = [
    ...Array.from(memberNameMap.entries()),
    ...historyUsers.map((historyUser) => [historyUser.id, historyUser.name] as [string, string]),
  ];
  const historyUserMap = new Map<string, string>(historyUserEntries);
  const submissionsByRoundId = new Map<string, Array<typeof draftSubmission.$inferSelect>>();

  for (const submission of resolvedSubmissions) {
    submissionsByRoundId.set(submission.roundId, [
      ...(submissionsByRoundId.get(submission.roundId) ?? []),
      submission,
    ]);
  }

  const bidsBySubmissionId = new Map<string, Array<typeof draftBid.$inferSelect>>();

  for (const bid of resolvedBidRows) {
    bidsBySubmissionId.set(bid.submissionId, [...(bidsBySubmissionId.get(bid.submissionId) ?? []), bid]);
  }

  const roundPlayersByRoundId = new Map<string, Array<typeof draftRoundPlayer.$inferSelect>>();

  for (const roundPlayer of resolvedRoundPlayers) {
    roundPlayersByRoundId.set(roundPlayer.roundId, [
      ...(roundPlayersByRoundId.get(roundPlayer.roundId) ?? []),
      roundPlayer,
    ]);
  }

  const awardsByRoundId = new Map<string, Array<typeof rosterEntry.$inferSelect>>();

  for (const rosterEntryRow of rosterRows.filter((entry) => entry.acquisitionRoundId !== null)) {
    const roundId = rosterEntryRow.acquisitionRoundId;

    if (!roundId) {
      continue;
    }

    awardsByRoundId.set(roundId, [...(awardsByRoundId.get(roundId) ?? []), rosterEntryRow]);
  }

  // Replay budget state across resolved rounds to compute max allowed bids.
  // Includes commissioner actions (roster_remove, roster_add, budget_adjust)
  // and auction results that happen between sealed-bid rounds.
  const BUDGET_ACTION_TYPES = [
    "roster_remove", "roster_add", "budget_adjust",
    "auction_award", "auction_undo_award",
  ];
  const budgetActions = await db
    .select()
    .from(leagueAction)
    .where(
      and(
        eq(leagueAction.leagueId, leagueId),
        inArray(leagueAction.type, [...BUDGET_ACTION_TYPES, "round_closed"]),
      ),
    )
    .orderBy(asc(leagueAction.sequenceNumber));

  // Map roundId → sequence number of its round_closed action
  const roundClosedSeq = new Map<string, number>();
  for (const action of budgetActions) {
    if (action.type === "round_closed" && action.roundId) {
      roundClosedSeq.set(action.roundId, action.sequenceNumber);
    }
  }
  // Only budget-affecting actions (not round_closed)
  const onlyBudgetActions = budgetActions.filter((a) => BUDGET_ACTION_TYPES.includes(a.type));

  const initBudget = access.league.budgetPerTeam;
  const initSlots = access.league.rosterSize;
  const minBidVal = access.league.minBid;

  const budgetReplay = new Map<string, number>(
    members.map((m) => [m.userId, initBudget]),
  );
  const slotsReplay = new Map<string, number>(
    members.map((m) => [m.userId, initSlots]),
  );
  const maxBidByRoundRow = new Map<string, Map<string, number>>(); // key: `${roundId}:${rowIdx}`

  let budgetActionCursor = 0;

  function applyBudgetActionsUpTo(maxSeq: number) {
    while (budgetActionCursor < onlyBudgetActions.length) {
      const action = onlyBudgetActions[budgetActionCursor];
      if (action.sequenceNumber >= maxSeq) break;
      budgetActionCursor++;
      if (!action.userId || action.amount == null) continue;

      const prevBudget = budgetReplay.get(action.userId) ?? initBudget;
      const prevSlots = slotsReplay.get(action.userId) ?? initSlots;

      switch (action.type) {
        case "roster_remove":
        case "auction_undo_award":
          // Refund: add amount back, free a slot
          budgetReplay.set(action.userId, prevBudget + action.amount);
          slotsReplay.set(action.userId, prevSlots + 1);
          break;
        case "roster_add":
        case "auction_award":
          // Spend: deduct amount, fill a slot
          budgetReplay.set(action.userId, prevBudget - action.amount);
          slotsReplay.set(action.userId, prevSlots - 1);
          break;
        case "budget_adjust":
          // Pure budget change, no slot change
          budgetReplay.set(action.userId, prevBudget + action.amount);
          break;
      }
    }
  }

  // resolvedRounds is desc by roundNumber — replay in ascending order
  const roundsAsc = [...resolvedRounds].sort((a, b) => a.roundNumber - b.roundNumber);
  for (const round of roundsAsc) {
    // Apply all budget-affecting actions that happened BEFORE this round closed
    const closedSeq = roundClosedSeq.get(round.id) ?? Infinity;
    applyBudgetActionsUpTo(closedSeq);

    const awardsForReplay = [...(awardsByRoundId.get(round.id) ?? [])].sort(
      (a, b) => a.acquisitionOrder - b.acquisitionOrder,
    );

    for (let ri = 0; ri < awardsForReplay.length; ri++) {
      const snapshot = new Map<string, number>();
      for (const [uid, budget] of budgetReplay) {
        const slots = slotsReplay.get(uid) ?? 0;
        snapshot.set(uid, slots > 0 ? Math.max(0, budget - (slots - 1) * minBidVal) : 0);
      }
      maxBidByRoundRow.set(`${round.id}:${ri}`, snapshot);
      // Deduct this award — winner's budget decreases for subsequent rows
      const award = awardsForReplay[ri];
      const prevBudget = budgetReplay.get(award.userId) ?? 0;
      budgetReplay.set(award.userId, prevBudget - award.acquisitionBid);
      slotsReplay.set(award.userId, (slotsReplay.get(award.userId) ?? 1) - 1);
    }
  }

  const draftHistory = resolvedRounds.map((round) => {
    const roundSubmissionsForHistory = submissionsByRoundId.get(round.id) ?? [];
    const roundParticipantIds = Array.from(
      new Set(roundSubmissionsForHistory.map((submission) => submission.userId)),
    ).sort((left, right) =>
      (historyUserMap.get(left) ?? "Unknown").localeCompare(historyUserMap.get(right) ?? "Unknown"),
    );
    const roundParticipants = roundParticipantIds.map((userId) => ({
      userId,
      name: historyUserMap.get(userId) ?? "Unknown",
    }));
    const submissionByUserId = new Map<string, typeof draftSubmission.$inferSelect>(
      roundSubmissionsForHistory.map((submission) => [submission.userId, submission] as [
        string,
        typeof draftSubmission.$inferSelect,
      ]),
    );
    const awardsForRound = [...(awardsByRoundId.get(round.id) ?? [])].sort(
      (left, right) => left.acquisitionOrder - right.acquisitionOrder,
    );
    const awardByPlayerId = new Map(awardsForRound.map((award) => [award.playerId, award]));
    const playersForRound = (roundPlayersByRoundId.get(round.id) ?? [])
      .map((roundPlayer) => playerMap.get(roundPlayer.playerId))
      .filter((player): player is NonNullable<typeof player> => Boolean(player))
      .sort((left, right) => {
        const leftAward = awardByPlayerId.get(left.id);
        const rightAward = awardByPlayerId.get(right.id);

        if (leftAward && rightAward) {
          return leftAward.acquisitionOrder - rightAward.acquisitionOrder;
        }

        if (leftAward) {
          return -1;
        }

        if (rightAward) {
          return 1;
        }

        return (
          right.suggestedValue - left.suggestedValue ||
          (right.totalPoints ?? -1) - (left.totalPoints ?? -1) ||
          left.name.localeCompare(right.name)
        );
      });

    return {
      id: round.id,
      roundNumber: round.roundNumber,
      resolvedAt: round.resolvedAt,
      participants: roundParticipants,
      rows: playersForRound.map((player, playerRowIndex) => {
        const award = awardByPlayerId.get(player.id) ?? null;
        // Max allowed bid per user at this row position
        const rowMaxBids = maxBidByRoundRow.get(`${round.id}:${playerRowIndex}`);
        const bids = roundParticipants.map((participant) => {
          const submission = submissionByUserId.get(participant.userId);
          const bidAmount = submission
            ? bidsBySubmissionId
                .get(submission.id)
                ?.find((bid) => bid.playerId === player.id)
            : null;
          const amount = bidAmount ? decryptBidAmount(bidAmount.encryptedAmount) : null;

          return {
            userId: participant.userId,
            userName: participant.name,
            amount,
            isAutoDefault: bidAmount?.isAutoDefault ?? false,
          };
        });
        // Filter to only VALID bids for ranking (bid <= max allowed for that user)
        const validBids = bids.filter((bid) => {
          if (bid.amount === null || bid.amount <= 0) return false;
          const maxAllowed = rowMaxBids?.get(bid.userId) ?? Infinity;
          return bid.amount <= maxAllowed;
        });
        const rankedBids = [...validBids]
          .sort((left, right) => {
            if ((right.amount ?? -1) !== (left.amount ?? -1)) {
              return (right.amount ?? -1) - (left.amount ?? -1);
            }

            if (award?.userId === left.userId) {
              return -1;
            }

            if (award?.userId === right.userId) {
              return 1;
            }

            return left.userName.localeCompare(right.userName);
          });
        const winnerBid = award?.acquisitionBid ?? rankedBids[0]?.amount ?? null;
        const winnerName = award ? historyUserMap.get(award.userId) ?? "Unknown" : null;
        // No cover/runner-up if the player went undrafted
        const runnerUpAmount = award
          ? rankedBids.find((bid) => bid.userId !== award.userId)?.amount ?? null
          : null;
        const runnerUpNames = award
          ? rankedBids
              .filter((bid) => bid.userId !== award.userId && bid.amount === runnerUpAmount)
              .map((bid) => bid.userName)
          : [];

        return {
          playerId: player.id,
          playerName: player.name,
          playerTeam: player.team,
          suggestedValue: player.suggestedValue,
          totalPoints: player.totalPoints ?? null,
          winnerUserId: award?.userId ?? null,
          winnerName,
          winningBid: winnerBid,
          runnerUpName: runnerUpNames.length ? runnerUpNames.join(", ") : null,
          runnerUpBid: runnerUpAmount,
          bids: bids.map((bid) => {
            const bidMaxAllowed = rowMaxBids?.get(bid.userId) ?? Infinity;
            const isValid = bid.amount !== null && bid.amount > 0 && bid.amount <= bidMaxAllowed;
            return {
              ...bid,
              maxAllowed: bidMaxAllowed === Infinity ? null : bidMaxAllowed,
              isWinningBid: bid.userId === award?.userId && bid.amount !== null,
              isSecondPlaceBid:
                isValid &&
                bid.userId !== award?.userId &&
                runnerUpAmount !== null &&
                bid.amount === runnerUpAmount,
            };
          }),
        };
      }),
    };
  });

  return {
    league: {
      ...access.league,
      commissionerName: memberNameMap.get(access.league.commissionerUserId) ?? "Unknown",
      isCommissioner: access.isCommissioner,
      canEditRosterSize:
        access.isCommissioner &&
        access.league.phase !== "scoring" &&
        !openRound &&
        maxRosterCount <= access.league.rosterSize,
    },
    members: members
      .map((member) => {
        const state = memberStates.get(member.userId)!;
        return {
          ...member,
          ...state,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name)),
    priorityOrder,
    pendingInvites: pendingInvites.sort((left, right) =>
      left.email.localeCompare(right.email),
    ),
    availablePlayers,
    allPlayers: players.map((player) => {
      const entry = rosterByPlayerId.get(player.id);
      const member = entry ? memberByUserId.get(entry.userId) : null;
      return {
        ...player,
        draftedBy: entry && member ? {
          userId: entry.userId,
          name: member.name,
          acquisitionBid: entry.acquisitionBid,
          isAutoAssigned: entry.isAutoAssigned ?? false,
        } : null,
      };
    }),
    currentRound,
    draftHistory,
    lastResolvedRound: latestResolvedRound
      ? {
          id: latestResolvedRound.id,
          roundNumber: latestResolvedRound.roundNumber,
          resolvedAt: latestResolvedRound.resolvedAt,
          results: rosterRows
            .filter((entry) => entry.acquisitionRoundId === latestResolvedRound.id)
            .sort((left, right) => left.acquisitionOrder - right.acquisitionOrder)
            .map((entry) => ({
              order: entry.acquisitionOrder,
              playerId: entry.playerId,
              playerName: entry.playerName,
              playerTeam: entry.playerTeam,
              totalPoints: playerMap.get(entry.playerId)?.totalPoints ?? null,
              suggestedValue: playerMap.get(entry.playerId)?.suggestedValue ?? 0,
              winnerUserId: entry.userId,
              winnerName: historyUserMap.get(entry.userId) ?? "Unknown",
              winningBid: entry.acquisitionBid,
              wonByTiebreak: entry.wonByTiebreak,
              isAutoAssigned: entry.isAutoAssigned,
            })),
        }
      : null,
    rosters: members
      .map((member) => {
        const state = memberStates.get(member.userId)!;
        const playersForMember = rosterRows
          .filter((entry) => entry.userId === member.userId)
          .sort((left, right) => left.acquisitionOrder - right.acquisitionOrder)
          .map((entry) => ({
            playerId: entry.playerId,
            playerName: entry.playerName,
            playerTeam: entry.playerTeam,
            acquisitionBid: entry.acquisitionBid,
            acquisitionOrder: entry.acquisitionOrder,
            acquiredInRoundId: entry.acquisitionRoundId,
            isAutoAssigned: entry.isAutoAssigned,
            totalPoints: playerMap.get(entry.playerId)?.totalPoints ?? 0,
          }));

        return {
          userId: member.userId,
          name: member.name,
          totalPoints: state.totalPoints,
          players: playersForMember,
        };
      })
      .sort((left, right) => right.totalPoints - left.totalPoints || left.name.localeCompare(right.name)),
    auctionState: await (async () => {
      const rows = await db
        .select()
        .from(auctionState)
        .where(
          and(
            eq(auctionState.leagueId, leagueId),
            inArray(auctionState.status, ["nominating", "bidding", "paused"]),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        status: row.status,
        bidTimerSeconds: row.bidTimerSeconds,
        nominationTimerSeconds: row.nominationTimerSeconds,
        nominationOrder: row.nominationOrder,
        nominationIndex: row.nominationIndex,
        currentNominatorUserId: row.currentNominatorUserId,
        currentPlayerId: row.currentPlayerId,
        currentPlayerName: row.currentPlayerName,
        currentPlayerTeam: row.currentPlayerTeam,
        highBidAmount: row.highBidAmount,
        highBidUserId: row.highBidUserId,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        totalAwards: row.totalAwards,
      };
    })(),
    snakeState: await (async () => {
      const rows = await db
        .select()
        .from(snakeState)
        .where(
          and(
            eq(snakeState.leagueId, leagueId),
            inArray(snakeState.status, ["picking", "paused"]),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        status: row.status,
        timed: row.timed,
        pickTimerSeconds: row.pickTimerSeconds,
        pickOrder: row.pickOrder,
        currentPickIndex: row.currentPickIndex,
        currentPickerUserId: row.currentPickerUserId,
        totalPicks: row.totalPicks,
        currentRound: row.currentRound,
        totalRounds: row.totalRounds,
        expiresAt: row.expiresAt?.toISOString() ?? null,
      };
    })(),
    actions: access.isCommissioner
      ? await db
          .select()
          .from(leagueAction)
          .where(eq(leagueAction.leagueId, leagueId))
          .orderBy(desc(leagueAction.sequenceNumber))
          .limit(100)
      : [],
    livePoints: Object.fromEntries(await computeLivePointsByPlayer(rosteredPlayerIds)),
    liveGames: await (async () => {
      const now = new Date();
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      const endOfTomorrow = new Date(start);
      endOfTomorrow.setDate(start.getDate() + 2);
      const rows = await db
        .select()
        .from(nbaGame)
        .where(
          or(
            eq(nbaGame.status, "in"),
            and(gte(nbaGame.date, start), lt(nbaGame.date, endOfTomorrow)),
          ),
        )
        .orderBy(asc(nbaGame.startTime));
      return rows;
    })(),
  };
}

appRouter.get("/dashboard", async (c) => {
  const session = getRequiredSession(c);

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const memberships = await db
    .select({
      leagueId: league.id,
      leagueName: league.name,
      phase: league.phase,
      rosterSize: league.rosterSize,
      commissionerUserId: league.commissionerUserId,
      role: leagueMember.role,
      createdAt: league.createdAt,
      updatedAt: league.updatedAt,
    })
    .from(leagueMember)
    .innerJoin(league, eq(leagueMember.leagueId, league.id))
    .where(
      and(
        eq(leagueMember.userId, session.user.id),
        eq(leagueMember.status, "active"),
      ),
    )
    .orderBy(asc(league.createdAt));

  const leagueIds = memberships.map((membership) => membership.leagueId);
  const commissionerIds = Array.from(
    new Set(memberships.map((membership) => membership.commissionerUserId)),
  );
  const activeMembers = leagueIds.length
    ? await db
        .select()
        .from(leagueMember)
        .where(
          and(
            inArray(leagueMember.leagueId, leagueIds),
            eq(leagueMember.status, "active"),
          ),
        )
    : [];
  const commissioners = commissionerIds.length
    ? await db.select().from(user).where(inArray(user.id, commissionerIds))
    : [];
  const commissionerMap = new Map(
    commissioners.map((commissioner) => [commissioner.id, commissioner]),
  );
  const memberCountMap = new Map<string, number>();

  for (const member of activeMembers) {
    memberCountMap.set(member.leagueId, (memberCountMap.get(member.leagueId) ?? 0) + 1);
  }

  const invites = await db
    .select()
    .from(leagueInvite)
    .where(
      and(
        eq(leagueInvite.email, normalizeEmail(session.user.email)),
        eq(leagueInvite.status, "pending"),
      ),
    );

  const inviteLeagueIds = Array.from(new Set(invites.map((invite) => invite.leagueId)));
  const inviteLeagues = inviteLeagueIds.length
    ? await db.select().from(league).where(inArray(league.id, inviteLeagueIds))
    : [];
  const inviteLeagueMap = new Map(inviteLeagues.map((leagueRow) => [leagueRow.id, leagueRow]));
  const inviteUserIds = Array.from(new Set(invites.map((invite) => invite.invitedByUserId)));
  const inviteUsers = inviteUserIds.length
    ? await db.select().from(user).where(inArray(user.id, inviteUserIds))
    : [];
  const inviteUserMap = new Map(inviteUsers.map((inviteUser) => [inviteUser.id, inviteUser]));

  return c.json({
    currentUser: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      canCreateLeague:
        normalizeEmail(session.user.email) === LEAGUE_CREATOR_EMAIL,
    },
    leagues: memberships.map((membership) => ({
      id: membership.leagueId,
      name: membership.leagueName,
      phase: membership.phase,
      rosterSize: membership.rosterSize,
      memberCount: memberCountMap.get(membership.leagueId) ?? 0,
      role: membership.role,
      isCommissioner: membership.commissionerUserId === session.user.id,
      commissionerName:
        commissionerMap.get(membership.commissionerUserId)?.name ?? "Unknown",
    })),
    pendingInvites: invites.map((invite) => ({
      id: invite.id,
      leagueId: invite.leagueId,
      leagueName: inviteLeagueMap.get(invite.leagueId)?.name ?? "Unknown League",
      invitedByName: inviteUserMap.get(invite.invitedByUserId)?.name ?? "Unknown",
      createdAt: invite.createdAt,
    })),
  });
});

appRouter.post("/leagues", async (c) => {
  const session = getRequiredSession(c);

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  if (normalizeEmail(session.user.email) !== LEAGUE_CREATOR_EMAIL) {
    return c.json({ error: "League creation is limited to the commissioner account" }, 403);
  }

  const body = createLeagueSchema.safeParse(await c.req.json().catch(() => null));

  if (!body.success) {
    return c.json({ error: body.error.errors[0]?.message ?? "Invalid request" }, 400);
  }

  const now = new Date();
  const leagueId = randomUUID();

  await db.transaction(async (tx) => {
    await tx.insert(league).values({
      id: leagueId,
      name: body.data.name,
      commissionerUserId: session.user.id,
      phase: "invite",
      rosterSize: body.data.rosterSize,
      budgetPerTeam: 200,
      minBid: 1,
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(leagueMember).values({
      id: randomUUID(),
      leagueId,
      userId: session.user.id,
      role: "commissioner",
      status: "active",
      draftPriority: null,
      createdAt: now,
      updatedAt: now,
    });
  });

  return c.json({ ok: true, leagueId });
});

appRouter.post("/invites/:inviteId/accept", async (c) => {
  const session = getRequiredSession(c);

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const inviteId = c.req.param("inviteId");
  const inviteRows = await db
    .select()
    .from(leagueInvite)
    .where(eq(leagueInvite.id, inviteId))
    .limit(1);
  const invite = inviteRows[0];

  if (!invite || invite.status !== "pending") {
    return c.json({ error: "Invite not found" }, 404);
  }

  if (normalizeEmail(invite.email) !== normalizeEmail(session.user.email)) {
    return c.json({ error: "Invite email does not match your account" }, 403);
  }

  const activeMembers = await getLeagueMembers(invite.leagueId);
  const existingMembership = activeMembers.find((member) => member.userId === session.user.id);

  if (!existingMembership && activeMembers.length >= MAX_ACTIVE_MEMBERS) {
    return c.json({ error: "This league is already full" }, 400);
  }

  const now = new Date();

  await db.transaction(async (tx) => {
    if (!existingMembership) {
      await tx.insert(leagueMember).values({
        id: randomUUID(),
        leagueId: invite.leagueId,
        userId: session.user.id,
        role: "member",
        status: "active",
        draftPriority: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    await tx
      .update(leagueInvite)
      .set({
        status: "accepted",
        acceptedAt: now,
        acceptedByUserId: session.user.id,
        updatedAt: now,
      })
      .where(eq(leagueInvite.id, invite.id));
  });

  return c.json({ ok: true, leagueId: invite.leagueId });
});

appRouter.get("/leagues/:leagueId", async (c) => {
  const session = getRequiredSession(c);

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const detail = await buildLeagueDetailResponse(c.req.param("leagueId"), session.user.id);

  if (!detail) {
    return c.json({ error: "League not found" }, 404);
  }

  return c.json(detail);
});

appRouter.post("/leagues/:leagueId/settings", async (c) => {
  const session = getRequiredSession(c);

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const access = await getLeagueAccess(session.user.id, c.req.param("leagueId"));

  if (!access) {
    return c.json({ error: "League not found" }, 404);
  }

  if (!access.isCommissioner) {
    return c.json({ error: "Only the commissioner can update league settings" }, 403);
  }

  const body = updateLeagueSettingsSchema.safeParse(await c.req.json().catch(() => null));

  if (!body.success) {
    return c.json({ error: body.error.errors[0]?.message ?? "Invalid request" }, 400);
  }

  if (typeof body.data.rosterSize === "number") {
    const openRound = await db
      .select()
      .from(draftRound)
      .where(and(eq(draftRound.leagueId, access.league.id), eq(draftRound.status, "open")))
      .limit(1);

    if (openRound[0]) {
      return c.json({ error: "Close the active round before changing roster size" }, 400);
    }

    if (access.league.phase === "scoring") {
      return c.json({ error: "League settings are locked once scoring begins" }, 400);
    }

    const members = await getLeagueMembers(access.league.id);
    const rosterRows = await db
      .select()
      .from(rosterEntry)
      .where(eq(rosterEntry.leagueId, access.league.id));
    const rosterCountByUser = new Map<string, number>();

    for (const entry of rosterRows) {
      rosterCountByUser.set(entry.userId, (rosterCountByUser.get(entry.userId) ?? 0) + 1);
    }

    const maxRosterCount = Math.max(
      0,
      ...members.map((member) => rosterCountByUser.get(member.userId) ?? 0),
    );

    if (body.data.rosterSize < maxRosterCount) {
      return c.json({
        error: `Roster size cannot be smaller than the current largest roster (${maxRosterCount})`,
      }, 400);
    }
  }

  const updates: Partial<typeof league.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (typeof body.data.name === "string") {
    const trimmedName = body.data.name.trim();

    const conflictingLeague = await db
      .select({ id: league.id })
      .from(league)
      .where(eq(league.id, trimmedName))
      .limit(1);

    if (conflictingLeague[0]) {
      return c.json(
        { error: "League name cannot match an existing league ID" },
        400,
      );
    }

    updates.name = trimmedName;
  }

  if (typeof body.data.rosterSize === "number") {
    updates.rosterSize = body.data.rosterSize;
  }

  await db
    .update(league)
    .set(updates)
    .where(eq(league.id, access.league.id));

  return c.json({ ok: true });
});

appRouter.post("/leagues/:leagueId/members/:userId/remove", async (c) => {
  const session = getRequiredSession(c);

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const access = await getLeagueAccess(session.user.id, c.req.param("leagueId"));

  if (!access) {
    return c.json({ error: "League not found" }, 404);
  }

  if (!access.isCommissioner) {
    return c.json({ error: "Only the commissioner can remove members" }, 403);
  }

  const memberUserId = c.req.param("userId");

  if (memberUserId === access.league.commissionerUserId) {
    return c.json({ error: "The commissioner cannot be removed" }, 400);
  }

  const members = await getLeagueMembers(access.league.id);
  const targetMember = members.find((member) => member.userId === memberUserId);

  if (!targetMember) {
    return c.json({ error: "Member not found" }, 404);
  }

  const remainingMembers = members.filter((member) => member.userId !== memberUserId);
  const playerMap = await getPlayerPoolMapForAuction(
    auctionConfigFromLeague(access.league, remainingMembers.length),
  );
  const rosterRows = await db
    .select()
    .from(rosterEntry)
    .where(eq(rosterEntry.leagueId, access.league.id));
  const budgetAdj = await getBudgetAdjustments(access.league.id);
  const now = new Date();
  const remainingRosterRows = rosterRows.filter((entry) => entry.userId !== memberUserId);
  const remainingStates = buildMemberStates(
    access.league,
    remainingMembers,
    remainingRosterRows,
    playerMap,
    budgetAdj,
  );
  const nextPriorityOrder = remainingMembers
    .sort((left, right) => (left.draftPriority ?? 999) - (right.draftPriority ?? 999))
    .map((member) => member.userId)
    .filter((userId) => userId !== memberUserId);
  const hasDraftActivity =
    remainingRosterRows.length > 0 ||
    (
      await db
        .select()
        .from(draftRound)
        .where(eq(draftRound.leagueId, access.league.id))
        .limit(1)
    )[0] !== undefined;
  const leaguePhase = hasDraftActivity
    ? Array.from(remainingStates.values()).every((state) => state.remainingRosterSlots === 0)
      ? "scoring"
      : "draft"
    : "invite";

  const memberRosterRows = rosterRows.filter((entry) => entry.userId === memberUserId);

  await db.transaction(async (tx) => {
    await tx
      .delete(draftSubmission)
      .where(
        and(
          eq(draftSubmission.leagueId, access.league.id),
          eq(draftSubmission.userId, memberUserId),
        ),
      );

    await tx
      .delete(rosterEntry)
      .where(
        and(eq(rosterEntry.leagueId, access.league.id), eq(rosterEntry.userId, memberUserId)),
      );

    // Log a roster_remove action for each player on the removed member's roster
    if (memberRosterRows.length > 0) {
      const baseSeq = await nextSequenceNumber(tx, access.league.id);
      await tx.insert(leagueAction).values(
        memberRosterRows.map((entry, i) => ({
          id: randomUUID(),
          leagueId: access.league.id,
          type: "roster_remove" as const,
          userId: entry.userId,
          playerId: entry.playerId,
          amount: -entry.acquisitionBid,
          actorUserId: session.user.id,
          roundId: entry.acquisitionRoundId,
          sequenceNumber: baseSeq + i,
          metadata: {
            playerName: entry.playerName,
            playerTeam: entry.playerTeam,
            originalAcquisitionBid: entry.acquisitionBid,
            reason: "member_removed",
          },
          createdAt: now,
        })),
      );
    }

    await tx
      .update(leagueMember)
      .set({
        status: "removed",
        draftPriority: null,
        updatedAt: now,
      })
      .where(eq(leagueMember.id, targetMember.membershipId));

    await persistPriorityOrder(tx, remainingMembers, nextPriorityOrder, now);

    await tx
      .update(league)
      .set({
        phase: leaguePhase,
        updatedAt: now,
      })
      .where(eq(league.id, access.league.id));
  });

  return c.json({ ok: true });
});

// --- Commissioner: remove a single player from a roster ---
appRouter.post("/leagues/:leagueId/roster/:playerId/remove", async (c) => {
  const session = getRequiredSession(c);

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const access = await getLeagueAccess(session.user.id, c.req.param("leagueId"));

  if (!access) {
    return c.json({ error: "League not found" }, 404);
  }

  if (!access.isCommissioner) {
    return c.json({ error: "Only the commissioner can remove players from rosters" }, 403);
  }

  const playerId = c.req.param("playerId");

  const existingEntries = await db
    .select()
    .from(rosterEntry)
    .where(
      and(
        eq(rosterEntry.leagueId, access.league.id),
        eq(rosterEntry.playerId, playerId),
      ),
    )
    .limit(1);

  const entry = existingEntries[0];

  if (!entry) {
    return c.json({ error: "Player not found on any roster in this league" }, 404);
  }

  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .delete(rosterEntry)
      .where(eq(rosterEntry.id, entry.id));

    const seq = await nextSequenceNumber(tx, access.league.id);
    await tx.insert(leagueAction).values({
      id: randomUUID(),
      leagueId: access.league.id,
      type: "roster_remove",
      userId: entry.userId,
      playerId: entry.playerId,
      amount: -entry.acquisitionBid,
      actorUserId: session.user.id,
      roundId: entry.acquisitionRoundId,
      sequenceNumber: seq,
      metadata: {
        playerName: entry.playerName,
        playerTeam: entry.playerTeam,
        originalAcquisitionBid: entry.acquisitionBid,
        reason: "commissioner_override",
      },
      createdAt: now,
    });

    if (access.league.phase === "scoring") {
      await tx
        .update(league)
        .set({ phase: "draft", updatedAt: now })
        .where(eq(league.id, access.league.id));
    }
  });

  return c.json({ ok: true });
});

// --- Commissioner: add a player to a roster ---
appRouter.post("/leagues/:leagueId/roster/add", async (c) => {
  const session = getRequiredSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const access = await getLeagueAccess(session.user.id, c.req.param("leagueId"));
  if (!access) return c.json({ error: "League not found" }, 404);
  if (!access.isCommissioner) {
    return c.json({ error: "Only the commissioner can add players to rosters" }, 403);
  }

  const body = z
    .object({ userId: z.string(), playerId: z.string(), amount: z.number().int().min(0) })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Invalid request body" }, 400);

  // Check player is not already rostered
  const existing = await db
    .select()
    .from(rosterEntry)
    .where(
      and(eq(rosterEntry.leagueId, access.league.id), eq(rosterEntry.playerId, body.data.playerId)),
    )
    .limit(1);
  if (existing.length > 0) {
    return c.json({ error: "Player is already on a roster in this league" }, 400);
  }

  // Check target user is a member
  const members = await getLeagueMembers(access.league.id);
  const targetMember = members.find((m) => m.userId === body.data.userId);
  if (!targetMember) return c.json({ error: "Target user is not a member of this league" }, 404);

  // Resolve player info from pool
  const playerMap = await getPlayerPoolMapForAuction(
    auctionConfigFromLeague(access.league, members.length),
  );
  const player = playerMap.get(body.data.playerId);
  if (!player) return c.json({ error: "Player not found in pool" }, 404);

  // Check budget + slots
  const rosterRows = await db
    .select()
    .from(rosterEntry)
    .where(eq(rosterEntry.leagueId, access.league.id));
  const budgetAdj = await getBudgetAdjustments(access.league.id);
  const states = buildMemberStates(access.league, members, rosterRows, playerMap, budgetAdj);
  const state = states.get(body.data.userId);
  if (!state || state.remainingRosterSlots <= 0) {
    return c.json({ error: "Target user's roster is full" }, 400);
  }
  if (state.remainingBudget < body.data.amount) {
    return c.json({ error: "Target user does not have enough budget" }, 400);
  }

  const now = new Date();
  const maxOrder = rosterRows
    .filter((r) => r.userId === body.data.userId)
    .reduce((max, r) => Math.max(max, r.acquisitionOrder), 0);

  await db.transaction(async (tx) => {
    await tx.insert(rosterEntry).values({
      id: randomUUID(),
      leagueId: access.league.id,
      userId: body.data.userId,
      playerId: body.data.playerId,
      playerName: player.name,
      playerTeam: player.team,
      acquisitionRoundId: null,
      acquisitionOrder: maxOrder + 1,
      acquisitionBid: body.data.amount,
      wonByTiebreak: false,
      isAutoAssigned: false,
      createdAt: now,
      updatedAt: now,
    });

    const seq = await nextSequenceNumber(tx, access.league.id);
    await tx.insert(leagueAction).values({
      id: randomUUID(),
      leagueId: access.league.id,
      type: "roster_add",
      userId: body.data.userId,
      playerId: body.data.playerId,
      amount: body.data.amount,
      actorUserId: session.user.id,
      roundId: null,
      sequenceNumber: seq,
      metadata: {
        playerName: player.name,
        playerTeam: player.team,
      },
      createdAt: now,
    });
  });

  return c.json({ ok: true });
});

// --- Commissioner: adjust a member's budget ---
appRouter.post("/leagues/:leagueId/members/:userId/budget", async (c) => {
  const session = getRequiredSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const access = await getLeagueAccess(session.user.id, c.req.param("leagueId"));
  if (!access) return c.json({ error: "League not found" }, 404);
  if (!access.isCommissioner) {
    return c.json({ error: "Only the commissioner can adjust budgets" }, 403);
  }

  const body = z
    .object({ amount: z.number().int(), reason: z.string().min(1).max(200) })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Invalid request body" }, 400);

  const targetUserId = c.req.param("userId");
  const members = await getLeagueMembers(access.league.id);
  if (!members.find((m) => m.userId === targetUserId)) {
    return c.json({ error: "Target user is not a member of this league" }, 404);
  }

  const now = new Date();

  await db.transaction(async (tx) => {
    const seq = await nextSequenceNumber(tx, access.league.id);
    await tx.insert(leagueAction).values({
      id: randomUUID(),
      leagueId: access.league.id,
      type: "budget_adjust",
      userId: targetUserId,
      playerId: null,
      amount: body.data.amount,
      actorUserId: session.user.id,
      roundId: null,
      sequenceNumber: seq,
      metadata: { reason: body.data.reason },
      createdAt: now,
    });
  });

  return c.json({ ok: true });
});

appRouter.post("/leagues/:leagueId/invites", async (c) => {
  const session = getRequiredSession(c);

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const access = await getLeagueAccess(session.user.id, c.req.param("leagueId"));

  if (!access) {
    return c.json({ error: "League not found" }, 404);
  }

  if (!access.isCommissioner) {
    return c.json({ error: "Only the commissioner can invite members" }, 403);
  }

  const body = inviteSchema.safeParse(await c.req.json().catch(() => null));

  if (!body.success) {
    return c.json({ error: body.error.errors[0]?.message ?? "Invalid request" }, 400);
  }

  const members = await getLeagueMembers(access.league.id);
  const memberEmails = new Set(members.map((member) => normalizeEmail(member.email)));
  const pendingInvites = await getPendingLeagueInvites(access.league.id);
  const pendingEmails = new Set(pendingInvites.map((invite) => normalizeEmail(invite.email)));
  const now = new Date();
  const created: string[] = [];
  const skipped: string[] = [];
  let capacityRemaining =
    MAX_ACTIVE_MEMBERS - members.length - pendingInvites.length;

  for (const rawEmail of body.data.emails) {
    const email = normalizeEmail(rawEmail);

    if (memberEmails.has(email) || pendingEmails.has(email)) {
      skipped.push(email);
      continue;
    }

    if (capacityRemaining <= 0) {
      skipped.push(email);
      continue;
    }

    const existingInvite = await db
      .select()
      .from(leagueInvite)
      .where(and(eq(leagueInvite.leagueId, access.league.id), eq(leagueInvite.email, email)))
      .limit(1);

    if (existingInvite[0]) {
      await db
        .update(leagueInvite)
        .set({
          status: "pending",
          invitedByUserId: session.user.id,
          acceptedAt: null,
          acceptedByUserId: null,
          updatedAt: now,
        })
        .where(eq(leagueInvite.id, existingInvite[0].id));
    } else {
      await db.insert(leagueInvite).values({
        id: randomUUID(),
        leagueId: access.league.id,
        email,
        invitedByUserId: session.user.id,
        status: "pending",
        acceptedByUserId: null,
        createdAt: now,
        updatedAt: now,
        acceptedAt: null,
      });
    }

    created.push(email);
    pendingEmails.add(email);
    capacityRemaining -= 1;
  }

  await db
    .update(league)
    .set({
      updatedAt: now,
    })
    .where(eq(league.id, access.league.id));

  return c.json({ ok: true, created, skipped });
});

appRouter.post("/leagues/:leagueId/draft/rounds", async (c) => {
  const session = getRequiredSession(c);

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const access = await getLeagueAccess(session.user.id, c.req.param("leagueId"));

  if (!access) {
    return c.json({ error: "League not found" }, 404);
  }

  if (!access.isCommissioner) {
    return c.json({ error: "Only the commissioner can open a round" }, 403);
  }

  if (access.league.phase === "scoring") {
    return c.json({ error: "Draft is already complete" }, 400);
  }

  const existingOpenRound = await db
    .select()
    .from(draftRound)
    .where(and(eq(draftRound.leagueId, access.league.id), eq(draftRound.status, "open")))
    .limit(1);

  if (existingOpenRound[0]) {
    return c.json({ error: "There is already an open round" }, 400);
  }

  const body = openRoundSchema.safeParse(await c.req.json().catch(() => null));

  if (!body.success) {
    return c.json({ error: body.error.errors[0]?.message ?? "Invalid request" }, 400);
  }

  const members = await getLeagueMembers(access.league.id);

  if (members.length < 2) {
    return c.json({ error: "Add at least one other manager before drafting" }, 400);
  }

  const players = await getPlayerPoolForAuction(
    auctionConfigFromLeague(access.league, members.length),
  );
  const rosterRows = await db
    .select()
    .from(rosterEntry)
    .where(eq(rosterEntry.leagueId, access.league.id));
  const rosteredPlayerIds = new Set(rosterRows.map((entry) => entry.playerId));
  const availablePlayers = players.filter((player) => !rosteredPlayerIds.has(player.id));

  if (!availablePlayers.length) {
    return c.json({ error: "No players remain to be drafted" }, 400);
  }

  const availablePlayerIds = new Set(availablePlayers.map((player) => player.id));
  const selectedPlayerIds =
    body.data.mode === "all_remaining"
      ? availablePlayers.map((player) => player.id)
      : (body.data.playerIds ?? []).filter((playerId) => availablePlayerIds.has(playerId));

  if (!selectedPlayerIds.length) {
    return c.json({ error: "Select at least one eligible player" }, 400);
  }

  const latestRound = await db
    .select()
    .from(draftRound)
    .where(eq(draftRound.leagueId, access.league.id))
    .orderBy(desc(draftRound.roundNumber))
    .limit(1);

  const now = new Date();
  const roundId = randomUUID();
  const roundNumber = (latestRound[0]?.roundNumber ?? 0) + 1;
  const deadlineAt = body.data.deadlineAt ? new Date(body.data.deadlineAt) : null;

  await db.transaction(async (tx) => {
    await ensureDraftPriorityOrder(tx, access.league.id, members, now);

    await tx.insert(draftRound).values({
      id: roundId,
      leagueId: access.league.id,
      roundNumber,
      status: "open",
      eligiblePlayerMode: body.data.mode,
      openedByUserId: session.user.id,
      closedByUserId: null,
      createdAt: now,
      updatedAt: now,
      openedAt: now,
      deadlineAt,
      closedAt: null,
      resolvedAt: null,
    });

    await tx.insert(draftRoundPlayer).values(
      selectedPlayerIds.map((playerId) => ({
        id: randomUUID(),
        roundId,
        leagueId: access.league.id,
        playerId,
        createdAt: now,
      })),
    );

    await tx
      .update(league)
      .set({
        phase: "draft",
        updatedAt: now,
      })
      .where(eq(league.id, access.league.id));

    const seq = await nextSequenceNumber(tx, access.league.id);
    await tx.insert(leagueAction).values({
      id: randomUUID(),
      leagueId: access.league.id,
      type: "round_opened",
      userId: null,
      playerId: null,
      amount: null,
      actorUserId: session.user.id,
      roundId,
      sequenceNumber: seq,
      metadata: {
        roundNumber,
        eligiblePlayerMode: body.data.mode,
        playerCount: selectedPlayerIds.length,
        deadlineAt: deadlineAt?.toISOString() ?? null,
      },
      createdAt: now,
    });
  });

  return c.json({ ok: true, roundId });
});

appRouter.post("/leagues/:leagueId/draft/rounds/:roundId/submission", async (c) => {
  const session = getRequiredSession(c);

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const access = await getLeagueAccess(session.user.id, c.req.param("leagueId"));

  if (!access) {
    return c.json({ error: "League not found" }, 404);
  }

  const roundRows = await db
    .select()
    .from(draftRound)
    .where(
      and(
        eq(draftRound.id, c.req.param("roundId")),
        eq(draftRound.leagueId, access.league.id),
        eq(draftRound.status, "open"),
      ),
    )
    .limit(1);
  const round = roundRows[0];

  if (!round) {
    return c.json({ error: "Open round not found" }, 404);
  }

  const body = submitBidsSchema.safeParse(await c.req.json().catch(() => null));

  if (!body.success) {
    console.warn(`[submission] 400 invalid body: user=${session.user.id}`, body.error.errors[0]?.message);
    return c.json({ error: body.error.errors[0]?.message ?? "Invalid request" }, 400);
  }

  const members = await getLeagueMembers(access.league.id);
  const playerMap = await getPlayerPoolMapForAuction(
    auctionConfigFromLeague(access.league, members.length),
  );
  const eligiblePlayers = await db
    .select()
    .from(draftRoundPlayer)
    .where(eq(draftRoundPlayer.roundId, round.id));
  const eligiblePlayerIds = new Set(eligiblePlayers.map((player) => player.playerId));
  const rosterRows = await db
    .select()
    .from(rosterEntry)
    .where(eq(rosterEntry.leagueId, access.league.id));
  const budgetAdj = await getBudgetAdjustments(access.league.id);
  const memberStates = buildMemberStates(access.league, members, rosterRows, playerMap, budgetAdj);
  const viewerState = memberStates.get(session.user.id);

  const maxAllowed = viewerState
    ? computeMaxBid(viewerState.remainingBudget, viewerState.remainingRosterSlots, access.league.minBid)
    : 0;

  // Filter bids to only valid ones — skip invalid players instead of rejecting the whole submission.
  const validatedBids: Record<string, number> = {};
  for (const [playerId, amount] of Object.entries(body.data.bids)) {
    if (!eligiblePlayerIds.has(playerId)) {
      console.warn(`[submission] skipping player not in round: user=${session.user.id} player=${playerId}`);
      continue;
    }
    if (amount === 0) {
      validatedBids[playerId] = 0;
      continue;
    }
    if (amount < access.league.minBid) {
      console.warn(`[submission] skipping below min: user=${session.user.id} player=${playerId} bid=${amount} min=${access.league.minBid}`);
      continue;
    }
    if (amount > maxAllowed) {
      console.warn(`[submission] capping over max: user=${session.user.id} player=${playerId} bid=${amount} max=${maxAllowed}`);
    }
    validatedBids[playerId] = Math.min(amount, maxAllowed);
  }

  const now = new Date();
  const existingSubmission = await db
    .select()
    .from(draftSubmission)
    .where(and(eq(draftSubmission.roundId, round.id), eq(draftSubmission.userId, session.user.id)))
    .limit(1);

  const submissionId = existingSubmission[0]?.id ?? randomUUID();

  await db.transaction(async (tx) => {
    if (existingSubmission[0]) {
      await tx
        .update(draftSubmission)
        .set({
          updatedAt: now,
          submittedAt: now,
        })
        .where(eq(draftSubmission.id, submissionId));

      await tx.delete(draftBid).where(eq(draftBid.submissionId, submissionId));
    } else {
      await tx.insert(draftSubmission).values({
        id: submissionId,
        roundId: round.id,
        leagueId: access.league.id,
        userId: session.user.id,
        createdAt: now,
        updatedAt: now,
        submittedAt: now,
      });
    }

    const bidEntries = Object.entries(validatedBids);

    if (bidEntries.length) {
      await tx.insert(draftBid).values(
        bidEntries.map(([playerId, amount]) => ({
          id: randomUUID(),
          submissionId,
          playerId,
          encryptedAmount: encryptBidAmount(amount),
          isAutoDefault: false,
          createdAt: now,
          updatedAt: now,
        })),
      );
    }
  });

  return c.json({ ok: true });
});

// Commissioner can add players to an existing open round
appRouter.post("/leagues/:leagueId/draft/rounds/:roundId/add-players", async (c) => {
  const session = getRequiredSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  const access = await getLeagueAccess(session.user.id, c.req.param("leagueId"));

  if (!access || !access.isCommissioner) {
    return c.json({ error: "Only the commissioner can add players" }, 403);
  }

  const round = await db
    .select()
    .from(draftRound)
    .where(
      and(
        eq(draftRound.id, c.req.param("roundId")),
        eq(draftRound.leagueId, access.league.id),
      ),
    )
    .then((rows) => rows[0]);

  if (!round || round.status !== "open") {
    return c.json({ error: "Round is not open" }, 400);
  }

  const body = await c.req.json().catch(() => null);
  const playerIds: string[] = body?.playerIds;

  if (!Array.isArray(playerIds) || !playerIds.length) {
    return c.json({ error: "Provide playerIds array" }, 400);
  }

  // Validate: players must exist and not already be rostered or in this round
  const players = await getPlayerPoolForAuction(
    auctionConfigFromLeague(access.league, (await getLeagueMembers(access.league.id)).length),
  );
  const playerMap = new Map(players.map((p) => [p.id, p]));
  const rosterRows = await db.select().from(rosterEntry).where(eq(rosterEntry.leagueId, access.league.id));
  const rosteredIds = new Set(rosterRows.map((r) => r.playerId));
  const existingRoundPlayers = await db.select().from(draftRoundPlayer).where(eq(draftRoundPlayer.roundId, round.id));
  const existingIds = new Set(existingRoundPlayers.map((p) => p.playerId));

  const toAdd = playerIds.filter((id) => playerMap.has(id) && !rosteredIds.has(id) && !existingIds.has(id));

  if (!toAdd.length) {
    return c.json({ error: "No eligible players to add" }, 400);
  }

  for (const playerId of toAdd) {
    await db.insert(draftRoundPlayer).values({
      id: randomUUID(),
      leagueId: access.league.id,
      roundId: round.id,
      playerId,
    });
  }

  return c.json({ ok: true, added: toAdd.length });
});

appRouter.post("/leagues/:leagueId/draft/rounds/:roundId/close", async (c) => {
  const session = getRequiredSession(c);

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const access = await getLeagueAccess(session.user.id, c.req.param("leagueId"));

  if (!access) {
    return c.json({ error: "League not found" }, 404);
  }

  if (!access.isCommissioner) {
    return c.json({ error: "Only the commissioner can close a round" }, 403);
  }

  const roundRows = await db
    .select()
    .from(draftRound)
    .where(
      and(
        eq(draftRound.id, c.req.param("roundId")),
        eq(draftRound.leagueId, access.league.id),
        eq(draftRound.status, "open"),
      ),
    )
    .limit(1);
  const round = roundRows[0];

  if (!round) {
    return c.json({ error: "Open round not found" }, 404);
  }

  const members = await getLeagueMembers(access.league.id);
  const playerMap = await getPlayerPoolMapForAuction(
    auctionConfigFromLeague(access.league, members.length),
  );
  const rosterRows = await db
    .select()
    .from(rosterEntry)
    .where(eq(rosterEntry.leagueId, access.league.id));
  const budgetAdj = await getBudgetAdjustments(access.league.id);
  const startingStates = buildMemberStates(access.league, members, rosterRows, playerMap, budgetAdj);
  const roundPlayers = await db
    .select()
    .from(draftRoundPlayer)
    .where(eq(draftRoundPlayer.roundId, round.id));
  const eligiblePlayers = roundPlayers
    .map((roundPlayer) => playerMap.get(roundPlayer.playerId))
    .filter((player): player is NonNullable<typeof player> => Boolean(player));

  const submissions = await db
    .select()
    .from(draftSubmission)
    .where(eq(draftSubmission.roundId, round.id));
  const bids = submissions.length
    ? await db
        .select()
        .from(draftBid)
        .where(inArray(draftBid.submissionId, submissions.map((submission) => submission.id)))
    : [];

  const membersWithPriority = members.every((member) => member.draftPriority !== null)
    ? [...members].sort((left, right) => (left.draftPriority ?? 0) - (right.draftPriority ?? 0))
    : shuffle(members).map((member, index) => ({
        ...member,
        draftPriority: index + 1,
      }));

  let priorityOrder = membersWithPriority.map((member) => member.userId);
  const explicitBidMapByUser = new Map<string, Map<string, number>>();
  const submissionIdByUser = new Map<string, string>();

  for (const submission of submissions) {
    submissionIdByUser.set(submission.userId, submission.id);
    explicitBidMapByUser.set(
      submission.userId,
      new Map(
        bids
          .filter((bid) => bid.submissionId === submission.id && !bid.isAutoDefault)
          .map((bid) => [bid.playerId, decryptBidAmount(bid.encryptedAmount)]),
      ),
    );
  }

  const now = new Date();
  const mutableStates = new Map(
    Array.from(startingStates.entries()).map(([userId, state]) => [
      userId,
      {
        ...state,
      },
    ]),
  );
  const autoBidsToInsert: Array<typeof draftBid.$inferInsert> = [];
  const effectiveBidMapByUser = new Map<string, Map<string, number>>();

  const isAllRemainingRound = round.eligiblePlayerMode === "all_remaining";

  for (const member of membersWithPriority) {
    const state = mutableStates.get(member.userId)!;
    const maxAllowed = computeMaxBid(
      state.remainingBudget,
      state.remainingRosterSlots,
      access.league.minBid,
    );
    const submissionId = submissionIdByUser.get(member.userId) ?? randomUUID();
    const explicitBidMap = explicitBidMapByUser.get(member.userId) ?? new Map<string, number>();
    const memberSubmittedAnyBids = explicitBidMap.size > 0;
    const effectiveBidMap = new Map<string, number>();

    for (const player of eligiblePlayers) {
      if (state.remainingRosterSlots <= 0) {
        continue;
      }

      const explicitBid = explicitBidMap.get(player.id);
      let effectiveBid: number;

      if (explicitBid === 0) {
        // Explicit 0 bid means "I do not want this player" — treat as pass.
        effectiveBid = 0;
      } else if (explicitBid !== undefined) {
        // Non-zero explicit bid — clamp to [minBid, maxAllowed].
        if (maxAllowed < access.league.minBid) {
          effectiveBid = 0;
        } else {
          effectiveBid = Math.max(
            access.league.minBid,
            Math.min(explicitBid, maxAllowed),
          );
        }
      } else if (maxAllowed < access.league.minBid) {
        effectiveBid = 0;
      } else if (isAllRemainingRound && memberSubmittedAnyBids) {
        // All-remaining round + member submitted bids: unspecified players
        // default to $0 (pass). The member chose which players to bid on.
        effectiveBid = 0;
      } else if (memberSubmittedAnyBids) {
        // Normal round + member submitted bids for some players but not this one —
        // use exact suggested value (no noise) as the auto-pick.
        effectiveBid = Math.max(
          access.league.minBid,
          Math.min(player.suggestedValue, maxAllowed),
        );
      } else {
        // Member submitted no bids at all — use noisy default (auto-draft).
        effectiveBid = sampleDefaultAutoBid(player.suggestedValue, maxAllowed);
      }

      effectiveBidMap.set(player.id, effectiveBid);

      if (!explicitBidMap.has(player.id)) {
        autoBidsToInsert.push({
          id: randomUUID(),
          submissionId,
          playerId: player.id,
          encryptedAmount: encryptBidAmount(effectiveBid),
          isAutoDefault: true,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    effectiveBidMapByUser.set(member.userId, effectiveBidMap);
    submissionIdByUser.set(member.userId, submissionId);
  }

  const remainingPlayerIds = new Set(
    eligiblePlayers
      .map((player) => player.id)
      .filter((playerId) => !rosterRows.some((entry) => entry.playerId === playerId)),
  );

  const awards: Array<{
    playerId: string;
    playerName: string;
    playerTeam: string;
    winnerUserId: string;
    acquisitionBid: number;
    acquisitionOrder: number;
    wonByTiebreak: boolean;
    isAutoAssigned: boolean;
  }> = [];

  let acquisitionOrder = 1;

  while (remainingPlayerIds.size) {
    let bestCandidate:
      | {
          playerId: string;
          topBid: number;
          suggestedValue: number;
          contenders: string[];
        }
      | null = null;

    for (const playerId of remainingPlayerIds) {
      const player = playerMap.get(playerId);

      if (!player) {
        continue;
      }

      let topBid = 0;
      let contenders: string[] = [];

      for (const member of membersWithPriority) {
        const state = mutableStates.get(member.userId)!;

        if (state.remainingRosterSlots <= 0) {
          continue;
        }

        const currentMaxBid = computeMaxBid(
          state.remainingBudget,
          state.remainingRosterSlots,
          access.league.minBid,
        );
        const bidAmount = effectiveBidMapByUser.get(member.userId)?.get(playerId) ?? 0;

        // A 0 bid means the member passed on this player; exclude from contention.
        if (
          bidAmount <= 0 ||
          bidAmount < access.league.minBid ||
          bidAmount > currentMaxBid ||
          bidAmount > state.remainingBudget
        ) {
          continue;
        }

        if (bidAmount > topBid) {
          topBid = bidAmount;
          contenders = [member.userId];
        } else if (bidAmount === topBid) {
          contenders.push(member.userId);
        }
      }

      if (topBid < access.league.minBid || !contenders.length) {
        continue;
      }

      if (
        !bestCandidate ||
        topBid > bestCandidate.topBid ||
        (topBid === bestCandidate.topBid &&
          player.suggestedValue > bestCandidate.suggestedValue) ||
        (topBid === bestCandidate.topBid &&
          player.suggestedValue === bestCandidate.suggestedValue &&
          player.name.localeCompare(playerMap.get(bestCandidate.playerId)?.name ?? "") < 0)
      ) {
        bestCandidate = {
          playerId,
          topBid,
          suggestedValue: player.suggestedValue,
          contenders,
        };
      }
    }

    if (!bestCandidate) {
      break;
    }

    const sortedContenders = [...bestCandidate.contenders].sort(
      (left, right) => priorityOrder.indexOf(left) - priorityOrder.indexOf(right),
    );
    const winnerUserId = sortedContenders[0];
    const player = playerMap.get(bestCandidate.playerId)!;
    const winnerState = mutableStates.get(winnerUserId)!;

    awards.push({
      playerId: bestCandidate.playerId,
      playerName: player.name,
      playerTeam: player.team,
      winnerUserId,
      acquisitionBid: bestCandidate.topBid,
      acquisitionOrder,
      wonByTiebreak: sortedContenders.length > 1,
      isAutoAssigned: false,
    });

    acquisitionOrder += 1;
    winnerState.remainingBudget -= bestCandidate.topBid;
    winnerState.remainingRosterSlots -= 1;
    remainingPlayerIds.delete(bestCandidate.playerId);

    if (sortedContenders.length > 1) {
      priorityOrder = moveWinnerToEnd(priorityOrder, winnerUserId);
    }
  }

  // After an all-remaining round, any team that still has empty roster slots is
  // filled by auto-assigning leftover players at $1 apiece. Teams receive
  // players in tiebreaker priority order, and the best available player (by
  // total projected points) is handed out first.
  if (isAllRemainingRound) {
    const leftoverPlayers = Array.from(remainingPlayerIds)
      .map((playerId) => playerMap.get(playerId))
      .filter((player): player is NonNullable<typeof player> => Boolean(player))
      .sort((left, right) => {
        const leftPoints = left.totalPoints ?? 0;
        const rightPoints = right.totalPoints ?? 0;

        if (rightPoints !== leftPoints) {
          return rightPoints - leftPoints;
        }

        return left.name.localeCompare(right.name);
      });

    let keepAssigning = true;

    while (keepAssigning && leftoverPlayers.length) {
      keepAssigning = false;

      for (const memberUserId of priorityOrder) {
        const state = mutableStates.get(memberUserId);

        if (!state || state.remainingRosterSlots <= 0) {
          continue;
        }

        if (!leftoverPlayers.length) {
          break;
        }

        const nextPlayer = leftoverPlayers.shift()!;

        awards.push({
          playerId: nextPlayer.id,
          playerName: nextPlayer.name,
          playerTeam: nextPlayer.team,
          winnerUserId: memberUserId,
          acquisitionBid: 1,
          acquisitionOrder,
          wonByTiebreak: false,
          isAutoAssigned: true,
        });

        acquisitionOrder += 1;
        state.remainingBudget = Math.max(0, state.remainingBudget - 1);
        state.remainingRosterSlots -= 1;
        remainingPlayerIds.delete(nextPlayer.id);
        keepAssigning = true;
      }
    }
  }

  await db.transaction(async (tx) => {
    await persistPriorityOrder(tx, membersWithPriority, priorityOrder, now);

    for (const member of membersWithPriority) {
      const submissionId = submissionIdByUser.get(member.userId)!;
      const existingSubmission = submissions.find((submission) => submission.userId === member.userId);

      if (!existingSubmission) {
        await tx.insert(draftSubmission).values({
          id: submissionId,
          roundId: round.id,
          leagueId: access.league.id,
          userId: member.userId,
          createdAt: now,
          updatedAt: now,
          submittedAt: now,
        });
      }
    }

    if (autoBidsToInsert.length) {
      await tx.insert(draftBid).values(autoBidsToInsert);
    }

    if (awards.length) {
      await tx.insert(rosterEntry).values(
        awards.map((award) => ({
          id: randomUUID(),
          leagueId: access.league.id,
          userId: award.winnerUserId,
          playerId: award.playerId,
          playerName: award.playerName,
          playerTeam: award.playerTeam,
          acquisitionRoundId: round.id,
          acquisitionOrder: award.acquisitionOrder,
          acquisitionBid: award.acquisitionBid,
          wonByTiebreak: award.wonByTiebreak,
          isAutoAssigned: award.isAutoAssigned,
          createdAt: now,
          updatedAt: now,
        })),
      );
    }

    const draftComplete = Array.from(mutableStates.values()).every(
      (state) => state.remainingRosterSlots === 0,
    );

    await tx
      .update(draftRound)
      .set({
        status: "resolved",
        closedByUserId: session.user.id,
        closedAt: now,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(eq(draftRound.id, round.id));

    await tx
      .update(league)
      .set({
        phase: draftComplete ? "scoring" : "draft",
        updatedAt: now,
      })
      .where(eq(league.id, access.league.id));

    // Log actions: round_closed + draft_award per awarded player
    const baseSeq = await nextSequenceNumber(tx, access.league.id);
    const actionValues: Array<typeof leagueAction.$inferInsert> = [
      {
        id: randomUUID(),
        leagueId: access.league.id,
        type: "round_closed",
        userId: null,
        playerId: null,
        amount: null,
        actorUserId: session.user.id,
        roundId: round.id,
        sequenceNumber: baseSeq,
        metadata: {
          roundNumber: round.roundNumber,
          awardCount: awards.length,
        },
        createdAt: now,
      },
      ...awards.map((award, i) => ({
        id: randomUUID(),
        leagueId: access.league.id,
        type: "draft_award" as const,
        userId: award.winnerUserId,
        playerId: award.playerId,
        amount: award.acquisitionBid,
        actorUserId: session.user.id,
        roundId: round.id,
        sequenceNumber: baseSeq + 1 + i,
        metadata: {
          playerName: award.playerName,
          playerTeam: award.playerTeam,
          roundNumber: round.roundNumber,
          acquisitionOrder: award.acquisitionOrder,
          wonByTiebreak: award.wonByTiebreak,
          isAutoAssigned: award.isAutoAssigned,
        },
        createdAt: now,
      })),
    ];

    if (actionValues.length > 0) {
      await tx.insert(leagueAction).values(actionValues);
    }
  });

  return c.json({
    ok: true,
    awards: awards.length,
    leaguePhase:
      Array.from(mutableStates.values()).every((state) => state.remainingRosterSlots === 0)
        ? "scoring"
        : "draft",
  });
});

// ====================== LIVE AUCTION DRAFT ======================

const startAuctionSchema = z.object({
  bidTimerSeconds: z.number().int().min(5).max(60).default(10),
  nominationTimerSeconds: z.number().int().min(15).max(120).default(30),
  orderMode: z.enum(["draft_priority", "random"]).default("draft_priority"),
});

const nominateSchema = z.object({
  playerId: z.string(),
  playerName: z.string(),
  playerTeam: z.string(),
  openingBid: z.number().int().min(1),
});

const auctionBidSchema = z.object({
  amount: z.number().int().min(1),
});

const undoAwardSchema = z.object({
  playerId: z.string().optional(),
});

// Start auction
appRouter.post("/leagues/:leagueId/auction/start", async (c) => {
  const session = getRequiredSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const { leagueId } = c.req.param();
  const access = await getLeagueAccess(session.user.id, leagueId);
  if (!access) return c.json({ error: "Not found" }, 404);
  if (!access.isCommissioner) return c.json({ error: "Commissioner only" }, 403);

  if (access.league.phase === "scoring") {
    return c.json({ error: "League is already in scoring phase" }, 400);
  }

  // Check no active auction
  const existing = await db
    .select({ id: auctionState.id })
    .from(auctionState)
    .where(
      and(
        eq(auctionState.leagueId, leagueId),
        inArray(auctionState.status, ["nominating", "bidding", "paused"]),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    return c.json({ error: "An auction is already active" }, 400);
  }

  // Check no active snake draft
  const existingSnake = await db
    .select({ id: snakeState.id })
    .from(snakeState)
    .where(
      and(
        eq(snakeState.leagueId, leagueId),
        inArray(snakeState.status, ["picking", "paused"]),
      ),
    )
    .limit(1);
  if (existingSnake.length > 0) {
    return c.json({ error: "A snake draft is already active" }, 400);
  }

  const body = startAuctionSchema.parse(await c.req.json());
  const members = await getLeagueMembers(leagueId);

  if (members.length < 2) {
    return c.json({ error: "Need at least 2 members" }, 400);
  }

  const now = new Date();
  let nominationOrder: string[];

  if (body.orderMode === "random") {
    nominationOrder = shuffle(members.map((m) => m.userId));
  } else {
    const sorted = await db.transaction(async (tx) => {
      return ensureDraftPriorityOrder(tx, leagueId, members, now);
    });
    nominationOrder = sorted.map((m) => m.userId);
  }

  const auctionId = randomUUID();
  const firstNominator = nominationOrder[0];

  await db.transaction(async (tx) => {
    await tx.insert(auctionState).values({
      id: auctionId,
      leagueId,
      status: "nominating",
      bidTimerSeconds: body.bidTimerSeconds,
      nominationTimerSeconds: body.nominationTimerSeconds,
      nominationOrder,
      nominationIndex: 0,
      currentNominatorUserId: firstNominator,
      createdAt: now,
      updatedAt: now,
    });

    const seq = await nextSequenceNumber(tx, leagueId);
    await tx.insert(leagueAction).values({
      id: randomUUID(),
      leagueId,
      type: "auction_start",
      actorUserId: session.user.id,
      sequenceNumber: seq,
      metadata: {
        bidTimerSeconds: body.bidTimerSeconds,
        nominationTimerSeconds: body.nominationTimerSeconds,
        nominationOrder,
      },
      createdAt: now,
    });

    await tx
      .update(league)
      .set({ phase: "draft", updatedAt: now })
      .where(eq(league.id, leagueId));
  });

  // Fetch the inserted row and start the engine
  const [stateRow] = await db.select().from(auctionState).where(eq(auctionState.id, auctionId));
  const engine = startAuction(leagueId, stateRow);
  engine.restartNominationTimer(body.nominationTimerSeconds * 1000);

  return c.json({ ok: true, auctionId });
});

// SSE stream
appRouter.get("/leagues/:leagueId/auction/stream", async (c) => {
  const session = getRequiredSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const { leagueId } = c.req.param();
  const access = await getLeagueAccess(session.user.id, leagueId);
  if (!access) return c.json({ error: "Not found" }, 404);

  const engine = getAuction(leagueId);
  if (!engine) return c.json({ error: "No active auction" }, 404);

  return streamSSE(c, async (stream) => {
    engine.addClient(stream);

    // Send current state immediately
    await stream.writeSSE({
      event: "state",
      data: JSON.stringify(engine.getStateSnapshot()),
    });

    stream.onAbort(() => {
      engine.removeClient(stream);
    });

    // Keep alive
    while (true) {
      await stream.sleep(30_000);
      await stream.writeSSE({ event: "ping", data: "" });
    }
  });
});

// Current state (non-SSE fallback)
appRouter.get("/leagues/:leagueId/auction/state", async (c) => {
  const session = getRequiredSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const { leagueId } = c.req.param();
  const access = await getLeagueAccess(session.user.id, leagueId);
  if (!access) return c.json({ error: "Not found" }, 404);

  const engine = getAuction(leagueId);
  if (!engine) return c.json({ error: "No active auction" }, 404);

  return c.json(engine.getStateSnapshot());
});

// Nominate
appRouter.post("/leagues/:leagueId/auction/nominate", async (c) => {
  const session = getRequiredSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const { leagueId } = c.req.param();
  const access = await getLeagueAccess(session.user.id, leagueId);
  if (!access) return c.json({ error: "Not found" }, 404);

  const engine = getAuction(leagueId);
  if (!engine) return c.json({ error: "No active auction" }, 404);

  const body = nominateSchema.parse(await c.req.json());
  const result = await engine.enqueue({
    type: "nominate",
    userId: session.user.id,
    playerId: body.playerId,
    playerName: body.playerName,
    playerTeam: body.playerTeam,
    openingBid: body.openingBid,
  });

  return c.json(result, result.ok ? 200 : 400);
});

// Bid
appRouter.post("/leagues/:leagueId/auction/bid", async (c) => {
  const session = getRequiredSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const { leagueId } = c.req.param();
  const access = await getLeagueAccess(session.user.id, leagueId);
  if (!access) return c.json({ error: "Not found" }, 404);

  const engine = getAuction(leagueId);
  if (!engine) return c.json({ error: "No active auction" }, 404);

  const body = auctionBidSchema.parse(await c.req.json());
  const result = await engine.enqueue({
    type: "bid",
    userId: session.user.id,
    amount: body.amount,
    receivedAt: new Date(),
  });

  return c.json(result, result.ok ? 200 : 400);
});

// Pause
appRouter.post("/leagues/:leagueId/auction/pause", async (c) => {
  const session = getRequiredSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const { leagueId } = c.req.param();
  const access = await getLeagueAccess(session.user.id, leagueId);
  if (!access) return c.json({ error: "Not found" }, 404);
  if (!access.isCommissioner) return c.json({ error: "Commissioner only" }, 403);

  const engine = getAuction(leagueId);
  if (!engine) return c.json({ error: "No active auction" }, 404);

  const result = await engine.enqueue({ type: "pause", actorUserId: session.user.id });
  return c.json(result, result.ok ? 200 : 400);
});

// Resume
appRouter.post("/leagues/:leagueId/auction/resume", async (c) => {
  const session = getRequiredSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const { leagueId } = c.req.param();
  const access = await getLeagueAccess(session.user.id, leagueId);
  if (!access) return c.json({ error: "Not found" }, 404);
  if (!access.isCommissioner) return c.json({ error: "Commissioner only" }, 403);

  const engine = getAuction(leagueId);
  if (!engine) return c.json({ error: "No active auction" }, 404);

  const result = await engine.enqueue({ type: "resume", actorUserId: session.user.id });
  return c.json(result, result.ok ? 200 : 400);
});

// Undo award
appRouter.post("/leagues/:leagueId/auction/undo-award", async (c) => {
  const session = getRequiredSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const { leagueId } = c.req.param();
  const access = await getLeagueAccess(session.user.id, leagueId);
  if (!access) return c.json({ error: "Not found" }, 404);
  if (!access.isCommissioner) return c.json({ error: "Commissioner only" }, 403);

  const engine = getAuction(leagueId);
  if (!engine) return c.json({ error: "No active auction" }, 404);

  const body = undoAwardSchema.parse(await c.req.json());
  const result = await engine.enqueue({
    type: "undo_award",
    actorUserId: session.user.id,
    playerId: body.playerId,
  });

  return c.json(result, result.ok ? 200 : 400);
});

// End auction
appRouter.post("/leagues/:leagueId/auction/end", async (c) => {
  const session = getRequiredSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const { leagueId } = c.req.param();
  const access = await getLeagueAccess(session.user.id, leagueId);
  if (!access) return c.json({ error: "Not found" }, 404);
  if (!access.isCommissioner) return c.json({ error: "Commissioner only" }, 403);

  const engine = getAuction(leagueId);
  if (!engine) return c.json({ error: "No active auction" }, 404);

  const result = await engine.enqueue({ type: "end", actorUserId: session.user.id });
  return c.json(result, result.ok ? 200 : 400);
});

// ============================================================
// SNAKE DRAFT
// ============================================================

const startSnakeSchema = z.object({
  timed: z.boolean().default(true),
  pickTimerSeconds: z.number().int().min(10).max(120).default(30),
  orderMode: z.enum(["draft_priority", "random"]).default("draft_priority"),
});

const snakePickSchema = z.object({
  playerId: z.string(),
  playerName: z.string(),
  playerTeam: z.string(),
});

const snakeUndoPickSchema = z.object({
  playerId: z.string().optional(),
});

// Start snake draft
appRouter.post("/leagues/:leagueId/snake/start", async (c) => {
  const session = getRequiredSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const { leagueId } = c.req.param();
  const access = await getLeagueAccess(session.user.id, leagueId);
  if (!access) return c.json({ error: "Not found" }, 404);
  if (!access.isCommissioner) return c.json({ error: "Commissioner only" }, 403);

  if (access.league.phase === "scoring") {
    return c.json({ error: "League is already in scoring phase" }, 400);
  }

  // Check no active auction
  const existingAuction = await db
    .select({ id: auctionState.id })
    .from(auctionState)
    .where(
      and(
        eq(auctionState.leagueId, leagueId),
        inArray(auctionState.status, ["nominating", "bidding", "paused"]),
      ),
    )
    .limit(1);
  if (existingAuction.length > 0) {
    return c.json({ error: "An auction is already active" }, 400);
  }

  // Check no active snake draft
  const existingSnake = await db
    .select({ id: snakeState.id })
    .from(snakeState)
    .where(
      and(
        eq(snakeState.leagueId, leagueId),
        inArray(snakeState.status, ["picking", "paused"]),
      ),
    )
    .limit(1);
  if (existingSnake.length > 0) {
    return c.json({ error: "A snake draft is already active" }, 400);
  }

  const body = startSnakeSchema.parse(await c.req.json());
  const members = await getLeagueMembers(leagueId);

  if (members.length < 2) {
    return c.json({ error: "Need at least 2 members" }, 400);
  }

  const now = new Date();
  let orderedUserIds: string[];

  if (body.orderMode === "random") {
    orderedUserIds = shuffle(members.map((m) => m.userId));
  } else {
    const sorted = await db.transaction(async (tx) => {
      return ensureDraftPriorityOrder(tx, leagueId, members, now);
    });
    orderedUserIds = sorted.map((m) => m.userId);
  }

  const totalRounds = access.league.rosterSize;
  const pickOrder = generateSnakeOrder(orderedUserIds, totalRounds);
  const firstPicker = pickOrder[0];

  const snakeId = randomUUID();
  let expiresAt: Date | null = null;
  if (body.timed) {
    expiresAt = new Date(now.getTime() + body.pickTimerSeconds * 1000);
  }

  await db.transaction(async (tx) => {
    await tx.insert(snakeState).values({
      id: snakeId,
      leagueId,
      status: "picking",
      timed: body.timed,
      pickTimerSeconds: body.pickTimerSeconds,
      pickOrder,
      currentPickIndex: 0,
      currentPickerUserId: firstPicker,
      totalPicks: 0,
      currentRound: 1,
      totalRounds,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });

    const seq = await nextSequenceNumber(tx, leagueId);
    await tx.insert(leagueAction).values({
      id: randomUUID(),
      leagueId,
      type: "snake_start",
      actorUserId: session.user.id,
      sequenceNumber: seq,
      metadata: {
        timed: body.timed,
        pickTimerSeconds: body.pickTimerSeconds,
        pickOrder,
        totalRounds,
      },
      createdAt: now,
    });

    await tx
      .update(league)
      .set({ phase: "draft", updatedAt: now })
      .where(eq(league.id, leagueId));
  });

  // Fetch the inserted row and start the engine
  const [stateRow] = await db.select().from(snakeState).where(eq(snakeState.id, snakeId));
  const engine = startSnakeDraft(leagueId, stateRow);
  if (body.timed && expiresAt) {
    engine.restartPickTimer(body.pickTimerSeconds * 1000, expiresAt);
  }

  return c.json({ ok: true, snakeId });
});

// SSE stream
appRouter.get("/leagues/:leagueId/snake/stream", async (c) => {
  const session = getRequiredSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const { leagueId } = c.req.param();
  const access = await getLeagueAccess(session.user.id, leagueId);
  if (!access) return c.json({ error: "Not found" }, 404);

  const engine = getSnakeDraft(leagueId);
  if (!engine) return c.json({ error: "No active snake draft" }, 404);

  return streamSSE(c, async (stream) => {
    engine.addClient(stream);

    await stream.writeSSE({
      event: "state",
      data: JSON.stringify(engine.getStateSnapshot()),
    });

    stream.onAbort(() => {
      engine.removeClient(stream);
    });

    while (true) {
      await stream.sleep(30_000);
      await stream.writeSSE({ event: "ping", data: "" });
    }
  });
});

// Current state (non-SSE fallback)
appRouter.get("/leagues/:leagueId/snake/state", async (c) => {
  const session = getRequiredSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const { leagueId } = c.req.param();
  const access = await getLeagueAccess(session.user.id, leagueId);
  if (!access) return c.json({ error: "Not found" }, 404);

  const engine = getSnakeDraft(leagueId);
  if (!engine) return c.json({ error: "No active snake draft" }, 404);

  return c.json(engine.getStateSnapshot());
});

// Pick
appRouter.post("/leagues/:leagueId/snake/pick", async (c) => {
  const session = getRequiredSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const { leagueId } = c.req.param();
  const access = await getLeagueAccess(session.user.id, leagueId);
  if (!access) return c.json({ error: "Not found" }, 404);

  const engine = getSnakeDraft(leagueId);
  if (!engine) return c.json({ error: "No active snake draft" }, 404);

  const body = snakePickSchema.parse(await c.req.json());
  const result = await engine.enqueue({
    type: "pick",
    userId: session.user.id,
    playerId: body.playerId,
    playerName: body.playerName,
    playerTeam: body.playerTeam,
  });

  return c.json(result, result.ok ? 200 : 400);
});

// Pause
appRouter.post("/leagues/:leagueId/snake/pause", async (c) => {
  const session = getRequiredSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const { leagueId } = c.req.param();
  const access = await getLeagueAccess(session.user.id, leagueId);
  if (!access) return c.json({ error: "Not found" }, 404);
  if (!access.isCommissioner) return c.json({ error: "Commissioner only" }, 403);

  const engine = getSnakeDraft(leagueId);
  if (!engine) return c.json({ error: "No active snake draft" }, 404);

  const result = await engine.enqueue({ type: "pause", actorUserId: session.user.id });
  return c.json(result, result.ok ? 200 : 400);
});

// Resume
appRouter.post("/leagues/:leagueId/snake/resume", async (c) => {
  const session = getRequiredSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const { leagueId } = c.req.param();
  const access = await getLeagueAccess(session.user.id, leagueId);
  if (!access) return c.json({ error: "Not found" }, 404);
  if (!access.isCommissioner) return c.json({ error: "Commissioner only" }, 403);

  const engine = getSnakeDraft(leagueId);
  if (!engine) return c.json({ error: "No active snake draft" }, 404);

  const result = await engine.enqueue({ type: "resume", actorUserId: session.user.id });
  return c.json(result, result.ok ? 200 : 400);
});

// Undo pick
appRouter.post("/leagues/:leagueId/snake/undo-pick", async (c) => {
  const session = getRequiredSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const { leagueId } = c.req.param();
  const access = await getLeagueAccess(session.user.id, leagueId);
  if (!access) return c.json({ error: "Not found" }, 404);
  if (!access.isCommissioner) return c.json({ error: "Commissioner only" }, 403);

  const engine = getSnakeDraft(leagueId);
  if (!engine) return c.json({ error: "No active snake draft" }, 404);

  const body = snakeUndoPickSchema.parse(await c.req.json());
  const result = await engine.enqueue({
    type: "undo_pick",
    actorUserId: session.user.id,
    playerId: body.playerId,
  });

  return c.json(result, result.ok ? 200 : 400);
});

// End snake draft
appRouter.post("/leagues/:leagueId/snake/end", async (c) => {
  const session = getRequiredSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const { leagueId } = c.req.param();
  const access = await getLeagueAccess(session.user.id, leagueId);
  if (!access) return c.json({ error: "Not found" }, 404);
  if (!access.isCommissioner) return c.json({ error: "Commissioner only" }, 403);

  const engine = getSnakeDraft(leagueId);
  if (!engine) return c.json({ error: "No active snake draft" }, 404);

  const result = await engine.enqueue({ type: "end", actorUserId: session.user.id });
  return c.json(result, result.ok ? 200 : 400);
});

// ─── Event-level projections (per-event sim cache) ────────────────

appRouter.get("/leagues/:leagueId/projections-timeline", async (c) => {
  const session = getRequiredSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  const access = await getLeagueAccess(session.user.id, c.req.param("leagueId"));
  if (!access) return c.json({ error: "League not found" }, 404);

  const rows = await db
    .select()
    .from(nbaEventProjection)
    .where(eq(nbaEventProjection.leagueId, access.league.id))
    .orderBy(
      asc(nbaEventProjection.updatedAtEvent),
      asc(nbaEventProjection.gameId),
      asc(nbaEventProjection.sequence),
    );

  const members = await getLeagueMembers(access.league.id);
  const managers = members
    .filter((m) => m.userId)
    .map((m) => ({ userId: m.userId, name: m.name }));

  const latestJobRows = await db
    .select()
    .from(nbaProjectionJob)
    .where(eq(nbaProjectionJob.leagueId, access.league.id))
    .orderBy(desc(nbaProjectionJob.createdAt))
    .limit(1);
  const latestJob = latestJobRows[0] ?? null;

  return c.json({
    managers,
    events: rows.map((r) => ({
      gameId: r.gameId,
      sequence: r.sequence,
      updatedAtEvent: r.updatedAtEvent.toISOString(),
      kind: r.kind,
      actualPoints: r.actualPoints,
      projectedPoints: r.projectedPoints,
      eventMeta: r.eventMeta,
      gamesSnapshot: r.gamesSnapshot,
      simCount: r.simCount,
      computedAt: r.computedAt.toISOString(),
    })),
    latestJob: latestJob
      ? {
          id: latestJob.id,
          status: latestJob.status,
          totalEvents: latestJob.totalEvents,
          processedEvents: latestJob.processedEvents,
          startedAt: latestJob.startedAt?.toISOString() ?? null,
          finishedAt: latestJob.finishedAt?.toISOString() ?? null,
          lastError: latestJob.lastError,
          createdAt: latestJob.createdAt.toISOString(),
        }
      : null,
  });
});

appRouter.post("/leagues/:leagueId/rebuild-projections", async (c) => {
  const session = getRequiredSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  if (normalizeEmail(session.user.email) !== LEAGUE_CREATOR_EMAIL) {
    return c.json({ error: "Restricted to the commissioner account" }, 403);
  }
  const access = await getLeagueAccess(session.user.id, c.req.param("leagueId"));
  if (!access) return c.json({ error: "League not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as {
    mode?: "full" | "incremental" | "actuals-only";
  };
  const mode =
    body.mode === "full"
      ? "full"
      : body.mode === "actuals-only"
        ? "actuals-only"
        : "incremental";

  const jobId = await enqueueProjectionRebuild({
    leagueId: access.league.id,
    requestedByUserId: session.user.id,
    mode,
  });

  return c.json({ jobId, mode });
});

appRouter.get("/leagues/:leagueId/projection-job/:jobId", async (c) => {
  const session = getRequiredSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  const access = await getLeagueAccess(session.user.id, c.req.param("leagueId"));
  if (!access) return c.json({ error: "League not found" }, 404);

  const rows = await db
    .select()
    .from(nbaProjectionJob)
    .where(
      and(
        eq(nbaProjectionJob.id, c.req.param("jobId")),
        eq(nbaProjectionJob.leagueId, access.league.id),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return c.json({ error: "Job not found" }, 404);
  return c.json({
    id: row.id,
    status: row.status,
    totalEvents: row.totalEvents,
    processedEvents: row.processedEvents,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  });
});
