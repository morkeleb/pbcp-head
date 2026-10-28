CREATE TABLE "invite_requests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "invite_requests_email" ON "invite_requests" USING btree (lower("email"));