-- Earlier releases stored true both for an inherited default and for an
-- explicit opt-in, so there is no reliable provenance to preserve. Reset the
-- legacy state once; listeners can explicitly re-enable smart rewind after
-- upgrading.
UPDATE "user_preferences"
SET "smart_rewind" = false,
    "updated_at" = now()
WHERE "smart_rewind" = true;
