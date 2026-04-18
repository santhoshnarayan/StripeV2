import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  nbaAthlete,
  nbaGame,
  nbaPlay,
  nbaPlayerGameStats,
  nbaSyncState,
  nbaTeamGameStats,
  nbaWinProb,
} from "@repo/db";
import {
  getAllAthletes,
  getAthleteByRef,
  getGamePlayByPlay,
  getGameSummary,
  getScoreboard,
  getWinProbability,
  type BoxscorePlayer,
  type ScoreboardEvent,
} from "./client.js";
import {
  loadBracket,
  matchSeriesForTeams,
} from "./match.js";

function toYyyyMmDd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function safeDate(iso: string | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function parseIntOr(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

async function upsertSyncState(patch: Partial<typeof nbaSyncState.$inferInsert>) {
  await db
    .insert(nbaSyncState)
    .values({ id: "global", ...patch, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: nbaSyncState.id,
      set: { ...patch, updatedAt: new Date() },
    });
}

/** Sync the day's scoreboard into nba_game, setting seriesKey via bracket matcher. */
export async function syncScoreboard(date: Date): Promise<ScoreboardEvent[]> {
  const dateStr = toYyyyMmDd(date);
  const sb = await getScoreboard(dateStr);
  const bracket = loadBracket();

  // Pull existing series→gameNum counts to assign a gameNum for newly matched series.
  const seriesCounts = new Map<string, number>();
  const existingGames = await db
    .select({ id: nbaGame.id, seriesKey: nbaGame.seriesKey, gameNum: nbaGame.gameNum })
    .from(nbaGame);
  for (const g of existingGames) {
    if (g.seriesKey && g.gameNum) {
      seriesCounts.set(g.seriesKey, Math.max(seriesCounts.get(g.seriesKey) ?? 0, g.gameNum));
    }
  }
  const existingIds = new Set(existingGames.map((g) => g.id));

  for (const ev of sb.events ?? []) {
    const comp = ev.competitions?.[0];
    if (!comp) continue;
    const home = comp.competitors.find((c) => c.homeAway === "home");
    const away = comp.competitors.find((c) => c.homeAway === "away");
    if (!home || !away) continue;

    const homeAb = home.team.abbreviation;
    const awayAb = away.team.abbreviation;
    const series = matchSeriesForTeams(homeAb, awayAb, bracket);
    let seriesKey: string | null = null;
    let gameNum: number | null = null;
    if (series) {
      seriesKey = series.key;
      // Assign game number only for new games (not already stored).
      if (!existingIds.has(ev.id)) {
        const next = (seriesCounts.get(series.key) ?? 0) + 1;
        seriesCounts.set(series.key, next);
        gameNum = next;
      }
    }

    const status = comp.status?.type?.state ?? ev.status?.type?.state ?? "pre";
    const broadcast = comp.broadcasts
      ?.map((b) => b.names?.join(", "))
      .filter(Boolean)
      .join(" / ");

    const values = {
      id: ev.id,
      date: safeDate(ev.date ?? comp.date),
      homeTeamAbbrev: homeAb,
      awayTeamAbbrev: awayAb,
      homeScore: home.score ? parseIntOr(home.score) : null,
      awayScore: away.score ? parseIntOr(away.score) : null,
      status,
      period: comp.status?.period ?? null,
      displayClock: comp.status?.displayClock ?? null,
      startTime: safeDate(ev.date ?? comp.date),
      venue: comp.venue?.fullName ?? null,
      broadcast: broadcast || null,
      seriesKey,
      gameNum,
      updatedAt: new Date(),
    };

    await db
      .insert(nbaGame)
      .values(values)
      .onConflictDoUpdate({
        target: nbaGame.id,
        set: {
          date: values.date,
          homeTeamAbbrev: values.homeTeamAbbrev,
          awayTeamAbbrev: values.awayTeamAbbrev,
          homeScore: values.homeScore,
          awayScore: values.awayScore,
          status: values.status,
          period: values.period,
          displayClock: values.displayClock,
          venue: values.venue,
          broadcast: values.broadcast,
          // Only set seriesKey/gameNum if not already set (avoid clobbering).
          seriesKey: sql`COALESCE(${nbaGame.seriesKey}, ${values.seriesKey})`,
          gameNum: sql`COALESCE(${nbaGame.gameNum}, ${values.gameNum})`,
          updatedAt: values.updatedAt,
        },
      });
  }

  await upsertSyncState({ lastScoreboardAt: new Date() });
  return sb.events ?? [];
}

const STAT_KEYS = [
  "minutes", // MIN
  "fg", // "FG" (e.g. "10-20")
  "fg3", // 3PT "4-8"
  "ft", // "2-2"
  "oreb",
  "dreb",
  "reb",
  "ast",
  "stl",
  "blk",
  "to",
  "pf",
  "plusMinus",
  "pts",
] as const;

function parseMade(v: string | undefined): { made: number; att: number } {
  if (!v || typeof v !== "string") return { made: 0, att: 0 };
  const parts = v.split("-");
  if (parts.length !== 2) return { made: 0, att: 0 };
  return { made: parseIntOr(parts[0]), att: parseIntOr(parts[1]) };
}

function parseMinutes(v: string | undefined): number {
  if (!v) return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function parsePlusMinus(v: string | undefined): number | null {
  if (!v) return null;
  const stripped = v.replace("+", "");
  const n = parseInt(stripped, 10);
  return Number.isFinite(n) ? n : null;
}

interface ParsedPlayerStats {
  playerId: string;
  playerName: string;
  teamAbbrev: string;
  minutes: number;
  fgm: number;
  fga: number;
  fg3m: number;
  fg3a: number;
  ftm: number;
  fta: number;
  oreb: number;
  dreb: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  to: number;
  pf: number;
  plusMinus: number | null;
  pts: number;
  starter: boolean;
  dnp: boolean;
}

function parseBoxscorePlayers(
  teamAbbrev: string,
  players: BoxscorePlayer[],
): ParsedPlayerStats[] {
  const out: ParsedPlayerStats[] = [];
  for (const p of players ?? []) {
    const stats = p.stats ?? [];
    // ESPN order: MIN, FG, 3PT, FT, OREB, DREB, REB, AST, STL, BLK, TO, PF, +/-, PTS
    const fg = parseMade(stats[1]);
    const fg3 = parseMade(stats[2]);
    const ft = parseMade(stats[3]);
    out.push({
      playerId: p.athlete?.id ?? "",
      playerName: p.athlete?.displayName ?? "",
      teamAbbrev,
      minutes: parseMinutes(stats[0]),
      fgm: fg.made,
      fga: fg.att,
      fg3m: fg3.made,
      fg3a: fg3.att,
      ftm: ft.made,
      fta: ft.att,
      oreb: parseIntOr(stats[4]),
      dreb: parseIntOr(stats[5]),
      reb: parseIntOr(stats[6]),
      ast: parseIntOr(stats[7]),
      stl: parseIntOr(stats[8]),
      blk: parseIntOr(stats[9]),
      to: parseIntOr(stats[10]),
      pf: parseIntOr(stats[11]),
      plusMinus: parsePlusMinus(stats[12]),
      pts: parseIntOr(stats[13]),
      starter: p.starter === true,
      dnp: p.didNotPlay === true || !stats.length,
    });
  }
  return out.filter((p) => p.playerId);
}

/** Fetch full game detail and upsert stats, plays, win probability. */
export async function syncGameDetail(eventId: string): Promise<void> {
  const summary = await getGameSummary(eventId);

  // Update header scores/status if changed since last scoreboard pull.
  const comp = summary.header?.competitions?.[0];
  if (comp) {
    const home = comp.competitors.find((c) => c.homeAway === "home");
    const away = comp.competitors.find((c) => c.homeAway === "away");
    const state = comp.status?.type?.state ?? "pre";
    await db
      .update(nbaGame)
      .set({
        homeScore: home?.score ? parseIntOr(home.score) : null,
        awayScore: away?.score ? parseIntOr(away.score) : null,
        status: state,
        period: comp.status?.period ?? null,
        displayClock: comp.status?.displayClock ?? null,
        updatedAt: new Date(),
      })
      .where(eq(nbaGame.id, eventId));
  }

  // Team stats + quarter-by-quarter linescores.
  const teams = summary.boxscore?.teams ?? [];
  for (const t of teams) {
    const abbrev = t.team.abbreviation;
    const comp2 = summary.header?.competitions?.[0];
    const competitor = comp2?.competitors.find(
      (c) => c.team.abbreviation === abbrev,
    );
    const quarterScores = competitor?.linescores?.map((l) => l.value ?? 0) ?? null;
    const statsByName: Record<string, { displayValue?: string; value?: number }> = {};
    for (const s of t.statistics ?? []) statsByName[s.name] = s;
    const pct = (key: string): number | null => {
      const raw = statsByName[key]?.displayValue;
      if (!raw) return null;
      const n = parseFloat(raw.replace("%", ""));
      return Number.isFinite(n) ? n : null;
    };
    const num = (key: string): number | null => {
      const raw = statsByName[key]?.displayValue ?? statsByName[key]?.value;
      if (raw === undefined) return null;
      const n = typeof raw === "number" ? raw : parseFloat(String(raw));
      return Number.isFinite(n) ? Math.round(n) : null;
    };
    await db
      .insert(nbaTeamGameStats)
      .values({
        gameId: eventId,
        teamAbbrev: abbrev,
        quarterScores,
        fgPct: pct("fieldGoalPct"),
        fg3Pct: pct("threePointFieldGoalPct"),
        ftPct: pct("freeThrowPct"),
        reboundsTotal: num("rebounds"),
        assistsTotal: num("assists"),
        turnoversTotal: num("turnovers"),
        largestLead: num("largestLead"),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [nbaTeamGameStats.gameId, nbaTeamGameStats.teamAbbrev],
        set: {
          quarterScores,
          fgPct: pct("fieldGoalPct"),
          fg3Pct: pct("threePointFieldGoalPct"),
          ftPct: pct("freeThrowPct"),
          reboundsTotal: num("rebounds"),
          assistsTotal: num("assists"),
          turnoversTotal: num("turnovers"),
          largestLead: num("largestLead"),
          updatedAt: new Date(),
        },
      });
  }

  // Player stats.
  const sections = summary.boxscore?.players ?? [];
  const allPlayerStats: ParsedPlayerStats[] = [];
  for (const sec of sections) {
    const abbrev = sec.team.abbreviation;
    const athletesList = sec.statistics?.[0]?.athletes ?? [];
    allPlayerStats.push(...parseBoxscorePlayers(abbrev, athletesList));
  }
  for (const p of allPlayerStats) {
    await db
      .insert(nbaPlayerGameStats)
      .values({
        gameId: eventId,
        playerId: p.playerId,
        teamAbbrev: p.teamAbbrev,
        playerName: p.playerName,
        minutes: p.minutes,
        points: p.pts,
        rebounds: p.reb,
        assists: p.ast,
        steals: p.stl,
        blocks: p.blk,
        turnovers: p.to,
        fgm: p.fgm,
        fga: p.fga,
        fg3m: p.fg3m,
        fg3a: p.fg3a,
        ftm: p.ftm,
        fta: p.fta,
        plusMinus: p.plusMinus,
        starter: p.starter,
        dnp: p.dnp,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [nbaPlayerGameStats.gameId, nbaPlayerGameStats.playerId],
        set: {
          teamAbbrev: p.teamAbbrev,
          playerName: p.playerName,
          minutes: p.minutes,
          points: p.pts,
          rebounds: p.reb,
          assists: p.ast,
          steals: p.stl,
          blocks: p.blk,
          turnovers: p.to,
          fgm: p.fgm,
          fga: p.fga,
          fg3m: p.fg3m,
          fg3a: p.fg3a,
          ftm: p.ftm,
          fta: p.fta,
          plusMinus: p.plusMinus,
          starter: p.starter,
          dnp: p.dnp,
          updatedAt: new Date(),
        },
      });
  }

  // Play-by-play (tolerate failures; separate endpoint).
  try {
    const pbp = await getGamePlayByPlay(eventId);
    for (const item of pbp.items ?? []) {
      const seq = parseIntOr(item.sequenceNumber);
      if (!seq) continue;
      const teamAbbrev = item.team?.$ref?.match(/teams\/(\w+)/)?.[1] ?? null;
      const playerIds: string[] = [];
      for (const p of item.participants ?? []) {
        const m = p.athlete?.$ref?.match(/athletes\/(\d+)/);
        if (m) playerIds.push(m[1]);
      }
      await db
        .insert(nbaPlay)
        .values({
          gameId: eventId,
          sequence: seq,
          period: item.period?.number ?? null,
          clock: item.clock?.displayValue ?? null,
          scoringPlay: item.scoringPlay === true,
          scoreValue: item.scoreValue ?? null,
          text: item.text ?? item.shortText ?? null,
          homeScore: item.homeScore ?? null,
          awayScore: item.awayScore ?? null,
          teamAbbrev,
          playerIds,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [nbaPlay.gameId, nbaPlay.sequence],
          set: {
            period: item.period?.number ?? null,
            clock: item.clock?.displayValue ?? null,
            scoringPlay: item.scoringPlay === true,
            scoreValue: item.scoreValue ?? null,
            text: item.text ?? item.shortText ?? null,
            homeScore: item.homeScore ?? null,
            awayScore: item.awayScore ?? null,
            teamAbbrev,
            playerIds,
            updatedAt: new Date(),
          },
        });
    }
  } catch (err) {
    console.warn("[espn-nba] PBP fetch failed for", eventId, (err as Error).message);
  }

  // Win probability (tolerate failures).
  try {
    const wp = await getWinProbability(eventId);
    for (const item of wp.items ?? []) {
      const seq = parseIntOr(item.sequenceNumber);
      if (!seq) continue;
      await db
        .insert(nbaWinProb)
        .values({
          gameId: eventId,
          sequence: seq,
          period: item.period?.number ?? null,
          homeWinPct: item.homeWinPercentage ?? null,
          tiePct: item.tiePercentage ?? null,
        })
        .onConflictDoUpdate({
          target: [nbaWinProb.gameId, nbaWinProb.sequence],
          set: {
            period: item.period?.number ?? null,
            homeWinPct: item.homeWinPercentage ?? null,
            tiePct: item.tiePercentage ?? null,
          },
        });
    }
  } catch (err) {
    console.warn("[espn-nba] WinProb fetch failed for", eventId, (err as Error).message);
  }
}

/** In-memory gate: timestamp until which the 1-min cron may skip entirely.
 *  Cleared on scoreboard sync so a new day's games register immediately. */
let liveWindowSkipUntil = 0;

export function clearLiveWindowGate(): void {
  liveWindowSkipUntil = 0;
}

/** Sync any games that are live or about to start or recently ended.
 *  Returns -1 when the call was skipped by the in-memory gate (no compute spent). */
export async function syncLiveGames(): Promise<number> {
  const nowMs = Date.now();
  if (liveWindowSkipUntil > nowMs) return -1;

  const now = new Date(nowMs);
  const fifteenMinFuture = new Date(nowMs + 15 * 60 * 1000);
  const thirtyMinAgo = new Date(nowMs - 30 * 60 * 1000);

  const rows = await db
    .select({ id: nbaGame.id, status: nbaGame.status, startTime: nbaGame.startTime, updatedAt: nbaGame.updatedAt })
    .from(nbaGame);

  const targets: string[] = [];
  let nextPreStart: number | null = null;
  for (const g of rows) {
    if (g.status === "in") targets.push(g.id);
    else if (g.status === "pre" && g.startTime && g.startTime <= fifteenMinFuture && g.startTime >= thirtyMinAgo) {
      targets.push(g.id);
    } else if (g.status === "post" && g.updatedAt && g.updatedAt >= thirtyMinAgo) {
      targets.push(g.id);
    } else if (g.status === "pre" && g.startTime && g.startTime.getTime() > fifteenMinFuture.getTime()) {
      const t = g.startTime.getTime();
      if (nextPreStart === null || t < nextPreStart) nextPreStart = t;
    }
  }

  for (const id of targets) {
    try {
      await syncGameDetail(id);
    } catch (err) {
      console.warn("[espn-nba] syncGameDetail failed", id, (err as Error).message);
    }
  }

  // Skip-gate: if nothing to do, resume polling 15 min before the next scheduled tip
  // (or in 15 min if no upcoming games). Scoreboard sync clears the gate every 15 min anyway.
  if (targets.length === 0) {
    const resumeAt = nextPreStart !== null ? nextPreStart - 15 * 60 * 1000 : nowMs + 15 * 60 * 1000;
    liveWindowSkipUntil = Math.max(resumeAt, nowMs + 60 * 1000);
  } else {
    liveWindowSkipUntil = 0;
  }

  await upsertSyncState({ lastLiveCheckAt: now });
  return targets.length;
}

/** Compute live points per player — used to hydrate league standings.
 *  Only counts playoff series (R1/R2/CF/Finals). Play-in games have
 *  seriesKey=null (matchSeriesForTeams only matches playoff series) and
 *  are intentionally excluded so they show in the ticker but not standings. */
export async function computeLivePointsByPlayer(): Promise<Map<string, number>> {
  const rows = await db
    .select({ playerId: nbaPlayerGameStats.playerId, pts: sql<number>`sum(${nbaPlayerGameStats.points})` })
    .from(nbaPlayerGameStats)
    .innerJoin(nbaGame, eq(nbaPlayerGameStats.gameId, nbaGame.id))
    .where(sql`${nbaGame.seriesKey} IS NOT NULL`)
    .groupBy(nbaPlayerGameStats.playerId);
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.playerId, Number(r.pts) || 0);
  return out;
}

/** One-off seed of active NBA athletes. */
export async function seedAthletes(): Promise<number> {
  const page1 = await getAllAthletes(1000);
  const refs = page1.items ?? [];
  let count = 0;
  for (const ref of refs) {
    try {
      const a = await getAthleteByRef<{
        id: string;
        firstName?: string;
        lastName?: string;
        fullName?: string;
        displayName?: string;
        jersey?: string;
        active?: boolean;
        position?: { abbreviation?: string };
        team?: { $ref?: string };
      }>(ref.$ref);
      await db
        .insert(nbaAthlete)
        .values({
          id: a.id,
          fullName: a.fullName ?? a.displayName ?? "",
          firstName: a.firstName ?? null,
          lastName: a.lastName ?? null,
          position: a.position?.abbreviation ?? null,
          jersey: a.jersey ?? null,
          isActive: a.active !== false,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: nbaAthlete.id,
          set: {
            fullName: a.fullName ?? a.displayName ?? "",
            firstName: a.firstName ?? null,
            lastName: a.lastName ?? null,
            position: a.position?.abbreviation ?? null,
            jersey: a.jersey ?? null,
            isActive: a.active !== false,
            updatedAt: new Date(),
          },
        });
      count++;
    } catch (err) {
      console.warn("[espn-nba] athlete fetch failed", ref.$ref, (err as Error).message);
    }
  }
  return count;
}
