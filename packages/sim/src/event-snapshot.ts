import type { LiveGameState } from "./types";
import { computeRemainingFraction } from "./live-game-utils";

// ─── Inputs ────────────────────────────────────────────────────────

export interface PlayEvent {
  gameId: string;
  sequence: number;
  period: number | null;
  clock: string | null;
  updatedAt: Date;
  /** ESPN-provided wall-clock time of the play. null for older rows
   *  ingested before the wallclock column existed. */
  wallclock: Date | null;
  scoringPlay: boolean;
  scoreValue: number | null;
  homeScore: number | null;
  awayScore: number | null;
  teamAbbrev: string | null;
  playerIds: string[];
  text: string | null;
}

export interface GameMeta {
  id: string;
  seriesKey: string | null;
  gameNum: number | null;
  homeTeamAbbrev: string;
  awayTeamAbbrev: string;
  status: "pre" | "in" | "post";
  /** Sequence of the last-ingested play. When a game's status is "post" and
   *  the play currently being processed has this sequence, the event is
   *  classified as "end_of_game". */
  lastPlaySequence: number | null;
}

// ─── Outputs ───────────────────────────────────────────────────────

export type EventKind = "scoring" | "end_of_half" | "end_of_game";

export interface EventDescriptor {
  kind: EventKind;
  gameId: string;
  sequence: number;
  /** DB ingest/write time (cron batch). Kept for backfill/debug. */
  updatedAt: Date;
  /** True play time from ESPN. Prefer this for chart x-axis. */
  wallclock: Date | null;
  text: string | null;
  teamAbbrev: string | null;
  playerIds: string[];
  scoreValue: number | null;
  period: number | null;
  clock: string | null;
  homeScore: number | null;
  awayScore: number | null;
}

export interface EventSnapshot {
  event: EventDescriptor;
  /** Games that have started by this point (≥1 play seen) OR are already final.
   *  Pre-games not in this list — the sim still simulates them as fresh games. */
  liveGames: LiveGameState[];
  /** espnPlayerId → cumulative points across all games so far.
   *  Fantasy scoring is points-only, so this is also the fantasy total. */
  cumulativePointsByPlayer: Record<string, number>;
}

// ─── Builder ───────────────────────────────────────────────────────

interface RunningGameState {
  homeScore: number;
  awayScore: number;
  period: number | null;
  clock: string | null;
  status: "pre" | "in" | "post";
  playerPoints: Record<string, number>;
  playCount: number;
}

/** Walks plays in chronological order and emits a snapshot at each
 *  chart-worthy event (scoring play, end of half, end of game). */
export function buildEventSnapshots(params: {
  games: GameMeta[];
  plays: PlayEvent[];
}): EventSnapshot[] {
  const { games, plays } = params;
  const gameById = new Map(games.map((g) => [g.id, g]));

  // Sort by wallclock (true play time) when available so the cumulative
  // counter advances in the same order the chart renders. Using updatedAt
  // (ingest batch time) caused old rows synced later to flip wallclock order,
  // which made on-chart cumulative values appear to drop mid-timeline.
  const sorted = [...plays].sort((a, b) => {
    const ta = (a.wallclock ?? a.updatedAt).getTime();
    const tb = (b.wallclock ?? b.updatedAt).getTime();
    if (ta !== tb) return ta - tb;
    if (a.gameId !== b.gameId) return a.gameId < b.gameId ? -1 : 1;
    return a.sequence - b.sequence;
  });

  const gameState = new Map<string, RunningGameState>();
  for (const g of games) {
    gameState.set(g.id, {
      homeScore: 0,
      awayScore: 0,
      period: null,
      clock: null,
      status: "pre",
      playerPoints: {},
      playCount: 0,
    });
  }

  const cumulativePoints: Record<string, number> = {};
  const snapshots: EventSnapshot[] = [];

  for (const play of sorted) {
    const meta = gameById.get(play.gameId);
    if (!meta) continue;
    const gs = gameState.get(play.gameId);
    if (!gs) continue;

    if (play.homeScore != null) gs.homeScore = play.homeScore;
    if (play.awayScore != null) gs.awayScore = play.awayScore;
    if (play.period != null) gs.period = play.period;
    gs.clock = play.clock;
    gs.playCount += 1;
    if (gs.status === "pre") gs.status = "in";

    if (play.scoringPlay && play.scoreValue != null && play.playerIds.length > 0) {
      const scorer = String(play.playerIds[0]);
      gs.playerPoints[scorer] = (gs.playerPoints[scorer] ?? 0) + play.scoreValue;
      cumulativePoints[scorer] = (cumulativePoints[scorer] ?? 0) + play.scoreValue;
    }

    const isTerminal =
      meta.status === "post" &&
      meta.lastPlaySequence != null &&
      play.sequence === meta.lastPlaySequence;
    if (isTerminal) gs.status = "post";

    let kind: EventKind | null = null;
    if (isTerminal) {
      kind = "end_of_game";
    } else if (play.scoringPlay) {
      kind = "scoring";
    } else if (
      play.clock === "0:00" &&
      play.period != null &&
      (play.period === 2 || play.period === 4)
    ) {
      kind = "end_of_half";
    }
    if (kind == null) continue;

    const liveGames: LiveGameState[] = [];
    for (const [gid, state] of gameState.entries()) {
      if (state.playCount === 0) continue;
      const gMeta = gameById.get(gid);
      if (!gMeta || !gMeta.seriesKey || gMeta.gameNum == null) continue;

      const remaining =
        state.status === "post"
          ? 0
          : computeRemainingFraction("in", state.period, state.clock);

      liveGames.push({
        seriesKey: gMeta.seriesKey,
        gameNum: gMeta.gameNum,
        status: state.status,
        homeTeam: gMeta.homeTeamAbbrev,
        awayTeam: gMeta.awayTeamAbbrev,
        homeScore: state.homeScore,
        awayScore: state.awayScore,
        remainingFraction: remaining,
        playerPoints: { ...state.playerPoints },
      });
    }

    snapshots.push({
      event: {
        kind,
        gameId: play.gameId,
        sequence: play.sequence,
        updatedAt: play.updatedAt,
        wallclock: play.wallclock,
        text: play.text,
        teamAbbrev: play.teamAbbrev,
        playerIds: play.playerIds,
        scoreValue: play.scoreValue,
        period: play.period,
        clock: play.clock,
        homeScore: play.homeScore,
        awayScore: play.awayScore,
      },
      liveGames,
      cumulativePointsByPlayer: { ...cumulativePoints },
    });
  }

  return snapshots;
}
