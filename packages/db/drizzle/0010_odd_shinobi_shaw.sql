CREATE INDEX "draft_round_league_status_round_idx" ON "draft_round" USING btree ("league_id","status","round_number");--> statement-breakpoint
CREATE INDEX "league_invite_email_status_idx" ON "league_invite" USING btree ("email","status");--> statement-breakpoint
CREATE INDEX "league_member_user_status_idx" ON "league_member" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "league_member_league_status_idx" ON "league_member" USING btree ("league_id","status");--> statement-breakpoint
CREATE INDEX "nba_play_game_valid_seq_idx" ON "nba_play" USING btree ("game_id","valid","sequence_number");--> statement-breakpoint
CREATE INDEX "nba_projection_job_league_created_idx" ON "nba_projection_job" USING btree ("league_id","created_at");--> statement-breakpoint
CREATE INDEX "nba_projection_job_league_status_updated_idx" ON "nba_projection_job" USING btree ("league_id","status","updated_at");