-- A completed ungraded receipt frees the graded-attempt slot while retaining
-- its own immutable idempotent command and the one-receipt-per-presentation
-- bound. Existing commands are graded; historical result snapshots are not
-- rewritten.
ALTER TABLE study_spoken_answer_commands
  ADD COLUMN result_kind TEXT NOT NULL DEFAULT 'graded'
    CHECK (result_kind IN ('graded', 'rerecord')),
  ADD CONSTRAINT study_spoken_rerecord_completed_check
    CHECK (result_kind = 'graded' OR state = 'completed');

DO $migration$
DECLARE
  prior_constraint TEXT;
BEGIN
  SELECT conname INTO prior_constraint
    FROM pg_constraint
   WHERE conrelid = 'study_spoken_answer_commands'::regclass
     AND contype = 'u'
     AND pg_get_constraintdef(oid) =
       'UNIQUE (session_id, session_item_id, attempt_number)';
  IF prior_constraint IS NULL THEN
    RAISE EXCEPTION 'Study spoken attempt uniqueness constraint is missing';
  END IF;
  EXECUTE format(
    'ALTER TABLE study_spoken_answer_commands DROP CONSTRAINT %I',
    prior_constraint
  );
END
$migration$;

CREATE UNIQUE INDEX study_spoken_graded_command_slot_unique
  ON study_spoken_answer_commands (session_id, session_item_id, attempt_number)
  WHERE result_kind = 'graded';

CREATE UNIQUE INDEX study_spoken_rerecord_receipt_unique
  ON study_spoken_answer_commands (session_id, session_item_id, attempt_number)
  WHERE result_kind = 'rerecord';
