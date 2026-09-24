import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  parseReseedCommand,
  type ReseedState,
  requirePostReseedState,
  requirePreReseedState,
  requireReviewedRelease,
} from "./staging-hns-cutover-probe-reseed.ts";
import { PROBE_SESSION } from "./staging-hns-cutover-probe-seed.ts";

const code = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return "admitted";
};

const bundle = new TextEncoder().encode("bundle bytes");
const bundleSha = createHash("sha256").update(bundle).digest("hex");
const manifest = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    bundle_sha256: bundleSha,
    service_version: "pirate-hns-authority-provisioner-v2",
    job_envelope_version: "hns-lifecycle-job-envelope-v1",
    executor_id: "pirate-hns-staging-provisioner-1",
    attempt_id: "staging-new-attempt-20260925",
    ...overrides,
  });
const release = { bundle_sha256: bundleSha, attempt_id: "staging-new-attempt-20260925" };
const FAILED = "staging-41810c3f-20260924T194545Z";

const probeRow = {
  session: PROBE_SESSION,
  synthetic: true,
  phase: "checking_authority",
  generation: 1,
  revision: 1,
};
const failedIdentity = {
  service_version: "pirate-hns-authority-provisioner-v2",
  attempt_id: FAILED,
  probe_outcome: "failed",
  probe_reason: "attempt_mismatch" as string | null,
};

const seededBefore: ReseedState = {
  sql_database: "postgres",
  session_user: "pscale_admin",
  current_user: "pscale_admin",
  cutover: [
    {
      services: ["pirate-hns-authority-provisioner-v2"],
      envelopes: ["hns-lifecycle-job-envelope-v1", "hns-root-observation-envelope-v1"],
    },
  ],
  probe_lifecycle: [
    {
      session: PROBE_SESSION,
      synthetic: true,
      phase: "checking_authority",
      generation: 1,
      revision: 1,
    },
  ],
  probe_jobs: [{ job_id: 1, kind: "observe_readiness", state: "completed", generation: 1 }],
  identity: [
    {
      service_version: "pirate-hns-authority-provisioner-v2",
      attempt_id: FAILED,
      probe_outcome: "failed",
      probe_reason: "attempt_mismatch",
    },
  ],
};
const withIdentity = (identity: Partial<ReseedState["identity"][number]>): ReseedState => ({
  ...seededBefore,
  identity: [{ ...failedIdentity, ...identity }],
});
const afterSeed = (
  jobs: ReseedState["probe_jobs"] = [
    ...seededBefore.probe_jobs,
    { job_id: 7, kind: "observe_readiness", state: "queued", generation: 1 },
  ],
): ReseedState => ({ ...seededBefore, probe_jobs: jobs });

describe("staging cutover probe re-seed command", () => {
  test("requires an absolute manifest and an admin role only with execute", () => {
    expect(code(() => parseReseedCommand([]))).toBe("manifest_required");
    expect(code(() => parseReseedCommand(["--manifest", "relative.json"]))).toBe(
      "manifest_invalid",
    );
    expect(code(() => parseReseedCommand(["--manifest", "/m.json", "--execute"]))).toBe(
      "admin_role_required",
    );
    expect(
      code(() =>
        parseReseedCommand(["--manifest", "/m.json", "--expect-admin-role", "pscale_admin"]),
      ),
    ).toBe("admin_role_without_execute");
    expect(
      code(() => parseReseedCommand(["--manifest", "/m.json", "--reconcile-failed-attempt", "x"])),
    ).toBe("reconcile_invalid");
    expect(
      parseReseedCommand([
        "--manifest",
        "/m.json",
        "--reconcile-failed-attempt",
        FAILED,
        "--execute",
        "--expect-admin-role",
        "pscale_admin",
      ]),
    ).toEqual({
      manifest_path: "/m.json",
      reconcile_failed_attempt: FAILED,
      execute: true,
      expected_admin_role: "pscale_admin",
    });
  });

  test("binds the reviewed manifest to the exact bundle bytes", () => {
    expect(requireReviewedRelease(manifest(), bundle)).toEqual(release);
    expect(code(() => requireReviewedRelease(manifest(), new TextEncoder().encode("other")))).toBe(
      "bundle_digest_mismatch",
    );
    expect(code(() => requireReviewedRelease(manifest({ service_version: "v1" }), bundle))).toBe(
      "manifest_shape",
    );
    expect(code(() => requireReviewedRelease("not json", bundle))).toBe("manifest_unreadable");
  });
});

