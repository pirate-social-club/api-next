import { describe, expect, test } from "bun:test";
import { validateResetEvidenceConsistency } from "./staging-persona-reset-evidence";
import { STAGING_RESET_RELEASE } from "./staging-persona-reset-plan";

const now = 1_800_000_000_000;
const digest = "a".repeat(64);
const snapshot = {
  ledger: digest,
  catalog: digest,
  data: digest,
  grants: digest,
  extensions: digest,
};
function evidence() {
  return {
    version: 1,
    disposition: "owner_authorized_disposable_staging",
    source_sha: STAGING_RESET_RELEASE.sourceSha,
    manifest_sha256: STAGING_RESET_RELEASE.manifestSha256,
    target: {
      environment: "staging",
      provider: "planetscale",
      database_name: "pirate-staging",
      project_id: "project-fixture",
      database_id: "database-fixture",
      branch_id: "source-fixture",
      sql_database: "postgres",
      schema: "api_next",
      hyperdrive_id: "8cb7658a0f7143359c1becfec6a15c23",
      connection_fingerprint: digest,
      admin_role_fingerprint: "b".repeat(64),
      runtime_role_fingerprints: [digest],
    },
    fence: {
      generation: "fence-fixture",
      started_at: now - 5000,
      observed_at: now - 100,
      valid_until: now + 1000,
      active_transactions: 0,
      active_runtime_sessions: 0,
      effective_runtime_denial: true,
      cross_schema_dependencies: 0,
      unresolved_dependencies: 0,
      workers: [
        "pirate-http-worker-staging",
        "pirate-jobs-worker-staging",
        "pirate-media-processor-worker-staging",
        "pirate-data-registration-worker-staging",
      ],
    },
    source: {
      fence_generation: "fence-fixture",
      observed_at: now - 100,
      snapshot,
      identity_row_count: 6,
    },
    recovery: {
      fence_generation: "fence-fixture",
      source_branch_id: "source-fixture",
      project_id: "project-fixture",
      capture_id: "capture-fixture",
      restore_point_id: "point-fixture",
      database_id: "database-fixture",
      branch_id: "recovery-fixture",
      captured_at: now - 4000,
      verified_at: now - 3000,
      retained: true,
      snapshot,
      identity_row_count: 6,
    },
    rehearsal: {
      recovery_branch_id: "recovery-fixture",
      database_id: "database-fixture",
      project_id: "project-fixture",
      capture_id: "capture-fixture",
      restore_point_id: "point-fixture",
      branch_id: "rehearsal-fixture",
      completed_at: now - 2000,
      connection_switch_verified: true,
      snapshot,
      representative_invariants_verified: true,
      identity_row_count: 6,
    },
  };
}

