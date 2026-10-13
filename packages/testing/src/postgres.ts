export type PostgresTestQueryClient = {
  readonly query: (text: string) => Promise<unknown>;
};

let baselineSql: Promise<string> | undefined;
let resetSql: Promise<string> | undefined;

function loadBaselineSql(): Promise<string> {
  baselineSql ??= Bun.file(new URL("../../../db/postgres/schema.sql", import.meta.url)).text();
  return baselineSql;
}

function loadResetSql(): Promise<string> {
  resetSql ??= Bun.file(new URL("../../../db/postgres/test-reset.sql", import.meta.url)).text();
  return resetSql;
}

async function applyAtomically(
  client: PostgresTestQueryClient,
  sql: Promise<string>,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(await sql);
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the operation failure when connection cleanup also fails.
    }
    throw error;
  }
}

/** Applies the tracked baseline to the isolated schema already selected by the caller. */
export async function applyPostgresTestBaseline(client: PostgresTestQueryClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`DO $baseline_search_path$
DECLARE
  target_schema TEXT := current_schema();
BEGIN
  IF target_schema IS NULL THEN
    RAISE EXCEPTION 'PostgreSQL test baseline requires a current schema';
  END IF;
  PERFORM pg_catalog.set_config(
    'search_path',
    pg_catalog.format('%I, pg_temp', target_schema),
    true
  );
END;
$baseline_search_path$;`);
    await client.query(await loadBaselineSql());
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the baseline failure when connection cleanup also fails.
    }
    throw error;
  }
}

const financialResetRelations = [
  "guest_owner_associations",
  "participation_eligibility_decisions",
  "megapot_owner_shares",
  "megapot_owner_snapshot_leaves",
  "megapot_owner_allocations",
  "reward_credit_persona_bindings",
  "reward_credit_recipient_selections",
] as const;

const financialResetRelationSql = financialResetRelations
  .map((relation) => `'${relation}'`)
  .join(",");

