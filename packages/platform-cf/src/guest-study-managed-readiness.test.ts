import { expect, test } from "bun:test";
import {
  ControlPlaneAcquireFailed,
  ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneOperationTimedOut,
  ControlPlaneStatementFailed,
  ControlPlaneTransactionOutcomeUnknown,
} from "@pirate/application";
import { Effect, Layer } from "effect";
import { makeGuestStudyManagedReadiness } from "./guest-study-managed-readiness.ts";

const inspectFailure = async (failure: ControlPlaneError) => {
  const execute: ControlPlaneDb["Service"]["execute"] = () => Effect.fail(failure);
  const runtime = Layer.succeed(ControlPlaneDb, {
    execute,
    withTransaction: (use) => use({ execute }),
  });
  const bucket = { put: async () => {}, delete: async () => {} };
  const inspector = makeGuestStudyManagedReadiness({
    learning: runtime,
    publicRead: runtime,
    cron: runtime,
    observer: runtime,
    schema: "api_next",
    workerLearnerAudioBinding: bucket,
    selectedLearnerAudioBinding: bucket,
  });
  try {
    await inspector.verify();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "GuestStudyManagedReadinessRefused",
      message: "Managed Guest Study readiness unavailable",
    });
    return error;
  }
  throw new Error("A failed readiness inspection must refuse serving");
};

test("readiness preserves a failed statement's safe operation and SQL classification", async () => {
  const error = await inspectFailure(
    new ControlPlaneStatementFailed({
      label: "guest-readiness.observer.acl",
      sqlState: "57014",
      constraint: "private-constraint",
      outcomeCertainty: "completed",
    }),
  );
  expect(error).toMatchObject({
    reason: "ControlPlaneStatementFailed",
    operation: "guest-readiness.observer.acl",
    sqlState: "57014",
  });
  expect(JSON.stringify(error)).not.toContain("private-constraint");
  expect(error).not.toHaveProperty("cause");
});

test("readiness never forwards arbitrary labels or malformed SQL classifications", async () => {
  const error = await inspectFailure(
    new ControlPlaneStatementFailed({
      label: "postgres://private-connection",
      sqlState: "private-value",
      constraint: "private-constraint",
      outcomeCertainty: "unknown",
    }),
  );
  expect(error).toMatchObject({
    reason: "ControlPlaneStatementFailed",
    operation: null,
    sqlState: null,
  });
  expect(JSON.stringify(error)).not.toContain("private");
});

test("readiness distinguishes a bounded operation timeout from a policy refusal", async () => {
  const error = await inspectFailure(
    new ControlPlaneOperationTimedOut({
      label: "learner-audio.limits.set",
      limitMs: 2000,
      elapsedMs: 2001,
      outcomeCertainty: "unknown",
    }),
  );
  expect(error).toMatchObject({
    reason: "ControlPlaneOperationTimedOut",
    operation: "learner-audio.limits.set",
    sqlState: null,
  });
});

test("readiness identifies connection and transaction failures without driver details", async () => {
  for (const failure of [
    new ControlPlaneAcquireFailed({ phase: "connection", limitMs: 3000, elapsedMs: 3001 }),
    new ControlPlaneTransactionOutcomeUnknown({
      phase: "rollback",
      label: "private-label",
      limitMs: 2000,
      elapsedMs: 2001,
    }),
  ]) {
    const error = await inspectFailure(failure);
    expect(error).toMatchObject({ reason: failure._tag, operation: failure.phase, sqlState: null });
    expect(JSON.stringify(error)).not.toContain("private-label");
  }
});
