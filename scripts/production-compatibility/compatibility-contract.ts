import assert from "node:assert/strict";
import { INTRODUCED_TABLE_SET_SHA256, PREDECESSOR_COUNTS, QUERIES } from "./inventory.ts";

export type Observation = { readonly id: string; readonly rows: readonly unknown[] };
const DIGEST = /^[a-f0-9]{64}$/u;
export function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
export function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}
function count(value: unknown): string {
  if (typeof value === "number") {
    assert.ok(Number.isSafeInteger(value) && value >= 0);
    return String(value);
  }
  assert.ok(typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value));
  return value;
}
function zero(value: unknown) {
  assert.equal(count(value), "0", "Nonzero compatibility failure count");
}
function digest(value: unknown) {
  assert.ok(typeof value === "string" && DIGEST.test(value));
}
const NONCE_FAILURES = [
  "not_null_failures",
  "lease_check_failures",
  "owner_check_failures",
  "revision_check_failures",
  "chain_check_failures",
  "sender_check_failures",
  "nonce_check_failures",
  "user_fk_failures",
  "persona_fk_failures",
  "missing_or_foreign_account_provenance_count",
  "lease_id_duplicate_groups",
  "sender_nonce_duplicate_groups",
  "owner_revision_duplicate_groups",
  "exact_migration_wallet_provenance_failures",
];
const CATALOGUE_FAILURES = [
  "missing_or_changed_checks",
  "unexpected_checks",
  "unvalidated_checks",
  "missing_table",
];

/** Known aggregate shape only: nonzero failures remain safe diagnostic evidence. */
export function aggregateObservation(value: Observation) {
  const descriptor = QUERIES.find((query) => query.id === value.id);
  assert.ok(descriptor, "Unknown compatibility query");
  assert.ok(Array.isArray(value.rows));
  if (descriptor.kind === "catalogue") {
    assert.equal(value.rows.length, Object.keys(PREDECESSOR_COUNTS).length);
    const seen = new Set<string>();
    for (const item of value.rows) {
      const row = object(item);
      exactKeys(row, [
        "table_name",
        "expected_check_count",
        "actual_check_count",
        "missing_or_changed_checks",
        "unexpected_checks",
        "unvalidated_checks",
        "missing_table",
      ]);
      assert.ok(
        typeof row.table_name === "string" && Object.hasOwn(PREDECESSOR_COUNTS, row.table_name),
      );
      assert.ok(!seen.has(row.table_name));
      seen.add(row.table_name);
      const expected = PREDECESSOR_COUNTS[row.table_name as keyof typeof PREDECESSOR_COUNTS];
      assert.equal(count(row.expected_check_count), String(expected));
      count(row.actual_check_count);
      for (const key of CATALOGUE_FAILURES) count(row[key]);
    }
  } else {
    assert.equal(value.rows.length, 1);
    const row = object(value.rows[0]);
    if (descriptor.kind === "pending") {
      exactKeys(row, ["table_name", "inspected_rows", "check_false_counts"]);
      assert.equal(row.table_name, descriptor.table);
      count(row.inspected_rows);
      const failures = object(row.check_false_counts);
      exactKeys(failures, descriptor.checks);
      for (const failuresCount of Object.values(failures)) count(failuresCount);
    } else if (descriptor.kind === "absence") {
      exactKeys(row, [
        "expected_absent_count",
        "unledgered_present_count",
        "introduced_table_set_sha256",
      ]);
      assert.equal(count(row.expected_absent_count), "76");
      count(row.unledgered_present_count);
      assert.equal(row.introduced_table_set_sha256, INTRODUCED_TABLE_SET_SHA256);
    } else if (descriptor.kind === "nonce") {
      exactKeys(row, [
        "attempt_count",
        "projected_count",
        "projected_rows_sha256",
        ...NONCE_FAILURES,
      ]);
      count(row.attempt_count);
      count(row.projected_count);
      digest(row.projected_rows_sha256);
      for (const key of NONCE_FAILURES) count(row[key]);
    } else {
      exactKeys(row, [
        "published_song_count",
        "not_null_failures",
        "slot_id_duplicate_groups",
        "song_identity_duplicate_groups",
        "projected_rows_sha256",
      ]);
      count(row.published_song_count);
      digest(row.projected_rows_sha256);
      for (const key of [
        "not_null_failures",
        "slot_id_duplicate_groups",
        "song_identity_duplicate_groups",
      ])
        count(row[key]);
    }
  }
  return structuredClone(value);
}

/** Strict compatibility acceptance is separate from retaining known failure counts. */
export function validateObservation(value: Observation) {
  const safe = aggregateObservation(value),
    descriptor = QUERIES.find((query) => query.id === safe.id)!;
  if (descriptor.kind === "catalogue") {
    for (const item of safe.rows) {
      const row = object(item);
      assert.equal(count(row.actual_check_count), count(row.expected_check_count));
      for (const key of CATALOGUE_FAILURES) zero(row[key]);
    }
  } else {
    const row = object(safe.rows[0]);
    if (descriptor.kind === "pending")
      for (const value of Object.values(object(row.check_false_counts))) zero(value);
    else if (descriptor.kind === "absence") zero(row.unledgered_present_count);
    else if (descriptor.kind === "nonce") {
      assert.equal(count(row.attempt_count), count(row.projected_count));
      for (const key of NONCE_FAILURES) zero(row[key]);
    } else
      for (const key of [
        "not_null_failures",
        "slot_id_duplicate_groups",
        "song_identity_duplicate_groups",
      ])
        zero(row[key]);
  }
  return safe;
}

export function validateComplete(values: readonly Observation[]) {
  assert.equal(values.length, QUERIES.length, "Partial compatibility inventory");
  assert.deepEqual(
    values.map((value) => value.id),
    QUERIES.map((query) => query.id),
    "Compatibility inventory/order differs",
  );
  return values.map(validateObservation);
}

/** Fresh actual origin identity precedes every managed credential read. */
export function validateServingReceipt(input: unknown, now: number) {
  const receipt = object(input);
  assert.equal(receipt.success, true);
  assert.ok(typeof receipt.at === "string");
  const at = Date.parse(receipt.at);
  assert.ok(
    Number.isFinite(at) && at <= now && now - at < 600_000,
    "Serving target evidence is stale or future",
  );
  assert.ok(Array.isArray(receipt.hyperdrives));
  const drives = receipt.hyperdrives
    .map(object)
    .filter((row) => row.id === "0c215865d7994c92b940d905f54ece37");
  assert.equal(drives.length, 1);
  const origin = object(drives[0]?.origin);
  assert.equal(origin.user, "pscale_api_4bxas7gq43a4.mqfaju65wdm3");
  assert.equal(origin.host, "aws-us-east-1-4.pg.psdb.cloud");
  assert.equal(origin.database, "postgres");
  assert.equal(String(origin.port), "5432");
  assert.equal(origin.scheme, "postgres");
  return {
    at: receipt.at,
    hyperdrive: "0c215865d7994c92b940d905f54ece37",
    environment: "production",
    branch: "mqfaju65wdm3",
  };
}
