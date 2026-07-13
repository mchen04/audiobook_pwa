CREATE TABLE IF NOT EXISTS "playback_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"book_id" uuid NOT NULL,
	"action" varchar(32) NOT NULL,
	"position_ms" bigint NOT NULL,
	"previous_position_ms" bigint,
	"playback_rate" numeric(4, 2) NOT NULL,
	"description" varchar(160),
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playback_actions_position_nonnegative" CHECK ("playback_actions"."position_ms" >= 0),
	CONSTRAINT "playback_actions_previous_position_nonnegative" CHECK ("playback_actions"."previous_position_ms" is null OR "playback_actions"."previous_position_ms" >= 0),
	CONSTRAINT "playback_actions_rate_valid" CHECK ("playback_actions"."playback_rate" >= 0.5 AND "playback_actions"."playback_rate" <= 3.0)
);
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public.bookmarks') IS NOT NULL AND to_regclass('public.legacy_bookmarks') IS NULL THEN
    ALTER TABLE "bookmarks" RENAME TO "legacy_bookmarks";
  ELSIF to_regclass('public.legacy_bookmarks') IS NULL THEN
    CREATE TABLE "legacy_bookmarks" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "user_id" text NOT NULL,
      "book_id" uuid NOT NULL,
      "position_ms" bigint NOT NULL,
      "note" varchar(2000),
      "client_id" uuid,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "legacy_bookmarks" DROP CONSTRAINT IF EXISTS "bookmarks_position_nonnegative";--> statement-breakpoint
ALTER TABLE "legacy_bookmarks" DROP CONSTRAINT IF EXISTS "bookmarks_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "legacy_bookmarks" DROP CONSTRAINT IF EXISTS "bookmarks_book_id_books_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "bookmarks_user_book_position_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "bookmarks_user_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "bookmarks_user_client_unique";--> statement-breakpoint
ALTER TABLE "playback_actions" DROP CONSTRAINT IF EXISTS "playback_actions_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "playback_actions" DROP CONSTRAINT IF EXISTS "playback_actions_book_id_books_id_fk";--> statement-breakpoint
ALTER TABLE "playback_actions" ADD CONSTRAINT "playback_actions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_actions" ADD CONSTRAINT "playback_actions_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "playback_actions_user_book_time_idx" ON "playback_actions" USING btree ("user_id","book_id","recorded_at","id");--> statement-breakpoint
ALTER TABLE "legacy_bookmarks" DROP CONSTRAINT IF EXISTS "legacy_bookmarks_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "legacy_bookmarks" DROP CONSTRAINT IF EXISTS "legacy_bookmarks_book_id_books_id_fk";--> statement-breakpoint
ALTER TABLE "legacy_bookmarks" ADD CONSTRAINT "legacy_bookmarks_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_bookmarks" ADD CONSTRAINT "legacy_bookmarks_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legacy_bookmarks_user_id_idx" ON "legacy_bookmarks" USING btree ("user_id","id");--> statement-breakpoint
ALTER TABLE "legacy_bookmarks" DROP CONSTRAINT IF EXISTS "legacy_bookmarks_position_nonnegative";--> statement-breakpoint
ALTER TABLE "legacy_bookmarks" ADD CONSTRAINT "legacy_bookmarks_position_nonnegative" CHECK ("legacy_bookmarks"."position_ms" >= 0);
