import { expect, test } from "bun:test";
import { assessRecoveryAdmission } from "./video-master-renderer-recovery-admission.ts";

const attempt = { attemptId: "attempt-a", generation: 2 };
const baseline = {
  attempt,
  state: "started" as const,
  stop: { ...attempt, kind: "confirmed" as const, receipt: "stop-2", writesDrained: true },
  output: { ...attempt, kind: "absent" as const, stopReceipt: "stop-2" },
};

test("lease expiry and empty listings cannot authorize replacement", () => {
  expect(assessRecoveryAdmission({ ...baseline, stop: { kind: "lease_expired" } })).toBe(
    "pending_termination",
  );
  expect(assessRecoveryAdmission({ ...baseline, output: { kind: "listing_empty" } })).toBe(
    "pending_output_resolution",
  );
});
test("stale or foreign termination receipts cannot stop this attempt", () => {
  for (const stop of [
    { ...baseline.stop, generation: 1 },
    { ...baseline.stop, attemptId: "attempt-b" },
    { ...baseline.stop, writesDrained: false },
    { ...baseline.stop, receipt: "" },
  ])
    expect(assessRecoveryAdmission({ ...baseline, stop })).toBe("pending_termination");
});
test("absence evidence must follow the matching stop and drained writes", () => {
  for (const output of [
    { ...baseline.output, stopReceipt: "stop-1" },
    { ...baseline.output, generation: 1 },
    { ...baseline.output, attemptId: "attempt-b" },
  ])
    expect(assessRecoveryAdmission({ ...baseline, output })).toBe("pending_output_resolution");
  expect(assessRecoveryAdmission(baseline)).toBe("eligible_for_atomic_abandonment");
});
test("existing output and sealed identities cannot be abandoned", () => {
  expect(assessRecoveryAdmission({ ...baseline, output: { kind: "present" } })).toBe(
    "pending_output_resolution",
  );
  for (const state of ["sealed", "accepted"] as const) {
    expect(assessRecoveryAdmission({ ...baseline, state })).toBe("integrity_recovery_only");
  }
});

const verifiedOutput = {
  ...attempt,
  kind: "verified_output" as const,
  objectIdentity: "immutable-attempt-a-output-v1",
  sha256: "a".repeat(64),
  byteLength: 1024,
  immutable: true,
  writeCompleted: true,
  integrityVerified: true,
  renderInputVerified: true,
  probeVerified: true,
};

test("verified completed output can recover without confirmed termination", () => {
  for (const stop of [{ kind: "unconfirmed" }, { kind: "lease_expired" }] as const) {
    expect(assessRecoveryAdmission({ ...baseline, stop, output: verifiedOutput })).toBe(
      "recover_existing_output",
    );
    expect(assessRecoveryAdmission({ ...baseline, stop, output: { kind: "present" } })).toBe(
      "pending_output_resolution",
    );
  }
});

test("foreign, partial, mutable, and unverified output remains unresolved", () => {
  for (const changes of [
    { attemptId: "attempt-b" },
    { generation: 1 },
    { objectIdentity: " " },
    { sha256: "invalid" },
    { byteLength: 0 },
    { byteLength: -1 },
    { byteLength: 1.5 },
    { byteLength: Number.NaN },
    { byteLength: Number.MAX_SAFE_INTEGER + 1 },
    { immutable: false },
    { writeCompleted: false },
    { integrityVerified: false },
    { renderInputVerified: false },
    { probeVerified: false },
  ]) {
    expect(
      assessRecoveryAdmission({
        ...baseline,
        output: { ...verifiedOutput, ...changes },
      }),
    ).toBe("pending_output_resolution");
  }
});

test("verified output never bypasses sealed or accepted integrity recovery", () => {
  for (const state of ["sealed", "accepted"] as const) {
    expect(assessRecoveryAdmission({ ...baseline, state, output: verifiedOutput })).toBe(
      "integrity_recovery_only",
    );
  }
});
