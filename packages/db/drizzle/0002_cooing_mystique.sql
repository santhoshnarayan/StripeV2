CREATE TABLE "auction_state" (
	"id" text PRIMARY KEY NOT NULL,
	"league_id" text NOT NULL,
	"status" text DEFAULT 'nominating' NOT NULL,
	"bid_timer_seconds" integer DEFAULT 10 NOT NULL,
	"nomination_timer_seconds" integer DEFAULT 30 NOT NULL,
	"buffer_ms" integer DEFAULT 500 NOT NULL,
	"nomination_order" jsonb NOT NULL,
	"nomination_index" integer DEFAULT 0 NOT NULL,
	"current_nominator_user_id" text,
	"current_player_id" text,
	"current_player_name" text,
	"current_player_team" text,
	"high_bid_amount" integer,
	"high_bid_user_id" text,
	"expires_at" timestamp,
	"paused_at" timestamp,
	"status_before_pause" text,
	"total_awards" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auction_state" ADD CONSTRAINT "auction_state_league_id_league_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."league"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_state" ADD CONSTRAINT "auction_state_current_nominator_user_id_user_id_fk" FOREIGN KEY ("current_nominator_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_state" ADD CONSTRAINT "auction_state_high_bid_user_id_user_id_fk" FOREIGN KEY ("high_bid_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auction_state_league_unique" ON "auction_state" USING btree ("league_id");