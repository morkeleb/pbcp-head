ALTER TABLE "producer_tokens" ADD COLUMN "name" text;--> statement-breakpoint
UPDATE "producer_tokens" SET "name" = "paired_name" WHERE "paired_name" IS NOT NULL;
