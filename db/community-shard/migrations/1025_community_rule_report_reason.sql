ALTER TABLE community_rules
    ADD COLUMN report_reason TEXT;

UPDATE community_rules
SET report_reason = title
WHERE report_reason IS NULL
   OR TRIM(report_reason) = '';
