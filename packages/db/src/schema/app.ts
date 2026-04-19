import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

export const league = pgTable("league", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  commissionerUserId: text("commissioner_user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  phase: text("phase").notNull().default("invite"),
  rosterSize: integer("roster_size").notNull().default(10),
  budgetPerTeam: integer("budget_per_team").notNull().default(200),
  minBid: integer("min_bid").notNull().default(1),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const leagueMember = pgTable(
  "league_member",
  {
    id: text("id").primaryKey(),
    leagueId: text("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    status: text("status").notNull().default("active"),
    draftPriority: integer("draft_priority"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    leagueUserUnique: uniqueIndex("league_member_league_user_unique").on(
      table.leagueId,
      table.userId,
    ),
  }),
);

export const leagueInvite = pgTable(
  "league_invite",
  {
    id: text("id").primaryKey(),
    leagueId: text("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    invitedByUserId: text("invited_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    acceptedByUserId: text("accepted_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at"),
  },
  (table) => ({
    leagueEmailUnique: uniqueIndex("league_invite_league_email_unique").on(
      table.leagueId,
      table.email,
    ),
  }),
);

export const draftRound = pgTable(
  "draft_round",
  {
    id: text("id").primaryKey(),
    leagueId: text("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "cascade" }),
    roundNumber: integer("round_number").notNull(),
    status: text("status").notNull().default("open"),
    eligiblePlayerMode: text("eligible_player_mode").notNull(),
    openedByUserId: text("opened_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    closedByUserId: text("closed_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    openedAt: timestamp("opened_at").notNull().defaultNow(),
    deadlineAt: timestamp("deadline_at"),
    closedAt: timestamp("closed_at"),
    resolvedAt: timestamp("resolved_at"),
  },
  (table) => ({
    leagueRoundUnique: uniqueIndex("draft_round_league_round_unique").on(
      table.leagueId,
      table.roundNumber,
    ),
  }),
);

export const draftRoundPlayer = pgTable(
  "draft_round_player",
  {
    id: text("id").primaryKey(),
    roundId: text("round_id")
      .notNull()
      .references(() => draftRound.id, { onDelete: "cascade" }),
    leagueId: text("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "cascade" }),
    playerId: text("player_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    roundPlayerUnique: uniqueIndex("draft_round_player_round_player_unique").on(
      table.roundId,
      table.playerId,
    ),
  }),
);

export const draftSubmission = pgTable(
  "draft_submission",
  {
    id: text("id").primaryKey(),
    roundId: text("round_id")
      .notNull()
      .references(() => draftRound.id, { onDelete: "cascade" }),
    leagueId: text("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    submittedAt: timestamp("submitted_at").notNull().defaultNow(),
  },
  (table) => ({
    roundUserUnique: uniqueIndex("draft_submission_round_user_unique").on(
      table.roundId,
      table.userId,
    ),
  }),
);

export const draftBid = pgTable(
  "draft_bid",
  {
    id: text("id").primaryKey(),
    submissionId: text("submission_id")
      .notNull()
      .references(() => draftSubmission.id, { onDelete: "cascade" }),
    playerId: text("player_id").notNull(),
    encryptedAmount: text("encrypted_amount").notNull(),
    isAutoDefault: boolean("is_auto_default").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    submissionPlayerUnique: uniqueIndex("draft_bid_submission_player_unique").on(
      table.submissionId,
      table.playerId,
    ),
  }),
);

export const leagueAction = pgTable(
  "league_action",
  {
    id: text("id").primaryKey(),
    leagueId: text("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    playerId: text("player_id"),
    amount: integer("amount"),
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    roundId: text("round_id").references(() => draftRound.id, {
      onDelete: "set null",
    }),
    sequenceNumber: integer("sequence_number").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    leagueSeqUnique: uniqueIndex("league_action_league_seq_unique").on(
      table.leagueId,
      table.sequenceNumber,
    ),
    leagueUserIdx: index("league_action_league_user_idx").on(
      table.leagueId,
      table.userId,
    ),
    leaguePlayerIdx: index("league_action_league_player_idx").on(
      table.leagueId,
      table.playerId,
    ),
    leagueTypeIdx: index("league_action_league_type_idx").on(
      table.leagueId,
      table.type,
    ),
  }),
);

export const auctionState = pgTable(
  "auction_state",
  {
    id: text("id").primaryKey(),
    leagueId: text("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("nominating"),
    // Timer config
    bidTimerSeconds: integer("bid_timer_seconds").notNull().default(10),
    nominationTimerSeconds: integer("nomination_timer_seconds").notNull().default(30),
    bufferMs: integer("buffer_ms").notNull().default(500),
    // Nomination rotation
    nominationOrder: jsonb("nomination_order").notNull(),
    nominationIndex: integer("nomination_index").notNull().default(0),
    currentNominatorUserId: text("current_nominator_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    // Current bidding slot
    currentPlayerId: text("current_player_id"),
    currentPlayerName: text("current_player_name"),
    currentPlayerTeam: text("current_player_team"),
    highBidAmount: integer("high_bid_amount"),
    highBidUserId: text("high_bid_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at"),
    // Pause support
    pausedAt: timestamp("paused_at"),
    statusBeforePause: text("status_before_pause"),
    // Tracking
    totalAwards: integer("total_awards").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    leagueUnique: uniqueIndex("auction_state_league_unique").on(table.leagueId),
  }),
);

export const snakeState = pgTable(
  "snake_state",
  {
    id: text("id").primaryKey(),
    leagueId: text("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("picking"),
    // Mode
    timed: boolean("timed").notNull().default(true),
    // Timer config (only used when timed = true)
    pickTimerSeconds: integer("pick_timer_seconds").notNull().default(30),
    bufferMs: integer("buffer_ms").notNull().default(500),
    // Pick order: pre-computed flat array of userIds in snake order
    pickOrder: jsonb("pick_order").notNull(),
    currentPickIndex: integer("current_pick_index").notNull().default(0),
    currentPickerUserId: text("current_picker_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    // Tracking
    totalPicks: integer("total_picks").notNull().default(0),
    currentRound: integer("current_round").notNull().default(1),
    totalRounds: integer("total_rounds").notNull(),
    // Timer
    expiresAt: timestamp("expires_at"),
    // Pause support
    pausedAt: timestamp("paused_at"),
    statusBeforePause: text("status_before_pause"),
    // Timestamps
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    leagueUnique: uniqueIndex("snake_state_league_unique").on(table.leagueId),
  }),
);

export const rosterEntry = pgTable(
  "roster_entry",
  {
    id: text("id").primaryKey(),
    leagueId: text("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    playerId: text("player_id").notNull(),
    playerName: text("player_name").notNull(),
    playerTeam: text("player_team").notNull(),
    acquisitionRoundId: text("acquisition_round_id").references(
      () => draftRound.id,
      { onDelete: "set null" },
    ),
    acquisitionOrder: integer("acquisition_order").notNull(),
    acquisitionBid: integer("acquisition_bid").notNull(),
    wonByTiebreak: boolean("won_by_tiebreak").notNull().default(false),
    isAutoAssigned: boolean("is_auto_assigned").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    leaguePlayerUnique: uniqueIndex("roster_entry_league_player_unique").on(
      table.leagueId,
      table.playerId,
    ),
  }),
);

export const nbaAthlete = pgTable("nba_athlete", {
  id: text("id").primaryKey(),
  fullName: text("full_name").notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  teamAbbrev: text("team_abbrev"),
  position: text("position"),
  jersey: text("jersey"),
  isActive: boolean("is_active").notNull().default(true),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const nbaGame = pgTable(
  "nba_game",
  {
    id: text("id").primaryKey(),
    date: timestamp("date"),
    homeTeamAbbrev: text("home_team_abbrev"),
    awayTeamAbbrev: text("away_team_abbrev"),
    homeScore: integer("home_score"),
    awayScore: integer("away_score"),
    status: text("status").notNull().default("pre"),
    period: integer("period"),
    displayClock: text("display_clock"),
    startTime: timestamp("start_time"),
    venue: text("venue"),
    broadcast: text("broadcast"),
    seriesKey: text("series_key"),
    gameNum: integer("game_num"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index("nba_game_status_idx").on(table.status),
    dateIdx: index("nba_game_date_idx").on(table.date),
    seriesIdx: index("nba_game_series_idx").on(table.seriesKey),
  }),
);

export const nbaPlayerGameStats = pgTable(
  "nba_player_game_stats",
  {
    gameId: text("game_id")
      .notNull()
      .references(() => nbaGame.id, { onDelete: "cascade" }),
    playerId: text("player_id").notNull(),
    teamAbbrev: text("team_abbrev").notNull(),
    playerName: text("player_name").notNull(),
    minutes: doublePrecision("minutes"),
    points: integer("points").notNull().default(0),
    rebounds: integer("rebounds").notNull().default(0),
    assists: integer("assists").notNull().default(0),
    steals: integer("steals").notNull().default(0),
    blocks: integer("blocks").notNull().default(0),
    turnovers: integer("turnovers").notNull().default(0),
    fgm: integer("fgm").notNull().default(0),
    fga: integer("fga").notNull().default(0),
    fg3m: integer("fg3m").notNull().default(0),
    fg3a: integer("fg3a").notNull().default(0),
    ftm: integer("ftm").notNull().default(0),
    fta: integer("fta").notNull().default(0),
    plusMinus: integer("plus_minus"),
    starter: boolean("starter").notNull().default(false),
    dnp: boolean("dnp").notNull().default(false),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.gameId, table.playerId] }),
    playerIdx: index("nba_pgs_player_idx").on(table.playerId),
  }),
);

export const nbaTeamGameStats = pgTable(
  "nba_team_game_stats",
  {
    gameId: text("game_id")
      .notNull()
      .references(() => nbaGame.id, { onDelete: "cascade" }),
    teamAbbrev: text("team_abbrev").notNull(),
    quarterScores: jsonb("quarter_scores"),
    fgPct: doublePrecision("fg_pct"),
    fg3Pct: doublePrecision("fg3_pct"),
    ftPct: doublePrecision("ft_pct"),
    reboundsTotal: integer("rebounds_total"),
    assistsTotal: integer("assists_total"),
    turnoversTotal: integer("turnovers_total"),
    largestLead: integer("largest_lead"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.gameId, table.teamAbbrev] }),
  }),
);

// ─── Plays ──────────────────────────────────────────────────────────
// Shape mirrors the ESPN SDK schema in explore/.../nba/db/schema/plays.ts —
// PK is ESPN's stable play `id` (not a composite of gameId+sequence), and
// column naming (periodNumber, clockDisplay, isScoringPlay, teamId,
// possessionTeamId, etc.) matches ESPN's payload field names so readers can
// map 1:1 without renaming.

export const nbaPlay = pgTable(
  "nba_play",
  {
    id: text("id").primaryKey(),
    gameId: text("game_id")
      .notNull()
      .references(() => nbaGame.id, { onDelete: "cascade" }),
    sequenceNumber: integer("sequence_number"),
    typeId: text("type_id"),
    typeText: text("type_text"),
    text: text("text"),
    shortText: text("short_text"),
    alternativeText: text("alternative_text"),
    shortAlternativeText: text("short_alternative_text"),
    periodNumber: integer("period_number"),
    /** ESPN: clock.value (seconds remaining in the period). */
    clockValue: doublePrecision("clock_value"),
    /** ESPN: clock.displayValue. */
    clockDisplay: text("clock_display"),
    periodDisplayValue: text("period_display_value"),
    awayScore: integer("away_score"),
    homeScore: integer("home_score"),
    isScoringPlay: boolean("is_scoring_play"),
    scoreValue: integer("score_value"),
    shootingPlay: boolean("shooting_play"),
    pointsAttempted: integer("points_attempted"),
    teamId: text("team_id"),
    possessionTeamId: text("possession_team_id"),
    coordinateX: integer("coordinate_x"),
    coordinateY: integer("coordinate_y"),
    homeWinProbability: doublePrecision("home_win_probability"),
    tieProbability: doublePrecision("tie_probability"),
    /** ESPN's wall-clock timestamp of when the play occurred. */
    wallclock: timestamp("wallclock"),
    valid: boolean("valid"),
    priority: boolean("priority"),
    modified: text("modified"),
    /** Denormalized team abbrev derived from teamId at ingest time — read path
     *  (chart, ticker) keys off this so we don't re-join on every render. */
    teamAbbrev: text("team_abbrev"),
    /** Denormalized athlete ids for this play, in participant order. Canonical
     *  source is `nba_play_participant`; this mirror lets snapshot builders
     *  avoid a per-play join. */
    playerIds: jsonb("player_ids"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    gameSeqIdx: index("nba_play_game_seq_idx").on(table.gameId, table.sequenceNumber),
    gameWallclockIdx: index("nba_play_game_wallclock_idx").on(
      table.gameId,
      table.wallclock,
    ),
    scoringIdx: index("nba_play_scoring_idx").on(table.gameId, table.isScoringPlay),
  }),
);

export const nbaPlayParticipant = pgTable(
  "nba_play_participant",
  {
    playId: text("play_id")
      .notNull()
      .references(() => nbaPlay.id, { onDelete: "cascade" }),
    athleteId: text("athlete_id").notNull(),
    positionId: text("position_id"),
    participantOrder: integer("participant_order").notNull(),
    /** e.g. "shooter", "rebounder", "fouler". */
    participantType: text("participant_type"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.playId, table.athleteId, table.participantOrder],
    }),
    athleteIdx: index("nba_play_participant_athlete_idx").on(table.athleteId),
  }),
);

