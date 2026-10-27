ALTER TABLE "cards" ADD COLUMN "outcome" text;--> statement-breakpoint
CREATE INDEX "cards_orders" ON "cards" USING btree ("head_id","to_producer","change_seq");