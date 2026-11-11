ALTER TABLE "sensitivity_floors" ALTER COLUMN "floor" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sensitivity_floors" ADD COLUMN "fold_policy" text;