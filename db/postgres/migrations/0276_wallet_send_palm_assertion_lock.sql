-- Send must serialize current Very evidence admission against revalidation
-- inserts, whose foreign key takes a key-share lock on each assertion. Runtime
-- may read immutable assertions but must not receive UPDATE just to lock them.
CREATE FUNCTION lock_wallet_send_palm_assertions_v1(
  input_account_id TEXT,
  input_evidence_receipt_id TEXT
) RETURNS VOID
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
AS $$
BEGIN
  PERFORM assertion.assertion_id
    FROM assertions AS assertion
    JOIN evidence_receipts AS receipt
      ON receipt.evidence_receipt_id = assertion.evidence_receipt_id
     AND receipt.user_id = assertion.user_id
     AND receipt.provider_id = 'very.web'
     AND receipt.method = 'palm_web'
     AND receipt.evidence_kind = 'very.web.server-verified.v1'
   WHERE assertion.user_id = input_account_id
     AND assertion.evidence_receipt_id = input_evidence_receipt_id
     AND assertion.claim_id IN ('human.personhood', 'credential.subject_unique')
   ORDER BY assertion.assertion_id
   FOR UPDATE OF assertion;
END;
$$;

DO $$
DECLARE
  installed_schema TEXT := current_schema();
BEGIN
  IF installed_schema IS NULL THEN
    RAISE EXCEPTION 'Send Palm lock requires a current schema';
  END IF;
  EXECUTE format(
    'ALTER FUNCTION %I.lock_wallet_send_palm_assertions_v1(text,text) SET search_path TO %I, pg_temp',
    installed_schema,
    installed_schema
  );
END;
$$;

REVOKE ALL ON FUNCTION lock_wallet_send_palm_assertions_v1(TEXT, TEXT) FROM PUBLIC;
-- Managed production role names are bound by the reviewed release permission
-- plan, never inferred from a development role existing in another database.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_next_app') THEN
    GRANT EXECUTE ON FUNCTION lock_wallet_send_palm_assertions_v1(TEXT, TEXT) TO api_next_app;
  END IF;
END;
$$;