describe("reset evidence consistency, never reset authority", () => {
  test("accepts matching isolated recovery observations but requires live rechecks", () => {
    expect(validateResetEvidenceConsistency(evidence(), now)).toEqual({
      consistency: "passed",
      live_recheck_required: true,
      execution_authorized: false,
    });
  });
  test("rejects missing, extra, or sensitive fields without echoing them", () => {
    const invalid = { ...evidence(), secret: "do-not-echo" };
    expect(() => validateResetEvidenceConsistency(invalid, now)).toThrow("invalid_evidence");
    try {
      validateResetEvidenceConsistency(invalid, now);
    } catch (error) {
      expect(String(error)).not.toContain("do-not-echo");
    }
    expect(() => validateResetEvidenceConsistency(null, now)).toThrow("invalid_evidence");
    const { recovery: _removed, ...missing } = evidence();
    expect(() => validateResetEvidenceConsistency(missing, now)).toThrow("invalid_evidence");
  });
  test("refuses production and mismatched release pins", () => {
    const input = evidence();
    input.target.environment = "production";
    expect(() => validateResetEvidenceConsistency(input, now)).toThrow("invalid_evidence");
    expect(() =>
      validateResetEvidenceConsistency({ ...evidence(), source_sha: "b".repeat(40) }, now),
    ).toThrow("release_mismatch");
  });
  test("requires the complete exact writer closure without duplicates", () => {
    for (const workers of [
      [],
      evidence().fence.workers.slice(1),
      [...evidence().fence.workers, "unexpected-worker"],
      Array(4).fill("pirate-http-worker-staging"),
    ]) {
      const input = evidence();
      input.fence.workers = workers;
      expect(() => validateResetEvidenceConsistency(input, now)).toThrow("writer_closure");
    }
  });
  test("refuses ineffective denial, active sessions and dependency uncertainty", () => {
    for (const patch of [
      { effective_runtime_denial: false },
      { active_transactions: 1 },
      { active_runtime_sessions: 1 },
      { cross_schema_dependencies: 1 },
      { unresolved_dependencies: 1 },
    ]) {
      const input = evidence();
      Object.assign(input.fence, patch);
      expect(() => validateResetEvidenceConsistency(input, now)).toThrow("unsafe_fence");
    }
  });
  test("requires recovery capture after fencing and a continuously matching generation", () => {
    const early = evidence();
    early.recovery.captured_at = early.fence.started_at - 1;
    expect(() => validateResetEvidenceConsistency(early, now)).toThrow("evidence_order");
    const broken = evidence();
    broken.source.fence_generation = "different";
    expect(() => validateResetEvidenceConsistency(broken, now)).toThrow("fence_generation");
  });
  test("refuses future, expired, stale, and overlong observation windows", () => {
    for (const patch of [
      { observed_at: now + 1 },
      { valid_until: now },
      { observed_at: now - 300001 },
      { valid_until: now + 300001 },
    ]) {
      const input = evidence();
      Object.assign(input.fence, patch);
      expect(() => validateResetEvidenceConsistency(input, now)).toThrow();
    }
    expect(() => validateResetEvidenceConsistency(evidence(), Number.NaN)).toThrow("invalid_clock");
  });
  test("rejects a same-target rehearsal or unrelated recovery source", () => {
    const input = evidence();
    input.rehearsal.branch_id = input.target.branch_id;
    expect(() => validateResetEvidenceConsistency(input, now)).toThrow("recovery_identity");
    const wrong = evidence();
    wrong.recovery.database_id = "different-database";
    expect(() => validateResetEvidenceConsistency(wrong, now)).toThrow("recovery_identity");
    const unrelated = evidence();
    unrelated.recovery.source_branch_id = "unrelated-source";
    expect(() => validateResetEvidenceConsistency(unrelated, now)).toThrow("recovery_identity");
  });
  test("rejects stale source data or a restore omitting any snapshot dimension", () => {
    for (const key of ["ledger", "catalog", "data", "grants", "extensions"] as const) {
      const input = evidence();
      input.rehearsal.snapshot = { ...snapshot, [key]: "b".repeat(64) };
      expect(() => validateResetEvidenceConsistency(input, now)).toThrow("snapshot_mismatch");
    }
    const drift = evidence();
    drift.source.snapshot = { ...snapshot, data: "c".repeat(64) };
    expect(() => validateResetEvidenceConsistency(drift, now)).toThrow("snapshot_mismatch");
  });
  test("requires retention and a tested connection-switch recovery path", () => {
    const input = evidence();
    input.recovery.retained = false;
    expect(() => validateResetEvidenceConsistency(input, now)).toThrow("recovery_unproven");
    const switchMissing = evidence();
    switchMissing.rehearsal.connection_switch_verified = false;
    expect(() => validateResetEvidenceConsistency(switchMissing, now)).toThrow("recovery_unproven");
  });
  test("refuses an empty rebuild presented as data-bearing recovery", () => {
    const input = evidence();
    input.source.identity_row_count = 0;
    input.recovery.identity_row_count = 0;
    input.rehearsal.identity_row_count = 0;
    expect(() => validateResetEvidenceConsistency(input, now)).toThrow("recovery_unproven");
  });
  test("requires the exact capture and restore point, not just the recovery branch", () => {
    const input = evidence();
    input.rehearsal.capture_id = "another-capture";
    expect(() => validateResetEvidenceConsistency(input, now)).toThrow("recovery_identity");
    const point = evidence();
    point.rehearsal.restore_point_id = "another-point";
    expect(() => validateResetEvidenceConsistency(point, now)).toThrow("recovery_identity");
  });
  test("refuses missing runtime roles or sharing the admin identity", () => {
    const input = evidence();
    input.target.runtime_role_fingerprints = [];
    expect(() => validateResetEvidenceConsistency(input, now)).toThrow("runtime_roles");
    const shared = evidence();
    shared.target.runtime_role_fingerprints = [shared.target.admin_role_fingerprint];
    expect(() => validateResetEvidenceConsistency(shared, now)).toThrow("runtime_roles");
  });
});
