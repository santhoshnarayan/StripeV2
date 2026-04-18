CREATE TABLE "nba_event_projection" (
	"league_id" text NOT NULL,
	"game_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"updated_at_event" timestamp NOT NULL,
	"kind" text NOT NULL,
	"actual_points" jsonb NOT NULL,
	"projected_points" jsonb NOT NULL,
	"event_meta" jsonb NOT NULL,
	"games_snapshot" jsonb NOT NULL,
	"sim_count" integer DEFAULT 2000 NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "nba_event_projection_league_id_game_id_sequence_pk" PRIMARY KEY("league_id","game_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "nba_projection_job" (
	"id" text PRIMARY KEY NOT NULL,
	"league_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"total_events" integer,
	"processed_events" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	"last_error" text,
	"requested_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nba_event_projection" ADD CONSTRAINT "nba_event_projection_league_id_league_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."league"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nba_projection_job" ADD CONSTRAINT "nba_projection_job_league_id_league_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."league"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nba_projection_job" ADD CONSTRAINT "nba_projection_job_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nba_event_projection_league_time_idx" ON "nba_event_projection" USING btree ("league_id","updated_at_event");