const beforeFinancialResetSql = (
  resetTargets: readonly string[],
  ownedVideoDatabase?: string,
) => `DO $owned_empty_financial_reset$
DECLARE
  schema_name TEXT := pg_catalog.current_schema();
  namespace_id OID;
  owner_id OID;
  relation_name TEXT;
  relation_id OID;
  outstanding_credit BOOLEAN;
  locked_oids OID[] := ARRAY[]::OID[];
  census_round INTEGER := 0;
  changed BOOLEAN;
  relation_row RECORD;
  video_custody BOOLEAN;
  source_manifest JSONB; source_guard RECORD; source_guard_count INTEGER; retained_history BOOLEAN;
BEGIN
  -- Reset is a test-only owner operation. No runtime principal or production
  -- namespace receives the temporary guard exception.
  IF schema_name IS NULL OR ${
    ownedVideoDatabase === undefined
      ? `schema_name !~ '^(api_next_reuse_[a-z0-9_]{1,24}_[0-9a-f]{12}_[0-9]+|api_next_hns_observer_[0-9a-f]{32})$'`
      : `schema_name<>'api_next' OR pg_catalog.current_database()<>'${ownedVideoDatabase}'`
  }
  THEN RAISE EXCEPTION 'owned disposable PostgreSQL test schema required' USING ERRCODE='GP003'; END IF;
  SELECT n.oid,c.relowner INTO STRICT namespace_id,owner_id
    FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid
    WHERE n.nspname=schema_name AND c.relname='participation_owners' AND c.relkind='r'
      AND n.nspowner=c.relowner AND c.relowner=pg_catalog.to_regrole(current_user);
  ${
    ownedVideoDatabase === undefined
      ? ""
      : `
  -- This exact database is created and destroyed by the video harness. Never
  -- admit a normal api_next namespace from only caller configuration/ownership.
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()
      AND datdba=owner_id AND NOT datistemplate)
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass('api_next.owned_video_test_custody')
      AND relnamespace=namespace_id AND relowner=owner_id AND relkind='r')
  THEN RAISE EXCEPTION 'owned video database custody unavailable' USING ERRCODE='GP003'; END IF;
  SELECT count(*)=1 AND COALESCE(bool_and(
      custody_database_oid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())
      AND custody_namespace_oid=namespace_id AND custody_role_oid=owner_id),FALSE)
    INTO STRICT video_custody FROM api_next.owned_video_test_custody;
  IF video_custody IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'owned video fixture marker mismatch' USING ERRCODE='GP003'; END IF;
  `
  }

  -- Same topology order as source migration/guest authority: first topology,
  -- then the complete reset table set. Owner DDL does not obey this advisory
  -- lock, so every current table is locked before checking outward CASCADE.
  PERFORM pg_catalog.pg_advisory_xact_lock(83000003,1);
  LOOP
    census_round:=census_round+1;
    changed:=FALSE;
    FOR relation_row IN SELECT c.oid,c.relname,c.relowner FROM pg_catalog.pg_class c
      WHERE c.relnamespace=namespace_id AND c.relkind IN('r','p')
        AND NOT(c.oid=ANY(locked_oids)) ORDER BY c.relname COLLATE "C"
    LOOP
      IF relation_row.relowner<>owner_id THEN
        RAISE EXCEPTION 'reset target must retain its owned fixture authority' USING ERRCODE='GP003'; END IF;
      -- ONLY avoids taking an outward inheritance lock before its rejection.
      EXECUTE pg_catalog.format('LOCK TABLE ONLY %I.%I IN ACCESS EXCLUSIVE MODE',schema_name,relation_row.relname);
      IF pg_catalog.to_regclass(pg_catalog.format('%I.%I',schema_name,relation_row.relname))
        IS DISTINCT FROM relation_row.oid
      THEN RAISE EXCEPTION 'reset relation identity changed while locking' USING ERRCODE='GP003'; END IF;
      locked_oids:=pg_catalog.array_append(locked_oids,relation_row.oid);
      changed:=TRUE;
    END LOOP;
    -- A FK child committed during an earlier parent-lock wait is included on
    -- the next census. Every held parent blocks later FK/INHERIT attachment.
    EXIT WHEN NOT changed;
    IF census_round>=8 THEN
      RAISE EXCEPTION 'reset table custody did not stabilize' USING ERRCODE='GP003'; END IF;
  END LOOP;
  FOREACH relation_name IN ARRAY ARRAY[${resetTargets.map((relation) => `'${relation}'`).join(",")}] LOOP
    relation_id:=pg_catalog.to_regclass(pg_catalog.format('%I.%I',schema_name,relation_name));
    IF relation_id IS NULL OR NOT(relation_id=ANY(locked_oids)) OR NOT EXISTS(
      SELECT 1 FROM pg_catalog.pg_class WHERE oid=relation_id AND relnamespace=namespace_id
        AND relowner=owner_id AND relkind='r')
    THEN RAISE EXCEPTION 'complete tracked reset relation inventory required' USING ERRCODE='GP003'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_constraint fk
    JOIN pg_catalog.pg_class parent ON parent.oid=fk.confrelid
    JOIN pg_catalog.pg_class child ON child.oid=fk.conrelid
    WHERE fk.contype='f' AND parent.relnamespace=namespace_id
      AND child.relnamespace<>namespace_id)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_inherits inheritance
      JOIN pg_catalog.pg_class parent ON parent.oid=inheritance.inhparent
      JOIN pg_catalog.pg_class child ON child.oid=inheritance.inhrelid
      WHERE parent.relnamespace=namespace_id AND child.relnamespace<>namespace_id)
  THEN RAISE EXCEPTION 'test reset cannot cascade outside its owned schema' USING ERRCODE='GP003'; END IF;

  -- The positive source row is never a caller flag. Existing owner/census/locks
  -- and outward-CASCADE checks above have already stabilized every parent.
  IF pg_catalog.to_regclass(pg_catalog.format('%I.owner_accounting_native_source_inventory_v1',schema_name)) IS NOT NULL THEN
    EXECUTE pg_catalog.format('SELECT %I.require_owner_accounting_ready_private_v1()',schema_name);
    EXECUTE pg_catalog.format('SELECT manifest FROM %I.owner_accounting_native_source_inventory_v1 WHERE singleton',schema_name)
      INTO STRICT source_manifest;
    IF source_manifest->>'phase' IS DISTINCT FROM 'owner_accounting_native_source_v1' THEN
      RAISE EXCEPTION 'complete positive test source required' USING ERRCODE='GP003'; END IF;
    EXECUTE pg_catalog.format(
      'SELECT EXISTS(SELECT 1 FROM %I.reward_ledger_credits WHERE state<>''sent'' AND amount_atomic>paid_atomic)',schema_name)
      INTO STRICT outstanding_credit;
    IF outstanding_credit THEN
      RAISE EXCEPTION 'test reset must preserve positive outstanding credits' USING ERRCODE='GP003'; END IF;
    -- Strictly stronger than a time/state guess: ANY original financial, captured,
    -- pending or unknown row in this exact closed source footprint refuses reset.
    FOREACH relation_name IN ARRAY ARRAY['account_owner_reward_operations','account_owner_reward_sources','activity_qualifications','community_purchase_funding_journal','community_purchase_funding_plans','community_purchase_funding_receipts','community_purchase_funding_reconciliation_attempts','community_purchase_funding_reconciliation_operator_actions','community_purchase_funding_requests','community_purchase_funding_transaction_claims','community_purchase_funding_transitions','custody_solvency_observations','guest_owner_association_conflicts','guest_owner_associations','guest_participation_operations','guest_resource_provider_calls','guest_resource_session_reservations','guest_study_spoken_captures','guest_study_spoken_checkpoints','learner_audio_account_producer_captures','learner_audio_account_provider_calls','learner_audio_account_spoken_checkpoints','learner_audio_delete_batches','learner_audio_delete_commands','learner_audio_upload_attempts','learner_audio_upload_cleanup_commands','learner_audio_upload_terminal_facts','megapot_allocation_batches','megapot_allocations','megapot_claim_effects','megapot_claim_receipt_evidence','megapot_deployment_attestations','megapot_drawing_observations','megapot_drawing_sweeps','megapot_fallback_cutoff_activity_evidence','megapot_fallback_cutoff_evidence','megapot_owner_allocations','megapot_owner_shares','megapot_owner_snapshot_leaves','megapot_participant_claim_guards','megapot_participant_claims','megapot_pool_beneficiary_snapshots','megapot_pool_commitment_effects','megapot_pool_drawing_transitions','megapot_pool_drawings','megapot_pool_shares','megapot_pool_snapshot_private_leaves','megapot_purchase_receipt_evidence','megapot_sweep_ticket_evidence','megapot_ticket_inventory','megapot_ticket_purchase_effects','megapot_ticket_review_evidence','megapot_usdc_approval_effects','megapot_usdc_approval_receipt_evidence','owner_captured_guest_choice_commands','owner_participation_admission_attempts','owner_participation_admission_operations','participation_eligibility_decisions','platform_referral_revenue_ledger','platform_sponsorship_budget_entries','platform_sponsorship_budgets','reward_activity_availability_observations','reward_asset_whitelist','reward_chain_effect_transitions','reward_chain_effects','reward_credit_persona_bindings','reward_credit_recipient_selections','reward_eligibility_decisions','reward_erc20_transfer_receipt_evidence','reward_gas_topup_daily_budgets','reward_gas_topup_wallets','reward_gas_topups','reward_ledger_credits','reward_native_transfer_receipt_evidence','reward_operations_run_lease_events','reward_payout_effects','reward_refund_effects','reward_signer_nonces','reward_subject_consumptions','reward_uniqueness_authorities','reward_winner_send_attempts','reward_winner_send_outcomes','reward_winner_send_transactions','reward_winner_sends','song_reward_bundle_claim_legs','song_reward_bundle_claims','song_reward_leg_funding_effects','song_reward_offer_actions','song_reward_offer_legs','song_reward_offers','sponsor_daily_ticket_totals','sponsor_withdrawal_effects','wallet_sponsored_sends'] LOOP
      IF NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements_text(source_manifest->'sourceReferences') r(name)
          WHERE r.name=relation_name) THEN
        RAISE EXCEPTION 'reset zero source relation missing' USING ERRCODE='GP003'; END IF;
      EXECUTE pg_catalog.format('SELECT EXISTS(SELECT 1 FROM %I.%I)',schema_name,relation_name)
        INTO STRICT retained_history;
      IF retained_history IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION 'test reset retains financial or original operation history' USING ERRCODE='GP003'; END IF;
    END LOOP;
    SELECT count(*) INTO STRICT source_guard_count FROM pg_catalog.jsonb_to_recordset(source_manifest->'triggers')
      AS t(relation TEXT,name TEXT,type INTEGER,enabled TEXT)
      WHERE (t.type & 32)<>0 AND t.relation<>'owner_accounting_native_source_inventory_v1';
    IF source_guard_count<>19 THEN
      RAISE EXCEPTION 'exact owned reset guard inventory required' USING ERRCODE='GP003'; END IF;
    FOR source_guard IN SELECT * FROM pg_catalog.jsonb_to_recordset(source_manifest->'triggers')
      AS t(relation TEXT,name TEXT,type INTEGER,enabled TEXT)
      WHERE (t.type & 32)<>0 AND t.relation<>'owner_accounting_native_source_inventory_v1'
      ORDER BY t.relation COLLATE "C",t.name COLLATE "C"
    LOOP
      IF source_guard.enabled IS DISTINCT FROM 'O' OR NOT EXISTS(
          SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace=namespace_id AND c.relowner=owner_id
            AND c.relname=source_guard.relation AND c.oid=ANY(locked_oids)) THEN
        RAISE EXCEPTION 'owned source guard cannot be suspended' USING ERRCODE='GP003'; END IF;
      EXECUTE pg_catalog.format('ALTER TABLE %I.%I DISABLE TRIGGER %I',schema_name,source_guard.relation,source_guard.name);
    END LOOP;
    RETURN;
  END IF;

  EXECUTE pg_catalog.format('SELECT %I.require_guest_practice_only_schema_phase_v1()',schema_name);
  EXECUTE pg_catalog.format('SELECT %I.require_disabled_owner_financial_inventory_private_v1()',schema_name);
  EXECUTE pg_catalog.format(
    'SELECT EXISTS(SELECT 1 FROM %I.reward_ledger_credits WHERE state<>''sent'' AND amount_atomic>paid_atomic)',
    schema_name
  ) INTO STRICT outstanding_credit;
  IF outstanding_credit THEN
    RAISE EXCEPTION 'test reset must preserve positive outstanding credits' USING ERRCODE='GP003';
  END IF;

  -- Attestation above checks native empty rows, exact statement guards, private
  -- function frames, RLS, and ACLs. Suspend only these seven named guards.
  FOREACH relation_name IN ARRAY ARRAY[${financialResetRelationSql}] LOOP
    EXECUTE pg_catalog.format('ALTER TABLE %I.%I DISABLE TRIGGER disabled_owner_financial_dml',schema_name,relation_name);
  END LOOP;
END;
$owned_empty_financial_reset$;`;

