CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
DROP INDEX "books_owner_updated_idx";--> statement-breakpoint
DROP INDEX "collection_books_order_idx";--> statement-breakpoint
CREATE INDEX "bookmarks_user_id_idx" ON "bookmarks" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "books_search_trgm_idx" ON "books" USING gin ((lower(coalesce("title", '') || ' ' || coalesce("author", '') || ' ' || coalesce("narrator", '') || ' ' || coalesce("series", ''))) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "collections_user_id_idx" ON "collections" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "listening_sessions_user_id_idx" ON "listening_sessions" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "tags_user_id_idx" ON "tags" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "tags_name_trgm_idx" ON "tags" USING gin (lower("name") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "books_owner_updated_idx" ON "books" USING btree ("owner_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "collection_books_order_idx" ON "collection_books" USING btree ("collection_id","position","book_id");
