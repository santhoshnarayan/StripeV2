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

export const nbaPlay = pgTable(
  "nba_play",
  {
    gameId: text("game_id")
      .notNull()
      .references(() => nbaGame.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    period: integer("period"),
    clock: text("clock"),
    scoringPlay: boolean("scoring_play").notNull().default(false),
    scoreValue: integer("score_value"),
    text: text("text"),
    homeScore: integer("home_score"),
    awayScore: integer("away_score"),
    teamAbbrev: text("team_abbrev"),
    playerIds: jsonb("player_ids"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.gameId, table.sequence] }),
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
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
