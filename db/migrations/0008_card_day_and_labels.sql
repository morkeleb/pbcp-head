CREATE TABLE "label_ceilings" (
	"head_id" text NOT NULL,
	"label" text NOT NULL,
	"ceiling" text NOT NULL,
	CONSTRAINT "label_ceilings_head_id_label_pk" PRIMARY KEY("head_id","label")
);
--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "day" date;--> statement-breakpoint
-- §8: existing cards get their day as lib/store.ts would set it: `about`, else received_at in the head's effective
-- timezone (its own setting, else its most recently seen device's, else UTC; lib/timezone.ts).
UPDATE "cards" c SET "day" = coalesce(
  (c."producer_doc"->>'about')::date,
  (c."received_at" AT TIME ZONE coalesce(
    (SELECT h."timezone" FROM "heads" h WHERE h."id" = c."head_id"),
    (SELECT d."timezone" FROM "devices" d WHERE d."head_id" = c."head_id" AND d."revoked_at" IS NULL AND d."timezone" IS NOT NULL AND d."tz_seen_at" IS NOT NULL ORDER BY d."tz_seen_at" DESC LIMIT 1),
    'UTC'
  ))::date
);--> statement-breakpoint
ALTER TABLE "cards" ALTER COLUMN "day" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "rendered_paragraph" jsonb;--> statement-breakpoint
ALTER TABLE "label_ceilings" ADD CONSTRAINT "label_ceilings_head_id_heads_id_fk" FOREIGN KEY ("head_id") REFERENCES "public"."heads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cards_day" ON "cards" USING btree ("head_id","day");