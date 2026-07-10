CREATE TABLE "user_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"skip_back_ms" integer DEFAULT 15000 NOT NULL,
	"skip_forward_ms" integer DEFAULT 30000 NOT NULL,
	"smart_rewind" boolean DEFAULT true NOT NULL,
	"autoplay_next_in_collection" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_preferences_skip_back_valid" CHECK ("user_preferences"."skip_back_ms" >= 5000 AND "user_preferences"."skip_back_ms" <= 120000),
	CONSTRAINT "user_preferences_skip_forward_valid" CHECK ("user_preferences"."skip_forward_ms" >= 5000 AND "user_preferences"."skip_forward_ms" <= 120000)
);
--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;