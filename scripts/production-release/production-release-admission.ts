import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { digest } from "../worker-binding-drift.ts";
import { checkBoundProcess } from "./production-linux-process-bound.ts";
import {
  checkGenesis,
  checkSourceManifest,
  fileHash,
  JOURNAL_DIR,
  PACKAGE,
} from "./production-operation-evidence.ts";

import {
  API_APP_SOURCE as API_SOURCE,
  FACTS_PATH,
  WEBSITE_SOURCE,
} from "./production-release-paths.ts";
import { assertToolingSource } from "./production-source-binding.ts";

export { FACTS_PATH };

const BRANCH = "mqfaju65wdm3";
const BROWSER_PLAN_FILE = "deb332e0543461e0b5b90b4196de30a7f5779a32a7629ea7382ac892bed6af9e";
const DIGEST = /^[a-f0-9]{64}$/u;
const FACT_KEYS = [
  "ordinary_recovery_review_path",
  "release_recovery_admission_path",
  "whole_operational_review_path",
];
export const facts = () => JSON.parse(readFileSync(FACTS_PATH, "utf8")).bindings;
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

function accepted(value: any) {
  assert.equal(value.accepted, true);
  assert.equal(value.reviewer_role, "independent_reviewer");
  assert.deepEqual(value.findings, []);
}
function pinned(reference: any) {
  assert.ok(reference && typeof reference.path === "string" && reference.path.startsWith("/"));
  assert.match(reference.sha256 ?? "", DIGEST);
  assert.equal(fileHash(reference.path), reference.sha256);
  return json(reference.path);
}
function fresh(at: string, now: number, age = 300_000) {
  const time = Date.parse(at);
  assert.ok(
    Number.isFinite(time) && time <= now && now - time <= age,
    "Stale or future live evidence",
  );
}
export function bound(live: any) {
  assert.ok(live && typeof live === "object");
  assert.deepEqual(Object.keys(live).sort(), FACT_KEYS);
  for (const key of FACT_KEYS)
    assert.ok(
      typeof live[key] === "string" && live[key].startsWith("/") && existsSync(live[key]),
      "Unbound live fact: " + key,
    );
}

export function assertReviewedBinding(row: any) {
  for (const key of [
    "baseline_sha256",
    "candidate_sha256",
    "settings_sha256",
    "candidate_settings_sha256",
    "candidate_settings_derivation_sha256",
  ])
    assert.match(row?.[key] ?? "", DIGEST, "Unbound worker binding: " + key);
  assert.ok(Array.isArray(row.changes));
  const derivation = pinned(row.candidate_settings_derivation);
  accepted(derivation);
  assert.equal(row.candidate_settings_derivation.sha256, row.candidate_settings_derivation_sha256);
  assert.equal(derivation.candidate_settings_sha256, row.candidate_settings_sha256);
  assert.equal(digest(derivation.normalized_candidate_settings), row.candidate_settings_sha256);
}

export function validateRecoveryQualification(recovery: any, proofs: Record<string, any>) {
  accepted(recovery);
  assert.equal(recovery.kind, "ordinary-website-auth-capable-recovery-v1");
  assert.equal(recovery.api_source, API_SOURCE);
  assert.equal(recovery.website_source, WEBSITE_SOURCE);
  assert.equal(recovery.session_schema_floor, 333);
  assert.equal(recovery.hns_required, false);
  assert.equal(recovery.auth_capable, true);
  assert.ok(
    ["staging", "local-qualified"].includes(recovery.qualification_environment),
    "Recovery qualification environment must be explicit",
  );
  assert.equal(recovery.target_environment, "production");
  assert.equal(recovery.target_branch, BRANCH);
  assert.equal(recovery.target_ordinary_origin, "https://pirate.sc");
  for (const key of [
    "issue",
    "renew",
    "acknowledged_logout",
    "installed_identity",
    "ordinary_host_recovery",
  ]) {
    const proof = proofs[key];
    assert.ok(proof);
    assert.equal(
      proof.environment,
      recovery.qualification_environment,
      "Mixed recovery proof environments",
    );
    assert.equal(proof.api_source, API_SOURCE);
    assert.equal(proof.website_source, WEBSITE_SOURCE);
  }
}

