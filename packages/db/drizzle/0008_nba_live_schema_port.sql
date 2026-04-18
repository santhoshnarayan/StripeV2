-- Live-data schema port from explore/misc/sports/espn/nba/db/schema.
-- Drops nba_play and recreates with ESPN SDK-aligned shape (id PK, expanded
-- columns, renamed to match ESPN payload field names). Adds
-- nba_play_participant M2M and a pause flag on nba_sync_state for migration
-- orchestration.

ALTER TABLE "nba_sync_state" ADD COLUMN "paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "nba_sync_state" ADD COLUMN "paused_reason" text;--> statement-breakpoint

DROP TABLE "nba_play" CASCADE;--> statement-breakpoint

CREATE TABLE "nba_play" (
    "id" text PRIMARY KEY NOT NULL,
    "game_id" text NOT NULL,
    "sequence_number" integer,
    "type_id" text,
    "type_text" text,
    "text" text,
    "short_text" text,
    "alternative_text" text,
    "short_alternative_text" text,
    "period_number" integer,
    "clock_value" double precision,
    "clock_display" text,
    "period_display_value" text,
    "away_score" integer,
    "home_score" integer,
    "is_scoring_play" boolean,
    "score_value" integer,
    "shooting_play" boolean,
    "points_attempted" integer,
    "team_id" text,
    "possession_team_id" text,
    "coordinate_x" integer,
    "coordinate_y" integer,
    "home_win_probability" double precision,
    "tie_probability" double precision,
    "wallclock" timestamp,
    "valid" boolean,
    "priority" boolean,
    "modified" text,
    "team_abbrev" text,
    "player_ids" jsonb,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "nba_play" ADD CONSTRAINT "nba_play_game_id_nba_game_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."nba_game"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nba_play_game_seq_idx" ON "nba_play" USING btree ("game_id","sequence_number");--> statement-breakpoint
CREATE INDEX "nba_play_game_wallclock_idx" ON "nba_play" USING btree ("game_id","wallclock");--> statement-breakpoint
CREATE INDEX "nba_play_scoring_idx" ON "nba_play" USING btree ("game_id","is_scoring_play");--> statement-breakpoint

CREATE TABLE "nba_play_participant" (
    "play_id" text NOT NULL,
    "athlete_id" text NOT NULL,
    "position_id" text,
    "participant_order" integer NOT NULL,
    "participant_type" text,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "nba_play_participant_play_id_athlete_id_participant_order_pk" PRIMARY KEY ("play_id","athlete_id","participant_order")
);--> statement-breakpoint

ALTER TABLE "nba_play_participant" ADD CONSTRAINT "nba_play_participant_play_id_nba_play_id_fk" FOREIGN KEY ("play_id") REFERENCES "public"."nba_play"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nba_play_participant_athlete_idx" ON "nba_play_participant" USING btree ("athlete_id");
