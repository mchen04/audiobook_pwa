-- Supersede the update-only guard with a physical invariant visible to both
-- current and predecessor application instances: smart_rewind can be true
-- only when the same row carries trusted provenance.
CREATE OR REPLACE FUNCTION "guard_smart_rewind_provenance"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."smart_rewind" IS DISTINCT FROM OLD."smart_rewind"
       AND NEW."smart_rewind_explicit" IS NOT DISTINCT FROM OLD."smart_rewind_explicit" THEN
      NEW."smart_rewind_explicit" := false;
    END IF;
  END IF;

  IF NEW."smart_rewind" AND NOT NEW."smart_rewind_explicit" THEN
    NEW."smart_rewind" := false;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER "user_preferences_smart_rewind_provenance" ON "user_preferences";
--> statement-breakpoint
CREATE TRIGGER "user_preferences_smart_rewind_provenance"
BEFORE INSERT OR UPDATE
ON "user_preferences"
FOR EACH ROW
EXECUTE FUNCTION "guard_smart_rewind_provenance"();
