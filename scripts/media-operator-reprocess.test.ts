import { expect, test } from "bun:test";
import { parseReprocessRequest, runOperatorReprocess } from "./media-operator-reprocess.ts";

const request = {
  communityId: "community",
  submissionId: "submission",
  actorUserId: "song-owner",
  idempotencyKey: "reprocess-1",
  evidenceRef: "review-1",
  expectedCreationRevision: 2,
  expectedWorkflowRevision: 3,
};

test("operator identity cannot be supplied in the request", () => {
  expect(parseReprocessRequest(request)).toEqual(request);
  expect(() => parseReprocessRequest({ ...request, operatorPrincipalId: "admin" })).toThrow();
  expect(() => parseReprocessRequest({ ...request, expectedWorkflowRevision: 0 })).toThrow();
  expect(() => parseReprocessRequest({ ...request, expectedCreationRevision: 1.5 })).toThrow();
  expect(() => parseReprocessRequest({ ...request, evidenceRef: " " })).toThrow();
});

test("operator command refuses unknown or repeated execution flags before opening a database", async () => {
  await expect(runOperatorReprocess(["--execute"])).rejects.toThrow("usage");
  await expect(
    runOperatorReprocess(["--request", "unused", "--execute", "--execute"]),
  ).rejects.toThrow("usage");
  await expect(runOperatorReprocess(["--request", "unused", "--force"])).rejects.toThrow("usage");
});
