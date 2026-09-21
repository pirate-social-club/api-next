import { expect, test } from "bun:test";
import {
  parseDataAdditionalAttemptRequest,
  runDataOperatorAdditionalAttempt,
} from "./data-registration-operator-additional-attempt.ts";

const request = {
  registrationOperationId: "data-registration:1315:asset-1:1",
  idempotencyKey: "additional-attempt-1",
  evidenceRef: "review-1",
  reasonCode: "explicit_additional_workflow_attempt",
  reviewedWorkflowDisposition: "finished",
  expectedWorkflowRevision: 4,
};
test("additional attempt request is exact and excludes operator identity", () => {
  expect(parseDataAdditionalAttemptRequest(request)).toEqual(request);
  for (const invalid of [
    { ...request, operatorPrincipalId: "admin" },
    { ...request, expectedWorkflowRevision: 3 },
    { ...request, expectedWorkflowRevision: 4.5 },
    { ...request, reasonCode: "unreviewed" },
    { ...request, reviewedWorkflowDisposition: "present" },
    { ...request, evidenceRef: " " },
    { ...request, evidenceRef: "bad\0ref" },
  ])
    expect(() => parseDataAdditionalAttemptRequest(invalid)).toThrow("invalid_request");
});
test("execution requires an explicit terminal assertion before any access", async () => {
  for (const args of [
    ["--execute"],
    ["--request", "unused", "--execute"],
    ["--request", "unused", "--execute", "--assert-reviewed-terminal", "--force"],
    ["--request", "unused", "--force"],
  ])
    await expect(runDataOperatorAdditionalAttempt(args)).rejects.toThrow("usage");
});
