import { describe, expect, test } from "bun:test";
import {
  PROBE_SESSION,
  type ProbeState,
  parseSeedCommand,
  requireExactLedger,
  requireIdentity,
  requirePostSeedState,
  requirePreSeedState,
} from "./staging-hns-cutover-probe-seed.ts";

const empty: ProbeState = {
  sql_database: "postgres",
  session_user: "pscale_admin",
  current_user: "pscale_admin",
  cutover: [
    {
      services: ["pirate-hns-authority-provisioner-v2"],
      envelopes: ["hns-lifecycle-job-envelope-v1", "hns-root-observation-envelope-v1"],
    },
  ],
  lifecycle: [],
  jobs: [],
  identity_rows: 0,
};
const seededRow = { session: PROBE_SESSION, synthetic: true, phase: "checking_authority" };
const seededJob = {
  session: PROBE_SESSION,
  kind: "observe_readiness",
  state: "queued",
  generation: 1,
};
const seeded: ProbeState = { ...empty, lifecycle: [seededRow], jobs: [seededJob] };
const code = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return "admitted";
};

describe("staging cutover probe seed guards", () => {
  test("parses dry run and approved execute only", () => {
    expect(parseSeedCommand([])).toEqual({ execute: false, expected_admin_role: undefined });
    expect(parseSeedCommand(["--execute", "--expect-admin-role", "pscale_admin"]).execute).toBe(
      true,
    );
    expect(code(() => parseSeedCommand(["--execute"]))).toBe("admin_role_required");
    expect(code(() => parseSeedCommand(["--expect-admin-role", "x"]))).toBe(
      "admin_role_without_execute",
    );
    expect(
      code(() => parseSeedCommand(["--execute", "--execute", "--expect-admin-role", "x"])),
    ).toBe("execute_duplicate");
    expect(code(() => parseSeedCommand(["--execute", "--expect-admin-role", "Bad-Role"]))).toBe(
      "admin_role_invalid",
    );
    expect(code(() => parseSeedCommand(["--force"]))).toBe("option_invalid");
  });

  test("requires the exact pinned ledger", () => {
    const first = { version: "0001_a.sql", checksum: "a" };
    const pinned = [first, { version: "0002_b.sql", checksum: "b" }];
    expect(code(() => requireExactLedger(pinned, pinned))).toBe("admitted");
    expect(code(() => requireExactLedger(pinned.slice(0, 1), pinned))).toBe("ledger_length");
    expect(
      code(() => requireExactLedger([first, { version: "0002_c.sql", checksum: "b" }], pinned)),
    ).toBe("ledger_version");
    expect(
      code(() => requireExactLedger([first, { version: "0002_b.sql", checksum: "x" }], pinned)),
    ).toBe("ledger_checksum");
    expect(code(() => requireExactLedger([], []))).toBe("ledger_length");
  });

  test("requires the approved admin role on the staging database", () => {
    expect(code(() => requireIdentity(empty, "pscale_admin"))).toBe("admitted");
    expect(code(() => requireIdentity(empty, "pscale_other"))).toBe("admin_role_mismatch");
    expect(code(() => requireIdentity({ ...empty, sql_database: "other" }, "pscale_admin"))).toBe(
      "sql_database",
    );
    expect(code(() => requireIdentity({ ...empty, current_user: "x" }, "pscale_admin"))).toBe(
      "admin_role_mismatch",
    );
  });

  test("admits only the empty never-seeded state before mutation", () => {
    expect(code(() => requirePreSeedState(empty))).toBe("admitted");
    expect(code(() => requirePreSeedState(seeded))).toBe("lifecycle_not_empty");
    expect(code(() => requirePreSeedState({ ...empty, jobs: seeded.jobs }))).toBe(
      "lifecycle_jobs_not_empty",
    );
    expect(code(() => requirePreSeedState({ ...empty, identity_rows: 1 }))).toBe(
      "service_identity_present",
    );
    expect(code(() => requirePreSeedState({ ...empty, cutover: [] }))).toBe("cutover_pair");
    expect(
      code(() =>
        requirePreSeedState({ ...empty, cutover: [{ services: ["other"], envelopes: ["x"] }] }),
      ),
    ).toBe("cutover_pair");
  });

  test("asserts the exact synthetic row and single queued job after the call", () => {
    expect(code(() => requirePostSeedState(seeded))).toBe("admitted");
    expect(code(() => requirePostSeedState(empty))).toBe("post_lifecycle");
    expect(
      code(() =>
        requirePostSeedState({
          ...seeded,
          lifecycle: [{ ...seededRow, synthetic: false }],
        }),
      ),
    ).toBe("post_lifecycle");
    expect(
      code(() => requirePostSeedState({ ...seeded, jobs: [...seeded.jobs, ...seeded.jobs] })),
    ).toBe("post_job");
    expect(
      code(() => requirePostSeedState({ ...seeded, jobs: [{ ...seededJob, state: "leased" }] })),
    ).toBe("post_job");
    expect(code(() => requirePostSeedState({ ...seeded, identity_rows: 1 }))).toBe("post_identity");
  });
});
