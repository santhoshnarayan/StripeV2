-- Generic cron/job registry. Lets the admin panel pause/resume/edit jobs
-- without redeploying; the cron runner reads this table at boot and
-- re-reads on change.

CREATE TABLE "cron_job" (
    "id" text PRIMARY KEY NOT NULL,
    "name" text NOT NULL,
    "description" text,
    "schedule" text NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "params" jsonb,
    "last_run_at" timestamp,
    "last_status" text,
    "last_error" text,
    "last_duration_ms" integer,
    "next_run_at" timestamp,
    "run_count" integer DEFAULT 0 NOT NULL,
    "failure_count" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
);
