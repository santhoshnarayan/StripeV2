import postgres from "postgres";

const rawUrl = process.env.DATABASE_URL || process.env.PLANETSCALE_URL;

if (!rawUrl) {
  throw new Error("DATABASE_URL or PLANETSCALE_URL is required");
}

const connectionString = rawUrl
  .replace(/&sslrootcert=[^&]*/g, "")
  .replace(/^'/, "")
  .replace(/'$/, "");

const sql = postgres(connectionString, { ssl: "require" });

async function main() {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "league" (
      "id" text PRIMARY KEY NOT NULL,
      "name" text NOT NULL,
      "commissioner_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "phase" text DEFAULT 'invite' NOT NULL,
      "roster_size" integer DEFAULT 10 NOT NULL,
      "budget_per_team" integer DEFAULT 200 NOT NULL,
      "min_bid" integer DEFAULT 1 NOT NULL,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "updated_at" timestamp DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "league_member" (
      "id" text PRIMARY KEY NOT NULL,
      "league_id" text NOT NULL REFERENCES "league"("id") ON DELETE CASCADE,
      "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "role" text DEFAULT 'member' NOT NULL,
      "status" text DEFAULT 'active' NOT NULL,
      "draft_priority" integer,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "updated_at" timestamp DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "league_invite" (
      "id" text PRIMARY KEY NOT NULL,
      "league_id" text NOT NULL REFERENCES "league"("id") ON DELETE CASCADE,
      "email" text NOT NULL,
      "invited_by_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "status" text DEFAULT 'pending' NOT NULL,
      "accepted_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "updated_at" timestamp DEFAULT now() NOT NULL,
      "accepted_at" timestamp
    );

    CREATE TABLE IF NOT EXISTS "draft_round" (
      "id" text PRIMARY KEY NOT NULL,
      "league_id" text NOT NULL REFERENCES "league"("id") ON DELETE CASCADE,
      "round_number" integer NOT NULL,
      "status" text DEFAULT 'open' NOT NULL,
      "eligible_player_mode" text NOT NULL,
      "opened_by_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "closed_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "updated_at" timestamp DEFAULT now() NOT NULL,
      "opened_at" timestamp DEFAULT now() NOT NULL,
      "deadline_at" timestamp,
      "closed_at" timestamp,
      "resolved_at" timestamp
    );

    CREATE TABLE IF NOT EXISTS "draft_round_player" (
      "id" text PRIMARY KEY NOT NULL,
      "round_id" text NOT NULL REFERENCES "draft_round"("id") ON DELETE CASCADE,
      "league_id" text NOT NULL REFERENCES "league"("id") ON DELETE CASCADE,
      "player_id" text NOT NULL,
      "created_at" timestamp DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "draft_submission" (
      "id" text PRIMARY KEY NOT NULL,
      "round_id" text NOT NULL REFERENCES "draft_round"("id") ON DELETE CASCADE,
      "league_id" text NOT NULL REFERENCES "league"("id") ON DELETE CASCADE,
      "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "updated_at" timestamp DEFAULT now() NOT NULL,
      "submitted_at" timestamp DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "draft_bid" (
      "id" text PRIMARY KEY NOT NULL,
      "submission_id" text NOT NULL REFERENCES "draft_submission"("id") ON DELETE CASCADE,
      "player_id" text NOT NULL,
      "encrypted_amount" text NOT NULL,
      "is_auto_default" boolean DEFAULT false NOT NULL,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "updated_at" timestamp DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "roster_entry" (
      "id" text PRIMARY KEY NOT NULL,
      "league_id" text NOT NULL REFERENCES "league"("id") ON DELETE CASCADE,
      "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "player_id" text NOT NULL,
      "player_name" text NOT NULL,
      "player_team" text NOT NULL,
      "acquisition_round_id" text REFERENCES "draft_round"("id") ON DELETE SET NULL,
      "acquisition_order" integer NOT NULL,
      "acquisition_bid" integer NOT NULL,
      "won_by_tiebreak" boolean DEFAULT false NOT NULL,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "updated_at" timestamp DEFAULT now() NOT NULL
    );

    ALTER TABLE "league_member" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;
    ALTER TABLE "league_member" ADD COLUMN IF NOT EXISTS "draft_priority" integer;
    ALTER TABLE "draft_round" ADD COLUMN IF NOT EXISTS "deadline_at" timestamp;
    ALTER TABLE "roster_entry" ADD COLUMN IF NOT EXISTS "won_by_tiebreak" boolean DEFAULT false NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS "league_member_league_user_unique"
      ON "league_member" ("league_id", "user_id");
    CREATE UNIQUE INDEX IF NOT EXISTS "league_invite_league_email_unique"
      ON "league_invite" ("league_id", "email");
    CREATE UNIQUE INDEX IF NOT EXISTS "draft_round_league_round_unique"
      ON "draft_round" ("league_id", "round_number");
    CREATE UNIQUE INDEX IF NOT EXISTS "draft_round_player_round_player_unique"
      ON "draft_round_player" ("round_id", "player_id");
    CREATE UNIQUE INDEX IF NOT EXISTS "draft_submission_round_user_unique"
      ON "draft_submission" ("round_id", "user_id");
    CREATE UNIQUE INDEX IF NOT EXISTS "draft_bid_submission_player_unique"
      ON "draft_bid" ("submission_id", "player_id");
    CREATE UNIQUE INDEX IF NOT EXISTS "roster_entry_league_player_unique"
      ON "roster_entry" ("league_id", "player_id");
  `);
}

try {
  await main();
  console.log("Applied app schema successfully.");
} finally {
  await sql.end();
}
