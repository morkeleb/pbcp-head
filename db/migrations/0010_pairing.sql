CREATE TABLE "pairing_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"head_id" text NOT NULL,
	"code_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "producer_tokens" ADD COLUMN "paired_name" text;--> statement-breakpoint
ALTER TABLE "producer_tokens" ADD COLUMN "paired_address" text;--> statement-breakpoint
ALTER TABLE "producer_tokens" ADD COLUMN "paired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_head_id_heads_id_fk" FOREIGN KEY ("head_id") REFERENCES "public"."heads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pairing_codes_hash" ON "pairing_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "pairing_codes_head" ON "pairing_codes" USING btree ("head_id");