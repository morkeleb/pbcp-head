-- pbcp 0.4 (§4.2, §9): the clamped urgency becomes the head-owned `delivery`; `urgency` is the producer's, as sent.
ALTER TABLE "cards" ADD COLUMN "delivery" text;--> statement-breakpoint
UPDATE "cards" SET "delivery" = "urgency";--> statement-breakpoint
ALTER TABLE "cards" ALTER COLUMN "delivery" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ALTER COLUMN "urgency" DROP NOT NULL;--> statement-breakpoint
UPDATE "cards" SET "urgency" = "producer_doc"->>'urgency';
