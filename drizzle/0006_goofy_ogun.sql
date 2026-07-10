ALTER TABLE "books" ALTER COLUMN "status" SET DEFAULT 'ready';--> statement-breakpoint
ALTER TABLE "books" DROP COLUMN "processing_error";