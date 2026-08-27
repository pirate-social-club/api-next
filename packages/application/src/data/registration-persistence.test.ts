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

    expect(deterministicDataRegistrationWorkflowId(operationId, 2n)).toBe("drw-1315-post-1-1-r2");
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

  test("fits the Cloudflare Workflow identity boundary for a media post", () => {
    const workflowId = deterministicDataRegistrationWorkflowId(
      "data-registration:1315:media-post-media-operation-3b1c3738-4b12-4fbc-bd05-9827678ed85d:1",
      1n,
    );
    expect(workflowId).toBe(
      "drw-1315-media-post-media-operation-3b1c3738-4b12-4fbc-bd05-9827678ed85d-1-r1",
    );
    expect(workflowId.length).toBeLessThanOrEqual(100);
    expect(workflowId).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/u);
  });
});