const restoreFinancialResetGuardsSql = `DO $restore_empty_financial_reset_guards$
DECLARE schema_name TEXT := pg_catalog.current_schema(); relation_name TEXT;
 source_manifest JSONB; source_guard RECORD; source_guard_count INTEGER;
BEGIN
  IF pg_catalog.to_regclass(pg_catalog.format('%I.owner_accounting_native_source_inventory_v1',schema_name)) IS NOT NULL THEN
    EXECUTE pg_catalog.format('SELECT manifest FROM %I.owner_accounting_native_source_inventory_v1 WHERE singleton',schema_name)
      INTO STRICT source_manifest;
    SELECT count(*) INTO STRICT source_guard_count FROM pg_catalog.jsonb_to_recordset(source_manifest->'triggers')
      AS t(relation TEXT,name TEXT,type INTEGER,enabled TEXT)
      WHERE (t.type & 32)<>0 AND t.relation<>'owner_accounting_native_source_inventory_v1';
    IF source_guard_count<>19 THEN
      RAISE EXCEPTION 'exact owned reset restoration inventory required' USING ERRCODE='GP003'; END IF;
    FOR source_guard IN SELECT * FROM pg_catalog.jsonb_to_recordset(source_manifest->'triggers')
      AS t(relation TEXT,name TEXT,type INTEGER,enabled TEXT)
      WHERE (t.type & 32)<>0 AND t.relation<>'owner_accounting_native_source_inventory_v1'
      ORDER BY t.relation COLLATE "C",t.name COLLATE "C"
    LOOP
      IF source_guard.enabled IS DISTINCT FROM 'O' THEN
        RAISE EXCEPTION 'original guard enablement differs' USING ERRCODE='GP003'; END IF;
      EXECUTE pg_catalog.format('ALTER TABLE %I.%I ENABLE TRIGGER %I',schema_name,source_guard.relation,source_guard.name);
    END LOOP;
    RETURN;
  END IF;
  FOREACH relation_name IN ARRAY ARRAY[${financialResetRelationSql}] LOOP
    EXECUTE pg_catalog.format('ALTER TABLE %I.%I ENABLE TRIGGER disabled_owner_financial_dml',schema_name,relation_name);
  END LOOP;
END;
$restore_empty_financial_reset_guards$;`;

