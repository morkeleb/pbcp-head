ALTER TABLE "cards" ADD COLUMN "content" jsonb;--> statement-breakpoint
ALTER TABLE "decision_log" ADD COLUMN "content" jsonb;--> statement-breakpoint
ALTER TABLE "diagrams" ADD COLUMN "content" jsonb;--> statement-breakpoint
ALTER TABLE "heads" ADD COLUMN "data_key" text;--> statement-breakpoint
ALTER TABLE "invite_requests" ADD COLUMN "content" jsonb;