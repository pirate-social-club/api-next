import { describe, expect, test } from "bun:test";

import {
  DATA_REGISTRATION_PERSISTENCE_VERSION,
  deterministicDataRegistrationArtifactId,
  deterministicDataRegistrationAttemptId,
  deterministicDataRegistrationOperationId,
  deterministicDataRegistrationOutboxId,
  deterministicDataRegistrationReceiptId,
  deterministicDataRegistrationSigningIntentId,
  deterministicDataRegistrationTransitionId,
  deterministicDataRegistrationWorkflowId,
} from "./registration-persistence";

describe("DATA registration persistence identities", () => {
  test("binds the logical operation only to chain, asset, and registration revision", () => {
    expect(DATA_REGISTRATION_PERSISTENCE_VERSION).toBe("data-registration-persistence-v1");
    expect(deterministicDataRegistrationOperationId(1315n, "media-post-operation-1", 2n)).toBe(
      "data-registration:1315:media-post-operation-1:2",
    );
  });

  test("derives durable child identities from the persisted operation", () => {
    const operationId = deterministicDataRegistrationOperationId(1315n, "post-1", 1n);
    const attemptId = deterministicDataRegistrationAttemptId(operationId, 3);

    expect(deterministicDataRegistrationWorkflowId(operationId, 2n)).toBe(
      `data-registration-workflow:${operationId}:r2`,
    );
    expect(deterministicDataRegistrationOutboxId(operationId, 2n)).toBe(`${operationId}:outbox:r2`);
    expect(deterministicDataRegistrationArtifactId(operationId, "ip_metadata")).toBe(
      `${operationId}:artifact:ip_metadata`,
    );
    expect(attemptId).toBe(`${operationId}:attempt:3`);
    expect(deterministicDataRegistrationSigningIntentId(attemptId)).toBe(
      `${attemptId}:signing-intent`,
    );
    expect(deterministicDataRegistrationTransitionId(attemptId, 4n)).toBe(
      `${attemptId}:transition:4`,
    );
    expect(deterministicDataRegistrationReceiptId(attemptId, 5n)).toBe(`${attemptId}:receipt:5`);
  });
});
