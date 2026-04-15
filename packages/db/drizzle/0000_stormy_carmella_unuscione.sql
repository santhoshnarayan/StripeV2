CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "draft_bid" (
	"id" text PRIMARY KEY NOT NULL,
	"submission_id" text NOT NULL,
	"player_id" text NOT NULL,
	"encrypted_amount" text NOT NULL,
	"is_auto_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "draft_round" (
	"id" text PRIMARY KEY NOT NULL,
	"league_id" text NOT NULL,
	"round_number" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"eligible_player_mode" text NOT NULL,
	"opened_by_user_id" text NOT NULL,
	"closed_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"opened_at" timestamp DEFAULT now() NOT NULL,
	"deadline_at" timestamp,
	"closed_at" timestamp,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "draft_round_player" (
	"id" text PRIMARY KEY NOT NULL,
	"round_id" text NOT NULL,
	"league_id" text NOT NULL,
	"player_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "draft_submission" (
	"id" text PRIMARY KEY NOT NULL,
	"round_id" text NOT NULL,
	"league_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"submitted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "league" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"commissioner_user_id" text NOT NULL,
	"phase" text DEFAULT 'invite' NOT NULL,
	"roster_size" integer DEFAULT 10 NOT NULL,
	"budget_per_team" integer DEFAULT 200 NOT NULL,
	"min_bid" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "league_invite" (
	"id" text PRIMARY KEY NOT NULL,
	"league_id" text NOT NULL,
	"email" text NOT NULL,
	"invited_by_user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"accepted_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"accepted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "league_member" (
	"id" text PRIMARY KEY NOT NULL,
	"league_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"draft_priority" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roster_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"league_id" text NOT NULL,
	"user_id" text NOT NULL,
	"player_id" text NOT NULL,
	"player_name" text NOT NULL,
	"player_team" text NOT NULL,
	"acquisition_round_id" text,
	"acquisition_order" integer NOT NULL,
	"acquisition_bid" integer NOT NULL,
	"won_by_tiebreak" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_bid" ADD CONSTRAINT "draft_bid_submission_id_draft_submission_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."draft_submission"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_round" ADD CONSTRAINT "draft_round_league_id_league_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."league"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_round" ADD CONSTRAINT "draft_round_opened_by_user_id_user_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_round" ADD CONSTRAINT "draft_round_closed_by_user_id_user_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_round_player" ADD CONSTRAINT "draft_round_player_round_id_draft_round_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."draft_round"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_round_player" ADD CONSTRAINT "draft_round_player_league_id_league_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."league"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_submission" ADD CONSTRAINT "draft_submission_round_id_draft_round_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."draft_round"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_submission" ADD CONSTRAINT "draft_submission_league_id_league_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."league"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_submission" ADD CONSTRAINT "draft_submission_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league" ADD CONSTRAINT "league_commissioner_user_id_user_id_fk" FOREIGN KEY ("commissioner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_invite" ADD CONSTRAINT "league_invite_league_id_league_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."league"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_invite" ADD CONSTRAINT "league_invite_invited_by_user_id_user_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_invite" ADD CONSTRAINT "league_invite_accepted_by_user_id_user_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_member" ADD CONSTRAINT "league_member_league_id_league_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."league"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_member" ADD CONSTRAINT "league_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_entry" ADD CONSTRAINT "roster_entry_league_id_league_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."league"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_entry" ADD CONSTRAINT "roster_entry_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_entry" ADD CONSTRAINT "roster_entry_acquisition_round_id_draft_round_id_fk" FOREIGN KEY ("acquisition_round_id") REFERENCES "public"."draft_round"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "draft_bid_submission_player_unique" ON "draft_bid" USING btree ("submission_id","player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "draft_round_league_round_unique" ON "draft_round" USING btree ("league_id","round_number");--> statement-breakpoint
CREATE UNIQUE INDEX "draft_round_player_round_player_unique" ON "draft_round_player" USING btree ("round_id","player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "draft_submission_round_user_unique" ON "draft_submission" USING btree ("round_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "league_invite_league_email_unique" ON "league_invite" USING btree ("league_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "league_member_league_user_unique" ON "league_member" USING btree ("league_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roster_entry_league_player_unique" ON "roster_entry" USING btree ("league_id","player_id");