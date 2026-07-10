CREATE TABLE "playback_device_sequences" (
	"user_id" text NOT NULL,
	"book_id" uuid NOT NULL,
	"device_id" varchar(100) NOT NULL,
	"last_sequence" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playback_device_sequences_user_id_book_id_device_id_pk" PRIMARY KEY("user_id","book_id","device_id"),
	CONSTRAINT "playback_device_last_sequence_nonnegative" CHECK ("playback_device_sequences"."last_sequence" >= 0)
);
--> statement-breakpoint
ALTER TABLE "playback_device_sequences" ADD CONSTRAINT "playback_device_sequences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_device_sequences" ADD CONSTRAINT "playback_device_sequences_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;