-- Preserve the requested Post visibility across manual moderation review so
-- publication and immutable slug allocation use the same guarded facts.

ALTER TABLE text_content_held_revisions
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'members_only'));

COMMENT ON COLUMN text_content_held_revisions.visibility IS
  'Requested Post visibility retained until a held text submission is approved.';
