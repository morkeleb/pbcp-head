CREATE TABLE "diagrams" (
	"hash" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"svg" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "rendered_html" text;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "rendered_actions" jsonb;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "rendered_meta" jsonb;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "rendered_from" text;--> statement-breakpoint
ALTER TABLE "heads" ADD COLUMN "timezone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "heads" ADD COLUMN "last_visit_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "heads" ADD COLUMN "last_visit_at" timestamp with time zone;