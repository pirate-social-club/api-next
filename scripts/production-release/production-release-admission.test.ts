import { expect, test } from "bun:test";
import { API_APP_SOURCE, WEBSITE_SOURCE } from "./production-release-paths.ts";
import { validateAdmissionWindow, validateCurrentRecoveryReadiness, validateProductionBrowserPlan, validateRecoveryQualification } from "./production-release-admission.ts";

const digest = "a".repeat(64), branch = "mqfaju65wdm3";
const acceptance = () => ({ accepted: true, reviewer_role: "independent_reviewer", findings: [] });
function fixture(now: number) {
  const proof = { environment: "staging", api_source: API_APP_SOURCE, website_source: WEBSITE_SOURCE };
  const proofs = Object.fromEntries(["issue", "renew", "acknowledged_logout", "installed_identity", "ordinary_host_recovery"].map(key => [key, { ...proof }]));
  const recovery = { ...acceptance(), kind: "ordinary-website-auth-capable-recovery-v1", api_source: API_APP_SOURCE, website_source: WEBSITE_SOURCE,
    observed_at: new Date(now - 7 * 86400_000).toISOString(), session_schema_floor: 333, hns_required: false, auth_capable: true,
    qualification_environment: "staging", target_environment: "production", target_branch: branch,
    target_ordinary_origin: "https://pirate.sc", recovery_artifact_identity_sha256: digest };
  const identity = { environment: "production", branch, ordinary_origin: "https://pirate.sc", observed_at: new Date(now).toISOString() };
  const readiness = { kind: "ordinary-website-recovery-current-readiness-v1", environment: "production", branch,
    ordinary_origin: "https://pirate.sc", recovery_review_sha256: digest, target_api_source: API_APP_SOURCE, target_website_source: WEBSITE_SOURCE,
    current_database_ledger_count: 275, current_serving_identity: { sha256: digest }, current_serving_identity_sha256: digest,
    recovery_artifact_identity_sha256: digest, available: true, observed_at: new Date(now).toISOString() };
  const browser = { ...acceptance(), source: API_APP_SOURCE, branch,
    production_accepted_file_sha256: "deb332e0543461e0b5b90b4196de30a7f5779a32a7629ea7382ac892bed6af9e",
    fixture_only_flags_superseded_for_exact_bytes: true, pre_migration_baseline_accepted_for_exact_plan: true };
  const baseline = { kind: "production-browser-plan-baseline-v1", environment: "production", branch, api_source: API_APP_SOURCE,
    runtime_role: "pscale_api_4bxas7gq43a4", ledger_count: 275, schema: "api_next", default_privileges_sha256: digest,
    role_and_ownership_sha256: digest, default_privileges: { sha256: digest }, role_and_ownership: { sha256: digest } };
  const receipts = { default_privileges: { environment: "production", branch, ledger_count: 275 }, role_and_ownership: { environment: "production", branch, ledger_count: 275 } };
  const admission = { kind: "qualified-rewards-off-website-v1-recovery", resource_owner_role: "website_launch_coordinator",
    api_source: API_APP_SOURCE, website_source: WEBSITE_SOURCE, starts_at: new Date(now - 1_000).toISOString(), expires_at: new Date(now + 3_600_000).toISOString(),
    phone_acceptance_sha256: digest, disclosure_sha256: digest, public_legal_source_sha256: digest };
  return { proofs, recovery, identity, readiness, browser, baseline, receipts, admission };
}

test("ledger275 general admission does not require nonexistent333 functions or pregrant state", () => {
  const now = Date.now(), f = fixture(now);
  validateAdmissionWindow(f.admission, now);
  validateProductionBrowserPlan(f.browser, f.baseline, f.receipts);
  validateRecoveryQualification(f.recovery, f.proofs);
  validateCurrentRecoveryReadiness(f.recovery, f.readiness, f.identity, digest, now);
  expect("pre_guards_satisfied" in f.baseline).toBe(false);
});

test("postgrant renewal after five minutes reuses accepted journeys and275 baseline", () => {
  const before = Date.now(), f = fixture(before), now = before + 6 * 60_000;
  const initialBrowser = JSON.stringify([f.browser, f.baseline, f.receipts, f.recovery, f.proofs]);
  f.admission.starts_at = new Date(now - 1_000).toISOString(); f.admission.expires_at = new Date(now + 3_600_000).toISOString();
  f.readiness.current_database_ledger_count = 333; f.readiness.observed_at = new Date(now).toISOString(); f.identity.observed_at = new Date(now).toISOString();
  validateAdmissionWindow(f.admission, now); validateProductionBrowserPlan(f.browser, f.baseline, f.receipts);
  validateRecoveryQualification(f.recovery, f.proofs); validateCurrentRecoveryReadiness(f.recovery, f.readiness, f.identity, digest, now);
  expect(JSON.stringify([f.browser, f.baseline, f.receipts, f.recovery, f.proofs])).toBe(initialBrowser);
});

test("stale current identity refuses without expiring the accepted recovery journey", () => {
  const now = Date.now(), f = fixture(now);
  validateRecoveryQualification(f.recovery, f.proofs);
  f.identity.observed_at = new Date(now - 300_001).toISOString();
  expect(() => validateCurrentRecoveryReadiness(f.recovery, f.readiness, f.identity, digest, now)).toThrow();
});

for (const mutation of [
  (f: ReturnType<typeof fixture>) => { f.readiness.branch = "other"; },
  (f: ReturnType<typeof fixture>) => { f.readiness.ordinary_origin = "https://other.invalid"; },
  (f: ReturnType<typeof fixture>) => { f.readiness.target_api_source = "0".repeat(40); },
  (f: ReturnType<typeof fixture>) => { f.identity.environment = "staging"; },
  (f: ReturnType<typeof fixture>) => { f.readiness.recovery_review_sha256 = "0".repeat(64); },
]) test("wrong current readiness identity refuses: " + mutation.toString(), () => {
  const now = Date.now(), f = fixture(now); mutation(f);
  expect(() => validateCurrentRecoveryReadiness(f.recovery, f.readiness, f.identity, digest, now)).toThrow();
});

test("mixed recovery environments and absent exact plan acceptance refuse", () => {
  const f = fixture(Date.now()); f.proofs.issue = { environment: "local-qualified", api_source: API_APP_SOURCE, website_source: WEBSITE_SOURCE };
  expect(() => validateRecoveryQualification(f.recovery, f.proofs)).toThrow();
  f.browser.fixture_only_flags_superseded_for_exact_bytes = false;
  expect(() => validateProductionBrowserPlan(f.browser, f.baseline, f.receipts)).toThrow();
});

test("future, expired and overlong admission windows refuse", () => {
  const now = Date.now();
  for (const [start, end] of [[now + 1, now + 3_600_000], [now - 3_600_000, now], [now, now + 10_800_001]]) {
    const f = fixture(now); f.admission.starts_at = new Date(start as number).toISOString(); f.admission.expires_at = new Date(end as number).toISOString();
    expect(() => validateAdmissionWindow(f.admission, now)).toThrow();
  }
});
