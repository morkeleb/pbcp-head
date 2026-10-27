ALTER TABLE "heads" ALTER COLUMN "timezone" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "heads" ALTER COLUMN "timezone" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "tz_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heads" ADD COLUMN "display_name" text;--> statement-breakpoint
-- `UTC` was the column default, never a choice: those heads follow their devices from now on. A zone set
-- explicitly (pnpm seed --timezone, PATCH /api/me) stays as the override.
UPDATE "heads" SET "timezone" = NULL WHERE "timezone" = 'UTC';
