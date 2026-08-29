ALTER TABLE study_language_profile_units
  ADD COLUMN proper_name_only BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE study_language_profile_units
  ADD CONSTRAINT study_language_profile_units_exclusive_nonlexical_kind_check
  CHECK (NOT (vocable_only AND proper_name_only));

COMMENT ON COLUMN study_language_profile_units.proper_name_only IS
  'Immutable analyzer fact: every lexical token is a proper name and no translatable common-word content exists.';