const verifyFinancialResetSql = `DO $verify_empty_financial_reset$
DECLARE schema_name TEXT := pg_catalog.current_schema();
BEGIN
  IF pg_catalog.to_regclass(pg_catalog.format('%I.owner_accounting_native_source_inventory_v1',schema_name)) IS NOT NULL THEN
    EXECUTE pg_catalog.format('SELECT %I.require_owner_accounting_ready_private_v1()',schema_name);
    RETURN;
  END IF;
  EXECUTE pg_catalog.format('SELECT %I.require_guest_practice_only_schema_phase_v1()',schema_name);
  EXECUTE pg_catalog.format('SELECT %I.require_disabled_owner_financial_inventory_private_v1()',schema_name);
END;
$verify_empty_financial_reset$;`;

/** Builds a transaction-only reset for an owned, positively empty financial fixture. */
export function preparePostgresTestBaselineReset(
  sql: string,
  options: { readonly ownedVideoDatabase?: string } = {},
): string {
  // Closed harness-created database family only; this literal is checked against
  // actual current_database, database/schema/table owner and native fixture custody.
  if (
    options.ownedVideoDatabase !== undefined &&
    !/^api_next_video_[0-9]{13}_[a-f0-9]{1,8}$/u.test(options.ownedVideoDatabase)
  ) {
    throw new Error("Exact owned video fixture database required");
  }
  const truncateEnd = "RESTART IDENTITY CASCADE;";
  const first = sql.indexOf(truncateEnd);
  if (first < 0 || sql.indexOf(truncateEnd, first + truncateEnd.length) >= 0) {
    throw new Error("PostgreSQL test reset requires exactly one tracked TRUNCATE boundary");
  }
  const targets = sql.match(/^TRUNCATE TABLE\s+([\s\S]*?)RESTART IDENTITY CASCADE;/mu)?.[1];
  if (targets === undefined) throw new Error("Tracked PostgreSQL reset target list is unavailable");
  const resetTargets = targets.split(",").map((target) => {
    const name = target.trim().replace(/^"([a-z_][a-z0-9_]*)"$/u, "$1");
    if (!/^[a-z_][a-z0-9_]*$/u.test(name)) {
      throw new Error("Tracked PostgreSQL reset target is not a closed table identifier");
    }
    return name;
  });
  if (
    resetTargets.includes("owner_accounting_native_source_inventory_v1") ||
    /\bINSERT\s+INTO\s+(?:(?:"[a-z_][a-z0-9_]*"|[a-z_][a-z0-9_]*)\.)?(?:"owner_accounting_native_source_inventory_v1"|owner_accounting_native_source_inventory_v1)\s/u.test(
      sql,
    )
  ) {
    throw new Error("PostgreSQL test reset must preserve immutable source metadata");
  }
  if (new Set(resetTargets).size !== resetTargets.length) {
    throw new Error("Tracked PostgreSQL reset target list repeats a relation");
  }
  const split = first + truncateEnd.length;
  return `${beforeFinancialResetSql(resetTargets, options.ownedVideoDatabase)}\n${sql.slice(0, split)}\n${restoreFinancialResetGuardsSql}\n${sql.slice(split)}\n${verifyFinancialResetSql}`;
}

