ALTER TABLE "cards" ADD COLUMN "lease_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "lease_renewals" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "lease_lapsed_at" timestamp with time zone;