export const nbaWinProb = pgTable(
  "nba_win_prob",
  {
    gameId: text("game_id")
      .notNull()
      .references(() => nbaGame.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    period: integer("period"),
    clock: text("clock"),
    homeWinPct: doublePrecision("home_win_pct"),
    tiePct: doublePrecision("tie_pct"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.gameId, table.sequence] }),
  }),
);

export const nbaSyncState = pgTable("nba_sync_state", {
  id: text("id").primaryKey(),
  lastScoreboardAt: timestamp("last_scoreboard_at"),
  lastLiveCheckAt: timestamp("last_live_check_at"),
  lastError: text("last_error"),
  /** When true, cron ingest jobs early-return. Used by migration scripts to
   *  quiesce syncs, do heavy schema work, backfill, then resume. */
  paused: boolean("paused").notNull().default(false),
  pausedReason: text("paused_reason"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const nbaEventProjection = pgTable(
  "nba_event_projection",
  {
    leagueId: text("league_id")
      .notNull()
      .references(() => league.id, { onDelete: "cascade" }),
    gameId: text("game_id").notNull(),
    sequence: integer("sequence").notNull(),
    updatedAtEvent: timestamp("updated_at_event").notNull(),
    kind: text("kind").notNull(),
    actualPoints: jsonb("actual_points").notNull(),
    projectedPoints: jsonb("projected_points").notNull(),
    eventMeta: jsonb("event_meta").notNull(),
    gamesSnapshot: jsonb("games_snapshot").notNull(),
    simCount: integer("sim_count").notNull().default(2000),
    computedAt: timestamp("computed_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.leagueId, table.gameId, table.sequence] }),
    leagueTimeIdx: index("nba_event_projection_league_time_idx").on(
      table.leagueId,
      table.updatedAtEvent,
    ),
  }),
);

// Generic cron/job registry. Rows are the source of truth for what runs and
// when — the server seeds the built-in jobs on startup and registers runtime
// handlers by `name`. Admins can pause/resume or edit the schedule live; the
// cron runner re-registers tasks in response.
export const cronJob = pgTable("cron_job", {
  id: text("id").primaryKey(), // stable slug, e.g. "nba-scoreboard-sync"
  name: text("name").notNull(),
  description: text("description"),
  schedule: text("schedule").notNull(), // cron expression, e.g. "*/15 * * * *"
  enabled: boolean("enabled").notNull().default(true),
  params: jsonb("params").$type<Record<string, unknown> | null>(),
  lastRunAt: timestamp("last_run_at"),
  lastStatus: text("last_status"), // "success" | "failure" | "running" | null
  lastError: text("last_error"),
  lastDurationMs: integer("last_duration_ms"),
  nextRunAt: timestamp("next_run_at"),
  runCount: integer("run_count").notNull().default(0),
  failureCount: integer("failure_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const nbaProjectionJob = pgTable("nba_projection_job", {
  id: text("id").primaryKey(),
  leagueId: text("league_id")
    .notNull()
    .references(() => league.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("queued"),
  totalEvents: integer("total_events"),
  processedEvents: integer("processed_events").notNull().default(0),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
  lastError: text("last_error"),
  requestedByUserId: text("requested_by_user_id").references(() => user.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
