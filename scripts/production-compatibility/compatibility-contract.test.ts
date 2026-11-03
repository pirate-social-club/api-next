import { expect, test } from "bun:test";
import {
  aggregateObservation,
  type Observation,
  validateComplete,
  validateObservation,
  validateServingReceipt,
} from "./compatibility-contract.ts";
import { INTRODUCED_TABLE_SET_SHA256, PREDECESSOR_COUNTS, QUERIES } from "./inventory.ts";

function fixture(): Observation[] {
  return QUERIES.map((query) => {
    let rows: unknown[];
    if (query.kind === "catalogue")
      rows = Object.entries(PREDECESSOR_COUNTS).map(([table_name, total]) => ({
        table_name,
        expected_check_count: String(total),
        actual_check_count: String(total),
        missing_or_changed_checks: "0",
        unexpected_checks: "0",
        unvalidated_checks: "0",
        missing_table: 0,
      }));
    else if (query.kind === "pending")
      rows = [
        {
          table_name: query.table,
          inspected_rows: "0",
          check_false_counts: Object.fromEntries(query.checks.map((name) => [name, 0])),
        },
      ];
    else if (query.kind === "absence")
      rows = [
        {
          expected_absent_count: "76",
          unledgered_present_count: "0",
          introduced_table_set_sha256: INTRODUCED_TABLE_SET_SHA256,
        },
      ];
    else if (query.kind === "nonce")
      rows = [
        {
          attempt_count: "2",
          projected_count: "2",
          projected_rows_sha256: "a".repeat(64),
          not_null_failures: "0",
          lease_check_failures: "0",
          owner_check_failures: "0",
          revision_check_failures: "0",
          chain_check_failures: "0",
          sender_check_failures: "0",
          nonce_check_failures: "0",
          user_fk_failures: "0",
          persona_fk_failures: "0",
          missing_or_foreign_account_provenance_count: "0",
          lease_id_duplicate_groups: "0",
          sender_nonce_duplicate_groups: "0",
          owner_revision_duplicate_groups: "0",
          exact_migration_wallet_provenance_failures: "0",
        },
      ];
    else
      rows = [
        {
          published_song_count: "3",
          not_null_failures: "0",
          slot_id_duplicate_groups: "0",
          song_identity_duplicate_groups: "0",
          projected_rows_sha256: "b".repeat(64),
        },
      ];
    return { id: query.id, rows };
  });
}
function row(values: Observation[], id: string, index = 0): Record<string, unknown> {
  return values.find((value) => value.id === id)?.rows[index] as Record<string, unknown>;
}

test("requires exactly fourteen completed fixed queries and all fifteen predecessor tables", () => {
  expect(validateComplete(fixture())).toHaveLength(14);
  const missing = fixture();
  missing.pop();
  expect(() => validateComplete(missing)).toThrow();
  const duplicated = fixture();
  duplicated[1] = duplicated[0]!;
  expect(() => validateComplete(duplicated)).toThrow();
  const reversed = fixture().reverse();
  expect(() => validateComplete(reversed)).toThrow();
  const missingTable = fixture();
  missingTable[0] = { ...missingTable[0]!, rows: missingTable[0]!.rows.slice(1) };
  expect(() => validateComplete(missingTable)).toThrow();
});

test("unknown rows, fields, missing counters and null counters never become accepted aggregate evidence", () => {
  const extra = fixture();
  row(extra, "song-slots-0284").row_data = "unexpected";
  expect(() => validateComplete(extra)).toThrow();
  const missing = fixture();
  delete row(missing, "nonce-backfill-0277").user_fk_failures;
  expect(() => validateComplete(missing)).toThrow();
  const nulled = fixture();
  row(nulled, "nonce-backfill-0277").nonce_check_failures = null;
  expect(() => validateComplete(nulled)).toThrow();
  expect(() => validateObservation({ id: "unknown", rows: [] })).toThrow();
  const tableDuplicate = fixture();
  const first = tableDuplicate[0]!;
  tableDuplicate[0] = { ...first, rows: [first.rows[0], ...first.rows.slice(0, 14)] };
  expect(() => validateComplete(tableDuplicate)).toThrow();
  for (const values of [extra, missing, nulled, tableDuplicate]) {
    const index = values === extra ? 3 : values === tableDuplicate ? 0 : 2;
    expect(() => aggregateObservation(values[index]!)).toThrow();
  }
});

