-- Predecessor application instances do not know about
-- smart_rewind_explicit. If one changes smart_rewind without changing its
-- provenance in the same statement, make the new value untrusted. Current
-- instances update both columns atomically.
CREATE FUNCTION "guard_smart_rewind_provenance"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."smart_rewind" IS DISTINCT FROM OLD."smart_rewind"
     AND NEW."smart_rewind_explicit" IS NOT DISTINCT FROM OLD."smart_rewind_explicit" THEN
    NEW."smart_rewind_explicit" := false;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "user_preferences_smart_rewind_provenance"
BEFORE UPDATE OF "smart_rewind", "smart_rewind_explicit"
ON "user_preferences"
FOR EACH ROW
EXECUTE FUNCTION "guard_smart_rewind_provenance"();
