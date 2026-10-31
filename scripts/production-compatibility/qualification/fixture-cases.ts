import assert from "node:assert/strict";
import type pg from "pg";
import {
  aggregateObservation,
  type Observation,
  object,
  validateComplete,
  validateObservation,
} from "../compatibility-contract.ts";
import type { Target } from "./fixture-bootstrap.ts";
import { seedSource } from "./fixture-target.ts";

export type CaseEvidence = {
  readonly name: string;
  readonly passed: true;
  readonly observation?: Observation;
};
const firstRow = (value: Observation) => object(value.rows[0]);
const number = (value: unknown) => {
  assert.ok(typeof value === "string" || typeof value === "number");
  return BigInt(value);
};

export async function observe(target: Target, db: pg.Client, id: string) {
  target.checkpoint();
  const query = target.inputs.queries.find((value) => value.id === id);
  assert.ok(query);
  target.lastQuery = id;
  const aggregate = aggregateObservation({ id, rows: (await db.query(query.sql)).rows });
  target.queryObservations.push(aggregate);
  return aggregate;
}

/** Uses exactly the production query bytes and validators inside one READ ONLY snapshot. */
export async function completeInventory(target: Target, db: pg.Client) {
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const values: Observation[] = [];
  try {
    for (const query of target.inputs.queries) {
      const value = await observe(target, db, query.id);
      values.push(value);
      validateObservation(value);
    }
    validateComplete(values);
    await db.query("ROLLBACK");
    return values;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export async function representativeCases(target: Target, owner: pg.Client, cases: CaseEvidence[]) {
  const { admin } = target;
  async function negative(
    name: string,
    setup: string,
    id: string,
    check: (value: Observation) => void,
  ) {
    target.checkpoint();
    await admin.query("BEGIN");
    try {
      // Disclosed synthetic local setup only. This setting is never used by the production reader.
      await admin.query("SET LOCAL session_replication_role=replica");
      await admin.query(setup);
      const observed = await observe(target, admin, id);
      check(observed);
      assert.throws(() => validateObservation(observed));
      cases.push({ name, passed: true, observation: observed });
    } finally {
      await admin.query("ROLLBACK");
    }
  }

  await admin.query("BEGIN");
  try {
    await admin.query("SET LOCAL session_replication_role=replica");
    await admin.query(seedSource());
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  const seeded = await completeInventory(target, owner);
  const nonce = seeded.find((value) => value.id === "nonce-backfill-0277"),
    slots = seeded.find((value) => value.id === "song-slots-0284");
  assert.ok(nonce && slots);
  assert.equal(number(firstRow(nonce).attempt_count), 2n);
  assert.equal(number(firstRow(nonce).projected_count), 2n);
  assert.equal(number(firstRow(slots).published_song_count), 2n);
  cases.push({
    name: "partial_history_all_14_exact_queries_with_two_nonce_leases",
    passed: true,
    observation: nonce,
  });
  cases.push({
    name: "two_published_song_slots_exclude_draft_song_and_video",
    passed: true,
    observation: slots,
  });

  await owner.query("BEGIN");
  try {
    await owner.query(
      "INSERT INTO qualification_policy_versions(qualification_policy_version_id,activity_key,policy_kind,policy_document) VALUES('fixture_karaoke_null@1','karaoke','karaoke_qualification_v2','{\"minimum_scored_line_count\":5,\"minimum_coverage_bps\":8500,\"minimum_final_score_bps\":7000}'::jsonb)",
    );
    // This exact installed 0079 predicate was hash-qualified by the initial catalogue query.
    const expression = (
      await owner.query(
        "SELECT pg_catalog.pg_get_expr(c.conbin,c.conrelid) AS expression FROM pg_catalog.pg_constraint c WHERE c.conrelid='api_next.qualification_policy_versions'::regclass AND c.conname='qualification_policy_document_shape'",
      )
    ).rows[0]?.expression;
    assert.ok(typeof expression === "string" && expression.length > 0);
    const evaluated = (
      await owner.query(
        "SELECT (" +
          expression +
          ") IS NULL AS old_check_is_null FROM qualification_policy_versions WHERE qualification_policy_version_id='fixture_karaoke_null@1'",
      )
    ).rows;
    assert.deepEqual(evaluated, [{ old_check_is_null: true }]);
    const failed = await observe(target, owner, "check-qualification-policy-versions");
    const counts = object(firstRow(failed).check_false_counts);
    assert.equal(number(counts["0282:qualification_policy_document_shape"]), 1n);
    assert.throws(() => validateObservation(failed));
    cases.push({
      name: "actual_0079_check_accepts_NULL_but_exact_0282_predicate_is_FALSE",
      passed: true,
      observation: failed,
    });
  } finally {
    await owner.query("ROLLBACK");
  }
  await owner.query("BEGIN");
  try {
    await owner.query(
      'INSERT INTO qualification_policy_versions(qualification_policy_version_id,activity_key,policy_kind,policy_document) VALUES(\'fixture_karaoke_valid@1\',\'karaoke\',\'karaoke_qualification_v2\',\'{"minimum_scored_line_count":5,"minimum_coverage_bps":8500,"minimum_final_score_bps":7000,"eligible_playback_kinds":["full_mix"]}\'::jsonb)',
    );
    const valid = await observe(target, owner, "check-qualification-policy-versions");
    validateObservation(valid);
    cases.push({
      name: "explicit_playback_kind_satisfies_exact_pending_policy",
      passed: true,
      observation: valid,
    });
  } finally {
    await owner.query("ROLLBACK");
  }

  await negative(
    "0277_sender_nonce_collision",
    "UPDATE reward_winner_send_attempts SET nonce=11 WHERE send_id='fixture_send_b'",
    "nonce-backfill-0277",
    (value) => {
      assert.equal(number(firstRow(value).sender_nonce_duplicate_groups), 1n);
    },
  );
  await negative(
    "0277_foreign_attempt_account",
    "UPDATE reward_winner_send_attempts SET account_id='fixture_other_account' WHERE send_id='fixture_send_b'",
    "nonce-backfill-0277",
    (value) => {
      assert.equal(number(firstRow(value).missing_or_foreign_account_provenance_count), 1n);
      assert.equal(number(firstRow(value).projected_count), 1n);
    },
  );
  await negative(
    "0277_wallet_address_mismatch",
    "UPDATE persona_wallet_assignments SET address='0x4444444444444444444444444444444444444444' WHERE assignment_id='fixture_wallet'",
    "nonce-backfill-0277",
    (value) => {
      assert.equal(number(firstRow(value).exact_migration_wallet_provenance_failures), 2n);
    },
  );
  await negative(
    "0277_missing_user_and_persona_projection",
    "UPDATE reward_winner_sends SET account_id='fixture_missing_account'; UPDATE reward_winner_send_attempts SET account_id='fixture_missing_account'",
    "nonce-backfill-0277",
    (value) => {
      assert.equal(number(firstRow(value).user_fk_failures), 2n);
      assert.equal(number(firstRow(value).persona_fk_failures), 2n);
    },
  );
  await negative(
    "0277_not_null_projection_synthetic_old_not_null_removed",
    "ALTER TABLE reward_winner_send_attempts ALTER COLUMN nonce DROP NOT NULL; UPDATE reward_winner_send_attempts SET nonce=NULL WHERE send_id='fixture_send_b'",
    "nonce-backfill-0277",
    (value) => {
      assert.equal(number(firstRow(value).not_null_failures), 1n);
    },
  );
  await negative(
    "0277_duplicate_lease_and_owner_keys_synthetic_old_keys_removed",
    "ALTER TABLE reward_winner_send_attempts DROP CONSTRAINT reward_winner_send_attempts_pkey CASCADE; ALTER TABLE reward_winner_send_attempts DROP CONSTRAINT reward_winner_send_attempts_send_id_nonce_key; INSERT INTO reward_winner_send_attempts(send_id,attempt,account_id,idempotency_key,recipient_address,amount_atomic,nonce,created_at) SELECT send_id,attempt,account_id,'fixture_duplicate_attempt',recipient_address,amount_atomic,nonce,created_at FROM reward_winner_send_attempts WHERE send_id='fixture_send_a'",
    "nonce-backfill-0277",
    (value) => {
      assert.equal(number(firstRow(value).lease_id_duplicate_groups), 1n);
      assert.equal(number(firstRow(value).owner_revision_duplicate_groups), 1n);
    },
  );
  await negative(
    "0284_slot_collision_synthetic_old_post_key_removed",
    "ALTER TABLE posts DROP CONSTRAINT posts_pkey CASCADE; DROP INDEX api_next.posts_post_id_global_unique; INSERT INTO posts(community_id,post_id,author_user_id,author_persona_id,post_type,status,title,created_at,updated_at,author_declared_rating,content_rating) SELECT community_id,post_id,author_user_id,author_persona_id,post_type,status,title,created_at,updated_at,author_declared_rating,content_rating FROM posts WHERE post_id='fixture_song_a'",
    "song-slots-0284",
    (value) => {
      assert.equal(number(firstRow(value).slot_id_duplicate_groups), 1n);
      assert.equal(number(firstRow(value).song_identity_duplicate_groups), 1n);
    },
  );

  const tableRow = (value: Observation, table: string) =>
    object(value.rows.find((item) => object(item).table_name === table));
  await negative(
    "missing_predecessor_check",
    "ALTER TABLE community_role_assignments DROP CONSTRAINT community_role_assignments_identity_not_blank",
    "predecessor-check-catalogue",
    (value) => {
      assert.equal(
        number(tableRow(value, "community_role_assignments").missing_or_changed_checks),
        1n,
      );
    },
  );
  await negative(
    "changed_predecessor_check",
    "ALTER TABLE community_role_assignments DROP CONSTRAINT community_role_assignments_identity_not_blank; ALTER TABLE community_role_assignments ADD CONSTRAINT community_role_assignments_identity_not_blank CHECK(true)",
    "predecessor-check-catalogue",
    (value) => {
      assert.equal(
        number(tableRow(value, "community_role_assignments").missing_or_changed_checks),
        1n,
      );
    },
  );
  await negative(
    "unvalidated_predecessor_check",
    "ALTER TABLE community_role_assignments DROP CONSTRAINT community_role_assignments_identity_not_blank; ALTER TABLE community_role_assignments ADD CONSTRAINT community_role_assignments_identity_not_blank CHECK(true) NOT VALID",
    "predecessor-check-catalogue",
    (value) => {
      assert.equal(number(tableRow(value, "community_role_assignments").unvalidated_checks), 1n);
    },
  );
  await negative(
    "unexpected_predecessor_check",
    "ALTER TABLE community_role_assignments ADD CONSTRAINT fixture_unexpected CHECK(true)",
    "predecessor-check-catalogue",
    (value) => {
      assert.equal(number(tableRow(value, "community_role_assignments").unexpected_checks), 1n);
    },
  );
  await negative(
    "missing_legacy_table",
    "ALTER TABLE activity_qualifications RENAME TO fixture_missing_activity_qualifications",
    "predecessor-check-catalogue",
    (value) => {
      assert.equal(number(tableRow(value, "activity_qualifications").missing_table), 1n);
    },
  );
  await negative(
    "unledgered_later_table",
    "CREATE TABLE api_next.browser_sessions(fixture boolean)",
    "new-table-absence",
    (value) => {
      assert.equal(number(firstRow(value).unledgered_present_count), 1n);
    },
  );
  return completeInventory(target, owner);
}
