/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { setupNetwork } from "@msw/cloudflare";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeAuthenticatedVideoWorkflowLookup } from "../../packages/platform-cf/src/video-workflow-status-api.ts";

const network = setupNetwork();
const access = {
  accountId: "a".repeat(32),
  workflowName: "video-fixture",
  scriptName: "media-fixture",
  readToken: "fixture-workflow-read-token",
};
const base = `https://api.cloudflare.com/client/v4/accounts/${access.accountId}/workflows/${access.workflowName}`;
const id = `vaw-${"b".repeat(64)}`;
const identity = "video-analysis:operation:v1:c1";

describe("video Workflow status through the real Workers fetch path", () => {
  beforeAll(() => network.enable());
  afterEach(() => network.resetHandlers());
  afterAll(() => network.disable());

  it("establishes absence using a real request and verified parent", async () => {
    const paths: string[] = [];
    network.use(
      http.get(`${base}*`, ({ request }) => {
        expect(request.redirect).toBe("manual");
        expect(request.headers.get("authorization")).toBe(`Bearer ${access.readToken}`);
        paths.push(request.url);
        return request.url.includes("/instances/")
          ? HttpResponse.json(
              { success: false, errors: [{ code: 10400, message: "missing" }] },
              { status: 404 },
            )
          : HttpResponse.json({
              success: true,
              result: {
                name: access.workflowName,
                script_name: access.scriptName,
                class_name: "VideoAnalysisWorkflow",
              },
            });
      }),
    );
    // No injected fetch: request construction and redirect handling run in workerd.
    const lookup = makeAuthenticatedVideoWorkflowLookup(access);
    await expect(lookup(id, identity)).resolves.toEqual({ state: "missing", status: null });
    expect(paths).toEqual([`${base}/instances/${id}?simple=true`, base]);
  });

  it("rejects redirects without following or forwarding the token", async () => {
    let followed = false;
    network.use(
      http.get(
        `${base}*`,
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { Location: "https://redirect-target.invalid/workflow" },
          }),
      ),
      http.get("https://redirect-target.invalid/workflow", () => {
        followed = true;
        return HttpResponse.json({ success: true });
      }),
    );
    await expect(makeAuthenticatedVideoWorkflowLookup(access)(id, identity)).rejects.toThrow(
      "did not establish absence",
    );
    expect(followed).toBe(false);
  });
});
