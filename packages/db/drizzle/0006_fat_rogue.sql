ALTER TABLE "nba_play" ADD COLUMN "clock_value" double precision;--> statement-breakpoint
ALTER TABLE "nba_play" ADD COLUMN "shooting_play" boolean;--> statement-breakpoint
ALTER TABLE "nba_play" ADD COLUMN "type_text" text;--> statement-breakpoint
ALTER TABLE "nba_play" ADD COLUMN "short_text" text;--> statement-breakpoint
ALTER TABLE "nba_play" ADD COLUMN "coordinate_x" integer;--> statement-breakpoint
ALTER TABLE "nba_play" ADD COLUMN "coordinate_y" integer;--> statement-breakpoint
ALTER TABLE "nba_play" ADD COLUMN "home_win_probability" double precision;--> statement-breakpoint
ALTER TABLE "nba_play" ADD COLUMN "tie_probability" double precision;--> statement-breakpoint
ALTER TABLE "nba_play" ADD COLUMN "wallclock" timestamp;