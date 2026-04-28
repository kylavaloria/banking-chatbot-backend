-- Add follow_up_update to the enum used by public.messages.response_mode (if applicable).
-- Run in Supabase SQL Editor or psql against your project database.
--
-- If messages.response_mode is plain text with a CHECK constraint instead of an enum,
-- update that constraint to include 'follow_up_update' separately.

DO $$
DECLARE
  col_type regtype;
BEGIN
  SELECT a.atttypid::regtype
  INTO col_type
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'messages'
    AND a.attname = 'response_mode'
    AND NOT a.attisdropped;

  IF col_type IS NULL THEN
    RAISE NOTICE 'messages.response_mode not found; nothing to do.';
    RETURN;
  END IF;

  IF (SELECT typtype FROM pg_type WHERE oid = col_type::oid) <> 'e' THEN
    RAISE NOTICE 'messages.response_mode is not an enum (type %); add follow_up_update via CHECK migration if needed.', col_type;
    RETURN;
  END IF;

  EXECUTE format('ALTER TYPE %s ADD VALUE IF NOT EXISTS %L', col_type::text, 'follow_up_update');
END$$;
