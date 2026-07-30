-- Backward-compatible expand step: predecessor servers ignore this column, so
-- any true they write during build/cutover remains provenance-unknown and is
-- masked by current readers.
ALTER TABLE "user_preferences" ADD COLUMN "smart_rewind_explicit" boolean DEFAULT false NOT NULL;