export function validateCurrentRecoveryReadiness(
  recovery: any,
  readiness: any,
  identity: any,
  recoverySha: string,
  now: number,
) {
  assert.equal(readiness.kind, "ordinary-website-recovery-current-readiness-v1");
  assert.equal(readiness.environment, "production");
  assert.equal(readiness.branch, BRANCH);
  assert.equal(readiness.ordinary_origin, "https://pirate.sc");
  assert.equal(readiness.recovery_review_sha256, recoverySha);
  assert.equal(readiness.target_api_source, API_SOURCE);
  assert.equal(readiness.target_website_source, WEBSITE_SOURCE);
  assert.ok([275, 333].includes(readiness.current_database_ledger_count));
  assert.equal(identity.environment, "production");
  assert.equal(identity.branch, BRANCH);
  assert.equal(identity.ordinary_origin, "https://pirate.sc");
  fresh(identity.observed_at, now);
  assert.equal(
    readiness.current_serving_identity.sha256,
    readiness.current_serving_identity_sha256,
  );
  assert.equal(
    readiness.recovery_artifact_identity_sha256,
    recovery.recovery_artifact_identity_sha256,
  );
  assert.match(readiness.recovery_artifact_identity_sha256 ?? "", DIGEST);
  assert.equal(readiness.available, true);
  fresh(readiness.observed_at, now);
}

function checkRecovery(reference: any, readinessReference: any, now: number) {
  const recovery = pinned(reference);
  const proofs = Object.fromEntries(
    ["issue", "renew", "acknowledged_logout", "installed_identity", "ordinary_host_recovery"].map(
      (key) => [key, pinned(recovery.proofs?.[key])],
    ),
  );
  validateRecoveryQualification(recovery, proofs);
  const readiness = pinned(readinessReference);
  validateCurrentRecoveryReadiness(
    recovery,
    readiness,
    pinned(readiness.current_serving_identity),
    reference.sha256,
    now,
  );
}

export function validateProductionBrowserPlan(
  browser: any,
  baseline: any,
  receipts: Record<string, any>,
) {
  accepted(browser);
  assert.equal(browser.source, API_SOURCE);
  assert.equal(browser.branch, BRANCH);
  assert.equal(browser.production_accepted_file_sha256, BROWSER_PLAN_FILE);
  assert.equal(browser.fixture_only_flags_superseded_for_exact_bytes, true);
  assert.equal(baseline.kind, "production-browser-plan-baseline-v1");
  assert.equal(baseline.environment, "production");
  assert.equal(baseline.branch, BRANCH);
  assert.equal(baseline.api_source, API_SOURCE);
  assert.equal(baseline.runtime_role, "pscale_api_4bxas7gq43a4");
  assert.equal(baseline.ledger_count, 275);
  assert.equal(baseline.schema, "api_next");
  for (const key of ["default_privileges", "role_and_ownership"]) {
    assert.match(baseline[key + "_sha256"] ?? "", DIGEST);
    assert.equal(baseline[key].sha256, baseline[key + "_sha256"]);
    const receipt = receipts[key];
    assert.ok(receipt);
    assert.equal(receipt.environment, "production");
    assert.equal(receipt.branch, BRANCH);
    assert.equal(receipt.ledger_count, 275);
  }
  assert.equal(browser.pre_migration_baseline_accepted_for_exact_plan, true);
}

export function validateAdmissionWindow(admission: any, now: number, minimumRemainingMs = 190_000) {
  assert.equal(admission.kind, "qualified-rewards-off-website-v1-recovery");
  assert.equal(admission.resource_owner_role, "website_launch_coordinator");
  assert.equal(admission.api_source, API_SOURCE);
  assert.equal(admission.website_source, WEBSITE_SOURCE);
  const start = Date.parse(admission.starts_at),
    end = Date.parse(admission.expires_at);
  assert.ok(
    Number.isFinite(start) &&
      Number.isFinite(end) &&
      start <= now &&
      now < end &&
      end - start <= 10_800_000,
  );
  assert.ok(end - now >= minimumRemainingMs);
  for (const key of ["phone_acceptance_sha256", "disclosure_sha256", "public_legal_source_sha256"])
    assert.match(admission[key] ?? "", DIGEST);
}

/** The backup is checked before every live SQL phase, including grants on an already upgraded ledger. */
export function checkBackup(review: any, now = Date.now()) {
  const backup = pinned(review.production_backup);
  assert.equal(backup.kind, "website-production-backup-readiness-v1");
  accepted(backup);
  assert.equal(backup.environment, "production");
  assert.equal(backup.logical_branch, "main");
  assert.equal(backup.branch_id, BRANCH);
  assert.equal(backup.database, "postgres");
  assert.equal(backup.completed, true);
  assert.ok(typeof backup.backup_id === "string" && backup.backup_id.length > 0);
  fresh(backup.observed_at, now);
  fresh(backup.completed_at, now, 24 * 60 * 60 * 1000);
  assert.ok(
    Date.parse(backup.expires_at) > now + 190_000,
    "Backup expired or expires within operation bound",
  );
  return backup;
}

