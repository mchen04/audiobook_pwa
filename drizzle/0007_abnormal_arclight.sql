ALTER TABLE "media_assets" RENAME COLUMN "sha256" TO "fingerprint";--> statement-breakpoint
DROP INDEX "books_owner_status_idx";--> statement-breakpoint
DROP INDEX "media_assets_sha_owner_lookup_idx";--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "owner_id" text;--> statement-breakpoint
UPDATE "media_assets"
SET "owner_id" = "books"."owner_id"
FROM "books"
WHERE "media_assets"."book_id" = "books"."id";--> statement-breakpoint
ALTER TABLE "media_assets" ALTER COLUMN "owner_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "fingerprint_kind" varchar(20) DEFAULT 'sample-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_books_book_collection_idx" ON "collection_books" USING btree ("book_id","collection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_owner_sha256_unique" ON "media_assets" USING btree ("owner_id","fingerprint_kind","fingerprint") WHERE "media_assets"."fingerprint_kind" = 'sha256-v1';--> statement-breakpoint
ALTER TABLE "books" DROP COLUMN "status";--> statement-breakpoint
DROP TYPE "public"."book_status";
