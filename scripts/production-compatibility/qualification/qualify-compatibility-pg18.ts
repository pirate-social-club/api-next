import assert from "node:assert/strict";
import type pg from "pg";
import { sourceInputs } from "../source-inputs.ts";
import { bootstrap275 } from "./fixture-bootstrap.ts";
import { type CaseEvidence, completeInventory, representativeCases } from "./fixture-cases.ts";
import { fixtureTarget } from "./fixture-target.ts";

/** Separate local qualification entrypoint. Never imports the production reader main. */
export async function main(args = Bun.argv.slice(2)) {
  const target = await fixtureTarget(args);
  let owner: pg.Client | undefined,
    ownerClosed = false,
    adminClosed = false,
    phase = "ordinary_owner_bootstrap_275";
  const cases: CaseEvidence[] = [];
  const result: Record<string, unknown> = {
    kind: "local-pg18-compatibility-qualification-result-v1",
    local_only: true,
    production_accessed: false,
    suffix_migrations_applied: 0,
    prefix: 275,
    api_source: target.inputs.appSource,
    ...target.evidence,
    success: false,
    cases,
    sql_observations: target.queryObservations,
    synthetic_setup:
      "Local superuser seed uses replica mode and a partial graph without winner-credit authority. Negative fixtures temporarily remove named old keys or NOT NULL only inside acknowledged rollback transactions.",
    remaining_sql_data_cases: [
      "Representative nonempty Study/Karaoke activity rows",
      "Nonempty media upload reservations",
      "Nonempty chain-effect and pool/inventory histories",
      "Every individual nonce CHECK failing value",
      "Artificial SHA-256 collision",
      "Production reader credential/receipt CLI path",
    ],
  };
  try {
    owner = await bootstrap275(target);
    phase = "all_14_empty_prefix_queries_and_148_canonical_checks";
    const initial = await completeInventory(target, owner);
    result.empty_observations = initial;
    cases.push({ name: "empty_exact_275_all_14_queries_and_canonical_148_checks", passed: true });
    phase = "representative_old_NULL_backfill_and_catalogue_negatives";
    result.restored_observations = await representativeCases(target, owner, cases);
    cases.push({
      name: "all_14_exact_queries_after_every_negative_transaction_rollback",
      passed: true,
    });
    assert.equal(cases.length, 19);
    phase = "exact_source_and_275_ledger_unchanged";
    target.checkpoint();
    const after = await sourceInputs();
    assert.equal(after.toolingSource, target.inputs.toolingSource);
    assert.equal(after.manifestSha256, target.inputs.manifestSha256);
    assert.deepEqual(
      (
        await owner.query(
          "SELECT version,checksum FROM api_next.schema_migrations ORDER BY version",
        )
      ).rows,
      target.inputs.prefix,
    );
    phase = "connection_close";
    await owner.end();
    ownerClosed = true;
    await target.admin.end();
    adminClosed = true;
    result.success = true;
    result.case_count = cases.length;
    result.complete_query_count = 14;
  } catch (error: unknown) {
    const code =
      error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    result.failure = {
      phase,
      last_query: target.lastQuery || null,
      sqlstate: typeof code === "string" && /^[A-Z0-9]{5}$/u.test(code) ? code : null,
      message: "Local compatibility qualification refused; no managed data or credential emitted.",
    };
    process.exitCode = 1;
  } finally {
    if (owner && !ownerClosed) {
      try {
        await owner.query("ROLLBACK").catch(() => undefined);
        await owner.end();
        ownerClosed = true;
      } catch {
        result.success = false;
        process.exitCode = 1;
      }
    }
    if (!adminClosed) {
      try {
        await target.admin.query("ROLLBACK").catch(() => undefined);
        await target.admin.end();
        adminClosed = true;
      } catch {
        result.success = false;
        process.exitCode = 1;
      }
    }
    result.at = new Date().toISOString();
    result.connections_closed = ownerClosed && adminClosed;
    target.finish(result);
    console.log(
      JSON.stringify({
        success: result.success,
        phase,
        case_count: cases.length,
        complete_query_count: result.complete_query_count ?? null,
        local_only: true,
      }),
    );
  }
}

if (import.meta.main)
  main().catch(() => {
    console.error("Local PG18 qualification initialization refused.");
    process.exitCode = 1;
  });
