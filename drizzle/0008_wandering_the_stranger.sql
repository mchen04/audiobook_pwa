CREATE INDEX "books_owner_created_id_idx" ON "books" USING btree ("owner_id","created_at","id");--> statement-breakpoint
CREATE INDEX "books_owner_title_id_idx" ON "books" USING btree ("owner_id",lower("title"),"id");--> statement-breakpoint
CREATE INDEX "books_owner_author_id_idx" ON "books" USING btree ("owner_id",lower("author"),"id");