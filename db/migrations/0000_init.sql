CREATE TABLE "cards" (
	"head_id" text NOT NULL,
	"id" text NOT NULL,
	"producer" text NOT NULL,
	"namespace" text NOT NULL,
	"producer_doc" jsonb NOT NULL,
	"urgency" text NOT NULL,
	"state" text NOT NULL,
	"change_seq" bigint NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"seen_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"snoozed_until" timestamp with time zone,
	"decision" text,
	"edited_proposal" text,
	"comment" text,
	"decided_at" timestamp with time zone,
	"delegated_to" text,
	"decided_doc" jsonb,
	"to_producer" text,
	"exec_state" text,
	"claimed_by" text,
	"claim_expires_at" timestamp with time zone,
	"claim_seq" integer,
	"wildcard_eligible" text[],
	CONSTRAINT "cards_head_id_id_pk" PRIMARY KEY("head_id","id")
);
--> statement-breakpoint
CREATE TABLE "change_counter" (
	"head_id" text PRIMARY KEY NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_log" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"head_id" text NOT NULL,
	"card_id" text NOT NULL,
	"decision" text NOT NULL,
	"edited_proposal" text,
	"comment" text,
	"delegated_to" text,
	"decided_at" timestamp with time zone NOT NULL,
	"decided_doc" jsonb NOT NULL,
	"actor" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"head_id" text NOT NULL,
	"identity_id" text,
	"name" text,
	"platform" text NOT NULL,
	"refresh_token_hash" "bytea",
	"previous_refresh_hash" "bytea",
	"refresh_expires_at" timestamp with time zone,
	"push_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "heads" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identities" (
	"id" text PRIMARY KEY NOT NULL,
	"head_id" text NOT NULL,
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"credential" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "producer_tokens" (
	"token_hash" "bytea" PRIMARY KEY NOT NULL,
	"head_id" text NOT NULL,
	"root" text NOT NULL,
	"instance" text,
	"urgency_ceiling" text DEFAULT 'brief' NOT NULL,
	"executor" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_head_id_heads_id_fk" FOREIGN KEY ("head_id") REFERENCES "public"."heads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_counter" ADD CONSTRAINT "change_counter_head_id_heads_id_fk" FOREIGN KEY ("head_id") REFERENCES "public"."heads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_log" ADD CONSTRAINT "decision_log_head_id_heads_id_fk" FOREIGN KEY ("head_id") REFERENCES "public"."heads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_head_id_heads_id_fk" FOREIGN KEY ("head_id") REFERENCES "public"."heads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_head_id_heads_id_fk" FOREIGN KEY ("head_id") REFERENCES "public"."heads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "producer_tokens" ADD CONSTRAINT "producer_tokens_head_id_heads_id_fk" FOREIGN KEY ("head_id") REFERENCES "public"."heads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cards_sync" ON "cards" USING btree ("head_id","change_seq");--> statement-breakpoint
CREATE INDEX "cards_thread" ON "cards" USING btree ("head_id","producer",("producer_doc"->>'thread'));--> statement-breakpoint
CREATE INDEX "decision_log_card" ON "decision_log" USING btree ("head_id","card_id");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_refresh" ON "devices" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX "devices_head" ON "devices" USING btree ("head_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identities_provider_subject" ON "identities" USING btree ("provider","subject");