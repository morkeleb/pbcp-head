ALTER TABLE "oauth_clients" ALTER COLUMN "metadata" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "refresh_family" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "refresh_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "token_endpoint_auth_method" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "devices_refresh_family" ON "devices" USING btree ("refresh_family");