CREATE TABLE "playback_action_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"book_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "playback_action_receipts" ("id", "user_id", "book_id", "recorded_at")
SELECT "id", "user_id", "book_id", "recorded_at" FROM "playback_actions"
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "playback_action_receipts" ADD CONSTRAINT "playback_action_receipts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_action_receipts" ADD CONSTRAINT "playback_action_receipts_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "playback_action_receipts_user_book_idx" ON "playback_action_receipts" USING btree ("user_id","book_id","recorded_at");