test("known nonzero diagnostics survive sanitization while strict compatibility and whole acceptance refuse", () => {
  const values = fixture();
  row(values, "nonce-backfill-0277").sender_nonce_duplicate_groups = "2";
  const retained = aggregateObservation(values[2]!);
  expect((retained.rows[0] as Record<string, unknown>).sender_nonce_duplicate_groups).toBe("2");
  values[2] = retained;
  expect(() => validateObservation(retained)).toThrow();
  expect(() => validateComplete(values)).toThrow();
  const catalogue = fixture();
  row(catalogue, "predecessor-check-catalogue").actual_check_count = "0";
  row(catalogue, "predecessor-check-catalogue").missing_or_changed_checks = "6";
  const missingChecks = aggregateObservation(catalogue[0]!);
  expect((missingChecks.rows[0] as Record<string, unknown>).missing_or_changed_checks).toBe("6");
  expect(() => validateObservation(missingChecks)).toThrow();
});

test("every exact nonce failure category and projection cardinality mismatch refuses", () => {
  const valid = row(fixture(), "nonce-backfill-0277");
  for (const key of Object.keys(valid).filter(
    (name) =>
      name !== "attempt_count" && name !== "projected_count" && name !== "projected_rows_sha256",
  )) {
    const values = fixture();
    row(values, "nonce-backfill-0277")[key] = "1";
    expect(() => validateComplete(values)).toThrow();
  }
  const missingJoin = fixture();
  row(missingJoin, "nonce-backfill-0277").projected_count = "1";
  expect(() => validateComplete(missingJoin)).toThrow();
});

test("every named pending CHECK counter must exist and be zero", () => {
  for (const query of QUERIES)
    if (query.kind === "pending")
      for (const name of query.checks) {
        const values = fixture();
        const counts = row(values, query.id).check_false_counts as Record<string, unknown>;
        counts[name] = 1;
        expect(() => validateComplete(values)).toThrow();
        delete counts[name];
        expect(() => validateComplete(values)).toThrow();
      }
});

test("unledgered tables, changed predecessors and metadata collision counts refuse", () => {
  for (const [id, field] of [
    ["new-table-absence", "unledgered_present_count"],
    ["predecessor-check-catalogue", "missing_or_changed_checks"],
    ["predecessor-check-catalogue", "unexpected_checks"],
    ["predecessor-check-catalogue", "unvalidated_checks"],
    ["song-slots-0284", "slot_id_duplicate_groups"],
    ["song-slots-0284", "song_identity_duplicate_groups"],
  ]) {
    const values = fixture();
    row(values, id!)[field!] = "1";
    expect(() => validateComplete(values)).toThrow();
  }
  const changedSet = fixture();
  row(changedSet, "new-table-absence").introduced_table_set_sha256 = "c".repeat(64);
  expect(() => validateComplete(changedSet)).toThrow();
});

test("serving receipt must be fresh, unique and bound to the exact production origin", () => {
  const now = Date.parse("2026-10-31T08:00:00Z");
  const value = {
    success: true,
    at: "2026-10-31T07:59:00Z",
    hyperdrives: [
      {
        id: "0c215865d7994c92b940d905f54ece37",
        origin: {
          user: "pscale_api_4bxas7gq43a4.mqfaju65wdm3",
          host: "aws-us-east-1-4.pg.psdb.cloud",
          database: "postgres",
          port: 5432,
          scheme: "postgres",
        },
      },
    ],
  };
  expect(validateServingReceipt(value, now).branch).toBe("mqfaju65wdm3");
  for (const at of ["2026-10-31T07:50:00Z", "2026-10-31T08:00:01Z", "invalid"])
    expect(() => validateServingReceipt({ ...value, at }, now)).toThrow();
  expect(() =>
    validateServingReceipt(
      { ...value, hyperdrives: [...value.hyperdrives, ...value.hyperdrives] },
      now,
    ),
  ).toThrow();
  const wrong = structuredClone(value);
  wrong.hyperdrives[0]!.origin.host = "other";
  expect(() => validateServingReceipt(wrong, now)).toThrow();
});
