CREATE TABLE "book_tombstones" (
	"book_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "book_tombstones" ADD CONSTRAINT "book_tombstones_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "book_tombstones_owner_deleted_idx" ON "book_tombstones" USING btree ("owner_id","deleted_at","book_id");