CREATE TYPE "public"."book_status" AS ENUM('uploading', 'processing', 'ready', 'failed', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."cleanup_status" AS ENUM('pending', 'running', 'complete', 'failed');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "book_tags" (
	"book_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "book_tags_book_id_tag_id_pk" PRIMARY KEY("book_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "bookmarks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"book_id" uuid NOT NULL,
	"position_ms" bigint NOT NULL,
	"note" varchar(2000),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookmarks_position_nonnegative" CHECK ("bookmarks"."position_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "books" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"title" varchar(300) NOT NULL,
	"author" varchar(240) DEFAULT 'Unknown author' NOT NULL,
	"narrator" varchar(240),
	"description" text,
	"series" varchar(240),
	"series_position" numeric(8, 2),
	"cover_storage_key" text,
	"status" "book_status" DEFAULT 'uploading' NOT NULL,
	"processing_error" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "books_title_not_blank" CHECK (length(trim("books"."title")) > 0)
);
--> statement-breakpoint
CREATE TABLE "chapters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"book_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" varchar(500) NOT NULL,
	"start_ms" bigint NOT NULL,
	"end_ms" bigint NOT NULL,
	CONSTRAINT "chapters_position_nonnegative" CHECK ("chapters"."position" >= 0),
	CONSTRAINT "chapters_bounds_valid" CHECK ("chapters"."start_ms" >= 0 AND "chapters"."end_ms" > "chapters"."start_ms")
);
--> statement-breakpoint
CREATE TABLE "cleanup_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_key" text NOT NULL,
	"status" "cleanup_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cleanup_jobs_attempts_nonnegative" CHECK ("cleanup_jobs"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "collection_books" (
	"collection_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_books_collection_id_book_id_pk" PRIMARY KEY("collection_id","book_id"),
	CONSTRAINT "collection_books_position_nonnegative" CHECK ("collection_books"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" varchar(120) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collections_name_not_blank" CHECK (length(trim("collections"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "listening_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"book_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"start_position_ms" bigint NOT NULL,
	"end_position_ms" bigint NOT NULL,
	"listened_ms" bigint NOT NULL,
	CONSTRAINT "listening_sessions_times_valid" CHECK ("listening_sessions"."ended_at" >= "listening_sessions"."started_at"),
	CONSTRAINT "listening_sessions_positions_nonnegative" CHECK ("listening_sessions"."start_position_ms" >= 0 AND "listening_sessions"."end_position_ms" >= 0),
	CONSTRAINT "listening_sessions_duration_nonnegative" CHECK ("listening_sessions"."listened_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"book_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"original_filename" varchar(512) NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"duration_ms" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_assets_byte_size_positive" CHECK ("media_assets"."byte_size" > 0),
	CONSTRAINT "media_assets_duration_positive" CHECK ("media_assets"."duration_ms" > 0)
);
--> statement-breakpoint
CREATE TABLE "playback_states" (
	"user_id" text NOT NULL,
	"book_id" uuid NOT NULL,
	"position_ms" bigint DEFAULT 0 NOT NULL,
	"playback_rate" numeric(4, 2) DEFAULT '1.00' NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"device_id" varchar(100) NOT NULL,
	"device_sequence" bigint DEFAULT 0 NOT NULL,
	"event_occurred_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playback_states_user_id_book_id_pk" PRIMARY KEY("user_id","book_id"),
	CONSTRAINT "playback_position_nonnegative" CHECK ("playback_states"."position_ms" >= 0),
	CONSTRAINT "playback_device_sequence_nonnegative" CHECK ("playback_states"."device_sequence" >= 0),
	CONSTRAINT "playback_rate_valid" CHECK ("playback_states"."playback_rate" >= 0.5 AND "playback_states"."playback_rate" <= 3.0)
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key"),
	CONSTRAINT "rate_limit_count_nonnegative" CHECK ("rate_limit"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" varchar(64),
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" varchar(80) NOT NULL,
	CONSTRAINT "tags_name_not_blank" CHECK (length(trim("tags"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" varchar(160) NOT NULL,
	"email" varchar(320) NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_tags" ADD CONSTRAINT "book_tags_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_tags" ADD CONSTRAINT "book_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_books" ADD CONSTRAINT "collection_books_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_books" ADD CONSTRAINT "collection_books_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listening_sessions" ADD CONSTRAINT "listening_sessions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listening_sessions" ADD CONSTRAINT "listening_sessions_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_states" ADD CONSTRAINT "playback_states_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_states" ADD CONSTRAINT "playback_states_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_account_unique" ON "account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "bookmarks_user_book_position_idx" ON "bookmarks" USING btree ("user_id","book_id","position_ms");--> statement-breakpoint
CREATE INDEX "books_owner_updated_idx" ON "books" USING btree ("owner_id","updated_at");--> statement-breakpoint
CREATE INDEX "books_owner_status_idx" ON "books" USING btree ("owner_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "chapters_book_position_unique" ON "chapters" USING btree ("book_id","position");--> statement-breakpoint
CREATE INDEX "chapters_book_start_idx" ON "chapters" USING btree ("book_id","start_ms");--> statement-breakpoint
CREATE INDEX "cleanup_jobs_pending_idx" ON "cleanup_jobs" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "collection_books_order_idx" ON "collection_books" USING btree ("collection_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "collections_user_name_unique" ON "collections" USING btree ("user_id",lower("name"));--> statement-breakpoint
CREATE INDEX "listening_sessions_user_started_idx" ON "listening_sessions" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "listening_sessions_book_started_idx" ON "listening_sessions" USING btree ("book_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_book_unique" ON "media_assets" USING btree ("book_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_storage_key_unique" ON "media_assets" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "media_assets_sha_owner_lookup_idx" ON "media_assets" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "playback_states_user_updated_idx" ON "playback_states" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_expiry_idx" ON "session" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_user_name_unique" ON "tags" USING btree ("user_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_lower_unique" ON "user" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");