describe("staging cutover probe re-seed pre-state", () => {
  test("admits the named failed attempt whose only fault was the attempt mismatch", () => {
    expect(code(() => requirePreReseedState(seededBefore, release, FAILED))).toBe("admitted");
    expect(code(() => requirePreReseedState(seededBefore, release, undefined))).toBe(
      "failed_attempt_unacknowledged",
    );
    expect(
      code(() => requirePreReseedState(seededBefore, release, "staging-some-other-attempt")),
    ).toBe("failed_attempt_unacknowledged");
  });

  test("admits a previous completed attempt without a reconcile flag", () => {
    const ready = withIdentity({
      attempt_id: "staging-53673b1b-20260923",
      probe_outcome: "ready",
      probe_reason: null,
    });
    expect(code(() => requirePreReseedState(ready, release, undefined))).toBe("admitted");
    expect(code(() => requirePreReseedState(ready, release, FAILED))).toBe("reconcile_not_needed");
  });

  test("refuses a reused attempt, competing or leased probes and unexplained shapes", () => {
    expect(
      code(() =>
        requirePreReseedState(
          withIdentity({ attempt_id: release.attempt_id }),
          release,
          release.attempt_id,
        ),
      ),
    ).toBe("attempt_not_fresh");
    for (const state of ["queued", "leased"]) {
      const competing = {
        ...seededBefore,
        probe_jobs: [
          ...seededBefore.probe_jobs,
          { job_id: 2, kind: "observe_readiness", state, generation: 1 },
        ],
      };
      expect(code(() => requirePreReseedState(competing, release, FAILED))).toBe(
        "probe_job_competing",
      );
    }
    expect(
      code(() => requirePreReseedState({ ...seededBefore, probe_jobs: [] }, release, FAILED)),
    ).toBe("probe_never_seeded");
    expect(
      code(() => requirePreReseedState({ ...seededBefore, identity: [] }, release, FAILED)),
    ).toBe("service_identity_unexpected");
    expect(
      code(() =>
        requirePreReseedState(
          withIdentity({ probe_outcome: "lease_conflict", probe_reason: "x" }),
          release,
          FAILED,
        ),
      ),
    ).toBe("identity_unreconcilable");
    expect(
      code(() =>
        requirePreReseedState(
          withIdentity({ probe_outcome: "failed", probe_reason: "artifact_mismatch" }),
          release,
          FAILED,
        ),
      ),
    ).toBe("identity_unreconcilable");
    expect(
      code(() =>
        requirePreReseedState(
          {
            ...seededBefore,
            probe_lifecycle: [{ ...probeRow, generation: 2 }],
          },
          release,
          FAILED,
        ),
      ),
    ).toBe("probe_lifecycle_unexpected");
    expect(
      code(() => requirePreReseedState({ ...seededBefore, cutover: [] }, release, FAILED)),
    ).toBe("cutover_pair");
  });
});

describe("staging cutover probe re-seed post-state", () => {
  test("admits exactly one fresh queued probe job with everything else unchanged", () => {
    expect(code(() => requirePostReseedState(seededBefore, afterSeed()))).toBe("admitted");
  });

  test("refuses missing, duplicate or altered jobs and any identity or lifecycle change", () => {
    expect(
      code(() => requirePostReseedState(seededBefore, afterSeed(seededBefore.probe_jobs))),
    ).toBe("post_job");
    expect(
      code(() =>
        requirePostReseedState(
          seededBefore,
          afterSeed([
            ...seededBefore.probe_jobs,
            { job_id: 7, kind: "observe_readiness", state: "queued", generation: 1 },
            { job_id: 8, kind: "observe_readiness", state: "queued", generation: 1 },
          ]),
        ),
      ),
    ).toBe("post_job");
    expect(
      code(() =>
        requirePostReseedState(
          seededBefore,
          afterSeed([
            { job_id: 1, kind: "observe_readiness", state: "failed", generation: 1 },
            { job_id: 7, kind: "observe_readiness", state: "queued", generation: 1 },
          ]),
        ),
      ),
    ).toBe("post_prior_jobs_changed");
    expect(
      code(() =>
        requirePostReseedState(seededBefore, {
          ...afterSeed(),
          identity: withIdentity({ probe_outcome: "ready" }).identity,
        }),
      ),
    ).toBe("post_identity_changed");
    expect(
      code(() =>
        requirePostReseedState(seededBefore, {
          ...afterSeed(),
          probe_lifecycle: [{ ...probeRow, revision: 2 }],
        }),
      ),
    ).toBe("post_lifecycle_changed");
  });
});
