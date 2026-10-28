CREATE TABLE "cron_runs" (
	"name" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "push_endpoint" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "push_p256dh" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "push_auth" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "push_subscribed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "push_user_agent" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "notify_daily" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "notify_at_minutes" integer DEFAULT 420 NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "last_notified_on" date;