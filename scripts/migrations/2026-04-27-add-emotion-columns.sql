-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: add emotion columns to messages
--
-- Run in the Supabase SQL editor (no migration framework in this repo).
--
-- Adds two nullable columns so the Emotion Agent can persist a per-message
-- verdict for analytics and supervisor review:
--   - emotion_label     : 'neutral' | 'anxious' | 'frustrated' | 'angry'
--                       | 'confused' | 'satisfied'
--   - emotion_intensity : 0.00 - 1.00
--
-- Both columns are nullable so historical rows continue to work without a
-- backfill, and so the bot stays operational if the Emotion Agent fails.
-- ─────────────────────────────────────────────────────────────────────────────

alter table messages
  add column if not exists emotion_label     text         null,
  add column if not exists emotion_intensity numeric(3,2) null;

-- Optional sanity-check constraints. Run these only after backfilling any
-- legacy rows you care about — kept commented to keep this migration safe to
-- re-run.
--
-- alter table messages
--   add constraint messages_emotion_label_chk
--   check (
--     emotion_label is null
--     or emotion_label in ('neutral','anxious','frustrated','angry','confused','satisfied')
--   );
--
-- alter table messages
--   add constraint messages_emotion_intensity_chk
--   check (
--     emotion_intensity is null
--     or (emotion_intensity >= 0 and emotion_intensity <= 1)
--   );

-- Useful index for the supervisor analytics dashboard query
-- (cases with at least one high-distress inbound message).
create index if not exists messages_emotion_intensity_idx
  on messages (emotion_intensity)
  where emotion_intensity is not null;