/** Restores only a disposable, empty-financial baseline in one owner transaction. */
export async function resetPostgresTestBaseline(client: PostgresTestQueryClient): Promise<void> {
  await applyAtomically(client, loadResetSql().then(preparePostgresTestBaselineReset));
}

const catalogFingerprintSql = `
SELECT pg_catalog.md5(COALESCE(pg_catalog.string_agg(object_definition, E'\\n' ORDER BY object_definition), '')) AS fingerprint
  FROM (
    SELECT 'relation:' || relation.relkind::text || ':' || relation.relname AS object_definition
      FROM pg_catalog.pg_class AS relation
     WHERE relation.relnamespace = pg_catalog.current_schema()::regnamespace
       AND relation.relkind = ANY (ARRAY['r', 'p', 'v', 'm', 'S', 'f']::"char"[])
    UNION ALL
    SELECT 'attribute:' || relation.relname || ':' || attribute.attnum || ':' || attribute.attname || ':' ||
           pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) || ':' || attribute.attnotnull || ':' ||
           COALESCE(pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid), '')
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
      LEFT JOIN pg_catalog.pg_attrdef AS default_value
        ON default_value.adrelid = attribute.attrelid AND default_value.adnum = attribute.attnum
     WHERE relation.relnamespace = pg_catalog.current_schema()::regnamespace
       AND attribute.attnum > 0 AND NOT attribute.attisdropped
    UNION ALL
    SELECT 'constraint:' || relation.relname || ':' || constraint_row.conname || ':' ||
           pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
      FROM pg_catalog.pg_constraint AS constraint_row
      JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_row.conrelid
     WHERE constraint_row.connamespace = pg_catalog.current_schema()::regnamespace
    UNION ALL
    SELECT 'index:' || pg_catalog.pg_get_indexdef(index_row.indexrelid)
      FROM pg_catalog.pg_index AS index_row
      JOIN pg_catalog.pg_class AS relation ON relation.oid = index_row.indrelid
     WHERE relation.relnamespace = pg_catalog.current_schema()::regnamespace
    UNION ALL
    SELECT 'trigger:' || relation.relname || ':' || pg_catalog.pg_get_triggerdef(trigger_row.oid, true)
      FROM pg_catalog.pg_trigger AS trigger_row
      JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_row.tgrelid
     WHERE relation.relnamespace = pg_catalog.current_schema()::regnamespace
       AND NOT trigger_row.tgisinternal
    UNION ALL
    SELECT 'routine:' || pg_catalog.pg_get_functiondef(routine.oid)
      FROM pg_catalog.pg_proc AS routine
     WHERE routine.pronamespace = pg_catalog.current_schema()::regnamespace
    UNION ALL
    SELECT 'type:' || type_row.typname || ':' || type_row.typtype::text || ':' ||
           type_row.typcategory::text
      FROM pg_catalog.pg_type AS type_row
     WHERE type_row.typnamespace = pg_catalog.current_schema()::regnamespace
       AND type_row.typrelid = 0
  ) AS catalog_objects`;

/** Fingerprints persistent objects in the currently selected schema. */
export async function postgresTestSchemaCatalogFingerprint(
  client: PostgresTestQueryClient,
): Promise<string> {
  const result = (await client.query(catalogFingerprintSql)) as {
    readonly rows?: readonly { readonly fingerprint?: unknown }[];
  };
  const fingerprint = result.rows?.[0]?.fingerprint;
  if (typeof fingerprint !== "string" || fingerprint.length === 0) {
    throw new Error("PostgreSQL test schema catalog fingerprint was unavailable");
  }
  return fingerprint;
}
