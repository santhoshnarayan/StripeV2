CREATE TABLE "league_action" (
	"id" text PRIMARY KEY NOT NULL,
	"league_id" text NOT NULL,
	"type" text NOT NULL,
	"user_id" text,
	"player_id" text,
	"amount" integer,
	"actor_user_id" text,
	"round_id" text,
	"sequence_number" integer NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "roster_entry" ADD COLUMN "is_auto_assigned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "league_action" ADD CONSTRAINT "league_action_league_id_league_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."league"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_action" ADD CONSTRAINT "league_action_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_action" ADD CONSTRAINT "league_action_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_action" ADD CONSTRAINT "league_action_round_id_draft_round_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."draft_round"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "league_action_league_seq_unique" ON "league_action" USING btree ("league_id","sequence_number");--> statement-breakpoint
CREATE INDEX "league_action_league_user_idx" ON "league_action" USING btree ("league_id","user_id");--> statement-breakpoint
CREATE INDEX "league_action_league_player_idx" ON "league_action" USING btree ("league_id","player_id");--> statement-breakpoint
CREATE INDEX "league_action_league_type_idx" ON "league_action" USING btree ("league_id","type");