/** Live Linux ancestry, pinned binaries and absent completion evidence bind the actual timeout child. */
export function validateOuterProcessExecution(input: {
  mode: string;
  executor: string;
  admissionSha: string;
  reviewSha: string;
  review: any;
  now: number;
  startPath: string | undefined;
  journalDirectory: string;
  wrapperPath: string;
}) {
  const {
    mode,
    executor,
    admissionSha,
    reviewSha,
    review,
    now,
    startPath: path,
    journalDirectory,
    wrapperPath,
  } = input;
  assert.ok(
    path &&
      path === join(journalDirectory, basename(path)) &&
      /^outer-[a-f0-9-]+-start\.json$/u.test(basename(path)),
    "Missing outer start evidence",
  );
  const endPath = path.replace(/-start\.json$/u, "-end.json"),
    childPath = path.replace(/-start\.json$/u, "-child.json");
  assert.ok(!existsSync(endPath), "Outer start already completed; replay is forbidden");
  const start = json(path);
  fresh(start.at, now, 180_000);
  assert.equal(start.kind, "website-release-outer-start-v2");
  assert.equal(start.mode, mode);
  assert.equal(start.executor_sha256, executor);
  assert.equal(start.admission_sha256, admissionSha);
  assert.equal(start.review_sha256, reviewSha);
  assert.equal(start.wrapper_sha256, fileHash(wrapperPath));
  assert.equal(review.outer_wrapper_sha256, start.wrapper_sha256);
  assert.equal(start.timeout_ms, 180_000);
  assert.equal(start.kill_after_ms, 10_000);
  assert.ok(Array.isArray(start.argv));
  assert.equal(start.argv[0], process.execPath);
  assert.equal(start.argv[1], process.argv[1]);
  assert.deepEqual(start.argv.slice(2), process.argv.slice(2));
  // The child can start just before its parent publishes its timeout identity. This wait precedes credentials and never starts a process.
  const until = process.hrtime.bigint() + 2_000_000_000n;
  while (!existsSync(childPath) && !existsSync(endPath) && process.hrtime.bigint() < until)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  assert.ok(!existsSync(endPath), "Outer command completed during admission");
  const child = json(childPath);
  assert.equal(child.start_sha256, fileHash(path));
  assert.equal(child.kind, "website-release-timeout-child-v1");
  checkBoundProcess(start, child, wrapperPath, review);
  assert.ok(!existsSync(endPath), "Outer command completed while ancestry was checked");
}

/** All facts remain null in this cold package. This validator does not manufacture operational admission. */
export function admitted(
  mode = "verify",
  executor = "",
  requireOuter = false,
  minimumRemainingMs = 190_000,
) {
  const live = facts();
  bound(live);
  const now = Date.now();
  const admission = json(live.release_recovery_admission_path),
    review = json(live.whole_operational_review_path);
  const admissionSha = fileHash(live.release_recovery_admission_path),
    reviewSha = fileHash(live.whole_operational_review_path);
  const recoverySha = fileHash(live.ordinary_recovery_review_path);
  validateAdmissionWindow(admission, now, minimumRemainingMs);
  assert.equal(admission.recovery_review_sha256, recoverySha);
  accepted(review);
  assertToolingSource(review);
  assert.equal(review.api_source, API_SOURCE);
  assert.equal(review.website_source, WEBSITE_SOURCE);
  assert.equal(review.adapter_manifest_sha256, checkSourceManifest());
  assert.equal(review.release_recovery_admission_sha256, admissionSha);
  assert.equal(review.ordinary_recovery_review_sha256, recoverySha);
  assert.equal(review.live_facts_sha256, fileHash(FACTS_PATH));
  checkRecovery(
    { path: live.ordinary_recovery_review_path, sha256: recoverySha },
    review.current_recovery_readiness,
    now,
  );
  checkGenesis(review);
  for (const name of ["gateway", "media", "http", "jobs"])
    assertReviewedBinding(review.worker_bindings?.[name]);
  const browser = pinned(review.browser_plan_production_review),
    baseline = pinned(browser.production_pre_migration_baseline);
  validateProductionBrowserPlan(browser, baseline, {
    default_privileges: pinned(baseline.default_privileges),
    role_and_ownership: pinned(baseline.role_and_ownership),
  });
  assert.equal(review.browser_plan_production_accepted_file_sha256, BROWSER_PLAN_FILE);
  for (const key of ["bun_sha256", "timeout_sha256"])
    assert.match(review.execution_tools?.[key] ?? "", DIGEST);
  if (requireOuter)
    validateOuterProcessExecution({
      mode,
      executor,
      admissionSha,
      reviewSha,
      review,
      now,
      startPath: process.env.PIRATE_RELEASE_OUTER_START_PATH,
      journalDirectory: JOURNAL_DIR,
      wrapperPath: PACKAGE + "production-bounded-command.ts",
    });
  return { admission, review, admissionSha, reviewSha, now };
}
