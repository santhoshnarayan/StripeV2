import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
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
