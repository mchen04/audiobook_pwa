CREATE TABLE "preference_write_receipts" (
	"user_id" text NOT NULL,
	"write_id" uuid NOT NULL,
	"applied_patch" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "preference_write_receipts_user_id_write_id_pk" PRIMARY KEY("user_id","write_id")
);
--> statement-breakpoint
ALTER TABLE "preference_write_receipts" ADD CONSTRAINT "preference_write_receipts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "preference_write_receipts_user_time_idx" ON "preference_write_receipts" USING btree ("user_id","recorded_at");