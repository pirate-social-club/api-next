import { expect, test } from "bun:test";
import {
  parseDataResumeRequest,
  runDataOperatorResume,
} from "./data-registration-operator-resume.ts";

const request = {
  registrationOperationId: "data-registration:1315:asset-1:1",
  idempotencyKey: "resume-1",
  evidenceRef: "review-1",
  reasonCode: "terms_evidence_unavailable" as const,
  expectedWorkflowRevision: 3,
};

test("operator identity cannot be supplied in the request", () => {
  expect(parseDataResumeRequest(request)).toEqual(request);
  expect(() => parseDataResumeRequest({ ...request, operatorPrincipalId: "admin" })).toThrow();
  expect(() => parseDataResumeRequest({ ...request, expectedWorkflowRevision: 0 })).toThrow();
  expect(() => parseDataResumeRequest({ ...request, expectedWorkflowRevision: 1.5 })).toThrow();
  expect(() => parseDataResumeRequest({ ...request, reasonCode: "unreviewed" })).toThrow();
  expect(() => parseDataResumeRequest({ ...request, evidenceRef: " " })).toThrow();
});

test("operator command refuses unknown or repeated execution flags before opening a database", async () => {
  await expect(runDataOperatorResume(["--execute"])).rejects.toThrow("usage");
  await expect(
    runDataOperatorResume(["--request", "unused", "--execute", "--execute"]),
  ).rejects.toThrow("usage");
  await expect(runDataOperatorResume(["--request", "unused", "--force"])).rejects.toThrow("usage");
});
