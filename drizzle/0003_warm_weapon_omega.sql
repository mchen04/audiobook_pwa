ALTER TABLE "bookmarks" ADD COLUMN "client_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "bookmarks_user_client_unique" ON "bookmarks" USING btree ("user_id","client_id");