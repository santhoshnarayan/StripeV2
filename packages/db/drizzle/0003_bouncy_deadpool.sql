CREATE TABLE "snake_state" (
	"id" text PRIMARY KEY NOT NULL,
	"league_id" text NOT NULL,
	"status" text DEFAULT 'picking' NOT NULL,
	"timed" boolean DEFAULT true NOT NULL,
	"pick_timer_seconds" integer DEFAULT 30 NOT NULL,
	"buffer_ms" integer DEFAULT 500 NOT NULL,
	"pick_order" jsonb NOT NULL,
	"current_pick_index" integer DEFAULT 0 NOT NULL,
	"current_picker_user_id" text,
	"total_picks" integer DEFAULT 0 NOT NULL,
	"current_round" integer DEFAULT 1 NOT NULL,
	"total_rounds" integer NOT NULL,
	"expires_at" timestamp,
	"paused_at" timestamp,
	"status_before_pause" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "snake_state" ADD CONSTRAINT "snake_state_league_id_league_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."league"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snake_state" ADD CONSTRAINT "snake_state_current_picker_user_id_user_id_fk" FOREIGN KEY ("current_picker_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "snake_state_league_unique" ON "snake_state" USING btree ("league_id");