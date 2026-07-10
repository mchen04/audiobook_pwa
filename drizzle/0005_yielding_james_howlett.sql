ALTER TABLE "cleanup_jobs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "cleanup_jobs" CASCADE;--> statement-breakpoint
DROP INDEX "media_assets_storage_key_unique";--> statement-breakpoint
ALTER TABLE "books" DROP COLUMN "cover_storage_key";--> statement-breakpoint
ALTER TABLE "media_assets" DROP COLUMN "storage_key";--> statement-breakpoint
DROP TYPE "public"."cleanup_status";