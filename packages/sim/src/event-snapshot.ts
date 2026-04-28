import type { InjuryEntry, LiveGameState } from "./types";
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

/** External event that mutates the injury-probability vector for one or more
 *  players. May fire mid-game: stats accrued before `wallclock` stay locked
 *  (they're already folded into the cumulative state), but the simulator uses
 *  the new availability vectors when projecting the remainder of that game and
 *  every subsequent game.
 *
 *  The update map's keys are player names (matching `InjuryEntry`'s own keying
 *  in `SimData.injuries`). A name → `null` entry clears any prior injury for
 *  that player (player goes back to default 1.0 availability across all 30
 *  slots). */
export interface InjuryUpdate {
  /** Stable identifier — used as the snapshot's `sequence` so the projection
   *  cache can key (gameId, sequence) deduplication consistently across
   *  rebuilds. Must be unique across all injury updates in a single rebuild. */
  id: string;
  /** When the update takes effect. Required — sets the snapshot's chart-axis
   *  position and chronological merge order. */
  wallclock: Date;
  /** Optional game the update lands in. When non-null and that game is `in`,
   *  the snapshot represents a mid-game injury revision (already-completed
   *  stats count, remaining minutes use the new vector). When null, the
   *  update applies between games. */
  gameId: string | null;
  /** Player name → new injury entry (or null to clear). Replaces any prior
   *  entry for that name. */
  updates: Record<string, InjuryEntry | null>;
  /** Optional human-readable note for the FE event log. */
  note?: string | null;
}

// ─── Outputs ───────────────────────────────────────────────────────

/** "injury_update" is a non-play event: included in the event stream sent to
 *  the FE but excluded from chart point rendering (it's not a scoring event
 *  or a halftime event). */
export type EventKind =
  | "scoring"
  | "end_of_period"
  | "end_of_game"
  | "injury_update";

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
  /** Populated only when `kind === "injury_update"`. Carries the per-player
   *  availability vectors that take effect from this point forward. */
  injuryUpdate?: InjuryUpdate | null;
}

