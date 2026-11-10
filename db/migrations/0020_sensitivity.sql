CREATE TABLE "sensitivity_floors" (
	"head_id" text NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"floor" text NOT NULL,
	CONSTRAINT "sensitivity_floors_head_id_scope_key_pk" PRIMARY KEY("head_id","scope","key")
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "reauthenticated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heads" ADD COLUMN "sensitivity_floor" text;--> statement-breakpoint
ALTER TABLE "sensitivity_floors" ADD CONSTRAINT "sensitivity_floors_head_id_heads_id_fk" FOREIGN KEY ("head_id") REFERENCES "public"."heads"("id") ON DELETE no action ON UPDATE no action;