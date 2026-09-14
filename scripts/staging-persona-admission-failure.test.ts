import { expect, test } from "bun:test";
import {
  ADMISSION_STAGES,
  type AdmissionStage,
  admissionRefusal,
  withResetAdmissionReporting,
} from "./staging-persona-prepare-reset.ts";
import {
  describeRehearsalFailure,
  StructuredRefusal,
} from "./staging-persona-rehearsal-failure.ts";
import { providerRehearsalRefusal } from "./staging-persona-rehearsal-inventory.ts";

test("a pre-admission failure is named with its stage and keeps the cause internal", () => {
  const cause = new Error("connection detail that must not be logged");
  const refusal = admissionRefusal(cause, "fence_recovery");
  expect(refusal.message).toBe("reset_admission_unproven:fence_recovery");
  expect(refusal.category).toBeNull();
  expect(refusal.sqlstate).toBeNull();
  expect((refusal as { cause?: unknown }).cause).toBe(cause);
  expect(refusal.message).not.toContain("connection detail");
});

test("a timeout in the admission window carries the timeout category", () => {
  const refusal = admissionRefusal(
    Object.assign(new Error("idle"), { code: "ETIMEDOUT" }),
    "connection",
  );
  expect(refusal.message).toBe("reset_admission_unproven:connection");
  expect(refusal.category).toBe("timeout");
});

test("a cancellation-shaped error is named and an existing refusal passes through", () => {
  const aborted = admissionRefusal(
    Object.assign(new Error("aborted"), { name: "AbortError" }),
    "fence_recovery",
  );
  expect(aborted.message).toBe("reset_admission_unproven:fence_recovery");
  const gateRefusal = new StructuredRefusal("reset_preparation_gate_failed:denial", {
    category: "timeout",
  });
  expect(admissionRefusal(gateRefusal, "marker")).toBe(gateRefusal);
});

test("every admission stage stays inside the redaction allowlist", () => {
  for (const stage of ADMISSION_STAGES) {
    const refusal = admissionRefusal(new Error("internal cause"), stage as AdmissionStage);
    const described = describeRehearsalFailure(refusal);
    expect(described.reason).toBe(`reset_admission_unproven:${stage}`);
    expect(described.sqlstate).toBeNull();
  }
});

test("the wrapper flattening is reproduced, and the boundary fixes it", () => {
  // The r13 shape: an unallowlisted admission error reaches the operator
  // wrapper directly, which replaces it with its own phase failure and drops
  // the reason.
  const flattened = providerRehearsalRefusal(
    new Error("unallowlisted internal failure"),
    "operation",
  );
  expect(flattened.message).toBe("provider_rehearsal_unproven:operation");
  expect(describeRehearsalFailure(flattened).reason).toBe("provider_rehearsal_unproven:operation");

  // With the admission boundary the wrapper preserves the named stage; the
  // internal cause is carried, not printed.
  const preserved = providerRehearsalRefusal(
    admissionRefusal(new Error("unallowlisted internal failure"), "grants"),
    "operation",
  );
  expect(preserved.message).toBe("reset_admission_unproven:grants");
  expect(describeRehearsalFailure(preserved).reason).toBe("reset_admission_unproven:grants");
  expect(preserved.message).not.toContain("unallowlisted internal failure");
});

test("the boundary does not replace an already structured timeout refusal", () => {
  const timeout = new StructuredRefusal("reset_preparation_gate_failed:reset", {
    category: "timeout",
  });
  const wrapped = admissionRefusal(timeout, "marker");
  expect(wrapped).toBe(timeout);
  expect(describeRehearsalFailure(wrapped).category).toBe("timeout");
});

test("the reporting boundary wraps pre-batch failures and preserves later failures", async () => {
  const internal = new Error("unlisted provider detail");
  const before = await withResetAdmissionReporting(async (observe) => {
    observe("first_batch");
    throw internal;
  }).catch((error: unknown) => error);
  expect(before).toBeInstanceOf(StructuredRefusal);
  expect((before as Error).message).toBe("reset_admission_unproven:first_batch");
  expect((before as { cause?: unknown }).cause).toBe(internal);

  const after = await withResetAdmissionReporting(async (observe) => {
    observe("admitted");
    throw internal;
  }).catch((error: unknown) => error);
  expect(after).toBe(internal);
});