export interface EventSnapshot {
  event: EventDescriptor;
  /** Games that have started by this point (≥1 play seen) OR are already final.
   *  Pre-games not in this list — the sim still simulates them as fresh games. */
  liveGames: LiveGameState[];
  /** espnPlayerId → cumulative points across all games so far.
   *  Fantasy scoring is points-only, so this is also the fantasy total. */
  cumulativePointsByPlayer: Record<string, number>;
  /** Running FNV-1a hash of every valid play seen so far in chronological
   *  order (including this snapshot's triggering play). Used by
   *  findFirstDivergence as the identity check: if any upstream play was
   *  inserted/deleted/edited, this hash shifts from that point forward.
   *  Cheap to compute, pure structural — no jsonb, no floats, no object-key
   *  ordering quirks. */
  cumulativeHash: string;
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

/** FNV-1a 32-bit running hash. Pure JS so it works in node + browser.
 *  Collision rate is ~1/2^32 per snapshot — fine for divergence detection
 *  against O(10k) plays. Uses `Math.imul` to stay in 32-bit integer space. */
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
function fnv1aStep(hash: number, s: string): number {
  let h = hash;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

/** Serialize exactly the fields of a play that — if changed by ESPN —
 *  should invalidate cached projections. Score, scorer, clock/period, and
 *  play text are meaningful; `updatedAt` (ingest batch time) is not. */
function playContentKey(p: PlayEvent): string {
  return [
    p.gameId,
    p.sequence,
    p.period ?? "",
    p.clock ?? "",
    p.scoringPlay ? "1" : "0",
    p.scoreValue ?? "",
    p.homeScore ?? "",
    p.awayScore ?? "",
    p.teamAbbrev ?? "",
    p.playerIds.join(","),
    p.wallclock ? p.wallclock.getTime() : "",
    p.text ?? "",
  ].join("\x1f");
}

/** Cumulative-hash key for an injury update. Mirrors `playContentKey`'s role:
 *  if any field of the update changes, the hash diverges from that point
 *  forward and the projection cache rebuilds. */
function injuryUpdateContentKey(u: InjuryUpdate): string {
  const updates = Object.keys(u.updates)
    .sort()
    .map((name) => {
      const e = u.updates[name];
      if (e == null) return `${name}:null`;
      return `${name}:${e.team}|${e.status}|${e.injury}|${e.availability.join(",")}`;
    })
    .join("\x1e");
  return [
    "injury_update",
    u.id,
    u.wallclock.getTime(),
    u.gameId ?? "",
    updates,
    u.note ?? "",
  ].join("\x1f");
}

type TimelineEntry =
  | { type: "play"; t: number; play: PlayEvent }
  | { type: "injury"; t: number; update: InjuryUpdate };

/** Walks plays + injury updates in chronological order and emits a snapshot
 *  at each chart-worthy event (scoring play, end of half, end of game) and
 *  at each injury update. Injury-update snapshots carry the new availability
 *  vectors in `event.injuryUpdate`; downstream sims read that to swap in the
 *  new vectors for the remainder of the game (when `gameId` is non-null) and
 *  for every subsequent game. */
export function buildEventSnapshots(params: {
  games: GameMeta[];
  plays: PlayEvent[];
  injuryUpdates?: InjuryUpdate[];
}): EventSnapshot[] {
  const { games, plays, injuryUpdates = [] } = params;
  const gameById = new Map(games.map((g) => [g.id, g]));

  // Merged chronological timeline of plays + injury updates. Sort key is the
  // wallclock (or `updatedAt` fallback for plays). Stable secondary keys keep
  // the run deterministic across rebuilds:
  //   - injury updates sort BEFORE plays at the same instant — so an update
  //     timestamped to a play's wallclock takes effect before that play's
  //     stats are folded in (matches the user-facing semantics: "stats from
  //     this point forward are impacted by the new injury probability").
  //   - within plays at the same instant, gameId then sequence breaks ties.
  //   - within injury updates at the same instant, id breaks ties.
  const timeline: TimelineEntry[] = [];
  for (const p of plays) {
    timeline.push({
      type: "play",
      t: (p.wallclock ?? p.updatedAt).getTime(),
      play: p,
    });
  }
  for (const u of injuryUpdates) {
    timeline.push({ type: "injury", t: u.wallclock.getTime(), update: u });
  }
  timeline.sort((a, b) => {
    if (a.t !== b.t) return a.t - b.t;
    if (a.type !== b.type) return a.type === "injury" ? -1 : 1;
    if (a.type === "play" && b.type === "play") {
      if (a.play.gameId !== b.play.gameId) return a.play.gameId < b.play.gameId ? -1 : 1;
      return a.play.sequence - b.play.sequence;
    }
    if (a.type === "injury" && b.type === "injury") {
      return a.update.id < b.update.id ? -1 : a.update.id > b.update.id ? 1 : 0;
    }
    return 0;
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
  let runningHash = FNV_OFFSET;

  // Builds the `liveGames` snapshot reflecting all running game state. Shared
  // between play-emission and injury-update-emission so the two carry the
  // same view of the world for the consumer.
  const buildLiveGames = (): LiveGameState[] => {
    const out: LiveGameState[] = [];
    for (const [gid, state] of gameState.entries()) {
      if (state.playCount === 0) continue;
      const gMeta = gameById.get(gid);
      if (!gMeta || !gMeta.seriesKey || gMeta.gameNum == null) continue;

      const remaining =
        state.status === "post"
          ? 0
          : computeRemainingFraction("in", state.period, state.clock);

      out.push({
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
    return out;
  };

  for (const entry of timeline) {
    if (entry.type === "injury") {
      const u = entry.update;
      // Injury updates contribute to the running hash so that adding,
      // removing, or editing one invalidates every downstream projection.
      runningHash = fnv1aStep(runningHash, injuryUpdateContentKey(u));

      // synthetic gameId/sequence: a game-bound update reuses that gameId so
      // the (gameId, sequence) cache key stays scoped; otherwise we use a
      // sentinel that will never collide with a real ESPN play sequence.
      const gameId = u.gameId ?? "__injury__";
      // Hash the id into a non-negative 31-bit int so it fits in
      // nbaEventProjection.sequence (Postgres `integer`). Negative space is
      // reserved for future use; collisions are caller's responsibility (the
      // `id` is required to be unique within a single rebuild anyway).
      let h = FNV_OFFSET;
      for (let i = 0; i < u.id.length; i++) {
        h ^= u.id.charCodeAt(i);
        h = Math.imul(h, FNV_PRIME);
      }
      const sequence = (h >>> 0) & 0x7fffffff;

      snapshots.push({
        event: {
          kind: "injury_update",
          gameId,
          sequence,
          updatedAt: u.wallclock,
          wallclock: u.wallclock,
          text: u.note ?? null,
          teamAbbrev: null,
          playerIds: [],
          scoreValue: null,
          period: null,
          clock: null,
          homeScore: null,
          awayScore: null,
          injuryUpdate: u,
        },
        liveGames: buildLiveGames(),
        cumulativePointsByPlayer: { ...cumulativePoints },
        cumulativeHash: runningHash.toString(16).padStart(8, "0"),
      });
      continue;
    }

    const play = entry.play;
    const meta = gameById.get(play.gameId);
    if (!meta) continue;
    const gs = gameState.get(play.gameId);
    if (!gs) continue;

    // Fold this play into the cumulative hash BEFORE the snapshot-emit
    // check, so the emitted snapshot's hash covers this triggering play.
    // Every play (scoring or not) contributes — the hash is a fingerprint
    // of the full play stream, not just the snapshot-emitting subset.
    runningHash = fnv1aStep(runningHash, playContentKey(play));

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
    } else if (play.clock === "0:00" && play.period != null) {
      // End of any period (Q1–Q4 + every OT period). When the same play is
      // both scoring AND clock=0:00 (buzzer-beater), the earlier branch
      // classifies it as "scoring" — ESPN typically emits a separate
      // end-of-period marker play right after, which we catch here.
      kind = "end_of_period";
    }
    if (kind == null) continue;

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
      liveGames: buildLiveGames(),
      cumulativePointsByPlayer: { ...cumulativePoints },
      cumulativeHash: runningHash.toString(16).padStart(8, "0"),
    });
  }

  return snapshots;
}
