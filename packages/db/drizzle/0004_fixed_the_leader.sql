CREATE TABLE "nba_athlete" (
	"id" text PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"team_abbrev" text,
	"position" text,
	"jersey" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nba_game" (
	"id" text PRIMARY KEY NOT NULL,
	"date" timestamp,
	"home_team_abbrev" text,
	"away_team_abbrev" text,
	"home_score" integer,
	"away_score" integer,
	"status" text DEFAULT 'pre' NOT NULL,
	"period" integer,
	"display_clock" text,
	"start_time" timestamp,
	"venue" text,
	"broadcast" text,
	"series_key" text,
	"game_num" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nba_play" (
	"game_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"period" integer,
	"clock" text,
	"scoring_play" boolean DEFAULT false NOT NULL,
	"score_value" integer,
	"text" text,
	"home_score" integer,
	"away_score" integer,
	"team_abbrev" text,
	"player_ids" jsonb,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "nba_play_game_id_sequence_pk" PRIMARY KEY("game_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "nba_player_game_stats" (
	"game_id" text NOT NULL,
	"player_id" text NOT NULL,
	"team_abbrev" text NOT NULL,
	"player_name" text NOT NULL,
	"minutes" double precision,
	"points" integer DEFAULT 0 NOT NULL,
	"rebounds" integer DEFAULT 0 NOT NULL,
	"assists" integer DEFAULT 0 NOT NULL,
	"steals" integer DEFAULT 0 NOT NULL,
	"blocks" integer DEFAULT 0 NOT NULL,
	"turnovers" integer DEFAULT 0 NOT NULL,
	"fgm" integer DEFAULT 0 NOT NULL,
	"fga" integer DEFAULT 0 NOT NULL,
	"fg3m" integer DEFAULT 0 NOT NULL,
	"fg3a" integer DEFAULT 0 NOT NULL,
	"ftm" integer DEFAULT 0 NOT NULL,
	"fta" integer DEFAULT 0 NOT NULL,
	"plus_minus" integer,
	"starter" boolean DEFAULT false NOT NULL,
	"dnp" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "nba_player_game_stats_game_id_player_id_pk" PRIMARY KEY("game_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "nba_sync_state" (
	"id" text PRIMARY KEY NOT NULL,
	"last_scoreboard_at" timestamp,
	"last_live_check_at" timestamp,
	"last_error" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nba_team_game_stats" (
	"game_id" text NOT NULL,
	"team_abbrev" text NOT NULL,
	"quarter_scores" jsonb,
	"fg_pct" double precision,
	"fg3_pct" double precision,
	"ft_pct" double precision,
	"rebounds_total" integer,
	"assists_total" integer,
	"turnovers_total" integer,
	"largest_lead" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "nba_team_game_stats_game_id_team_abbrev_pk" PRIMARY KEY("game_id","team_abbrev")
);
--> statement-breakpoint
CREATE TABLE "nba_win_prob" (
	"game_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"period" integer,
	"clock" text,
	"home_win_pct" double precision,
	"tie_pct" double precision,
	CONSTRAINT "nba_win_prob_game_id_sequence_pk" PRIMARY KEY("game_id","sequence")
);
--> statement-breakpoint
ALTER TABLE "nba_play" ADD CONSTRAINT "nba_play_game_id_nba_game_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."nba_game"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nba_player_game_stats" ADD CONSTRAINT "nba_player_game_stats_game_id_nba_game_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."nba_game"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nba_team_game_stats" ADD CONSTRAINT "nba_team_game_stats_game_id_nba_game_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."nba_game"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nba_win_prob" ADD CONSTRAINT "nba_win_prob_game_id_nba_game_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."nba_game"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nba_game_status_idx" ON "nba_game" USING btree ("status");--> statement-breakpoint
CREATE INDEX "nba_game_date_idx" ON "nba_game" USING btree ("date");--> statement-breakpoint
CREATE INDEX "nba_game_series_idx" ON "nba_game" USING btree ("series_key");--> statement-breakpoint
CREATE INDEX "nba_pgs_player_idx" ON "nba_player_game_stats" USING btree ("player_id");