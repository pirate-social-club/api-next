import { expect, test } from "bun:test";
import { makeAuthenticatedVideoWorkflowLookup } from "./video-workflow-status-api.ts";

const access = {
  accountId: "a".repeat(32),
  workflowName: "video-fixture",
  scriptName: "media-fixture",
  readToken: "fixture-workflow-read-token",
};
const id = `vaw-${"b".repeat(64)}`;
const identity = "video-analysis:operation:v1:c1";
const parent = {
  success: true,
  result: {
    name: access.workflowName,
    script_name: access.scriptName,
    class_name: "VideoAnalysisWorkflow",
  },
};
const missing = { success: false, errors: [{ code: 10400, message: "instance missing" }] };

test("authenticated absence requires a structured 404 and the exact existing parent", async () => {
  const urls: string[] = [];
  const lookup = makeAuthenticatedVideoWorkflowLookup(access, async (input, init) => {
    const url = String(input);
    urls.push(url);
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${access.readToken}`);
    expect(init?.signal).toBeDefined();
    return url.includes("/instances/")
      ? Response.json(missing, { status: 404 })
      : Response.json(parent);
  });
  expect(await lookup(id, identity)).toEqual({ state: "missing", status: null });
  expect(urls).toEqual([
    `https://api.cloudflare.com/client/v4/accounts/${access.accountId}/workflows/video-fixture/instances/${id}?simple=true`,
    `https://api.cloudflare.com/client/v4/accounts/${access.accountId}/workflows/video-fixture`,
  ]);
});

test("authorization, rate limits, server errors and invalid parents never imply absence", async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    let calls = 0;
    const lookup = makeAuthenticatedVideoWorkflowLookup(access, async () => {
      calls++;
      return Response.json(missing, { status });
    });
    await expect(lookup(id, identity)).rejects.toThrow("did not establish absence");
    expect(calls).toBe(1);
  }
  for (const result of [
    undefined,
    { ...parent.result, class_name: "OtherWorkflow" },
    { ...parent.result, name: "wrong" },
    { ...parent.result, script_name: "wrong" },
  ]) {
    const lookup = makeAuthenticatedVideoWorkflowLookup(access, async (input) =>
      String(input).includes("/instances/")
        ? Response.json(missing, { status: 404 })
        : Response.json({ success: true, result }),
    );
    await expect(lookup(id, identity)).rejects.toThrow("parent configuration");
  }
});

test("known status requires the exact logical launch identity and unknown statuses fail closed", async () => {
  for (const status of ["running", "complete", "errored", "terminated", "unknown"]) {
    const lookup = makeAuthenticatedVideoWorkflowLookup(access, async () =>
      Response.json({ success: true, result: { params: { effectIdentity: identity }, status } }),
    );
    if (status === "unknown") await expect(lookup(id, identity)).rejects.toThrow("unrecognized");
    else
      expect((await lookup(id, identity)).state).toBe(
        status === "running" ? "present" : "terminal",
      );
    await expect(lookup(id, "other")).rejects.toThrow("identity");
  }
});

test("response size and transport errors remain bounded failures", async () => {
  const oversized = makeAuthenticatedVideoWorkflowLookup(access, async () =>
    Response.json({ padding: "x".repeat(131_073) }),
  );
  await expect(oversized(id, identity)).rejects.toThrow("exceeds its bound");
  const transport = makeAuthenticatedVideoWorkflowLookup(access, async () => {
    throw new Error("connection unavailable");
  });
  await expect(transport(id, identity)).rejects.toThrow("connection unavailable");
  const html = makeAuthenticatedVideoWorkflowLookup(
    access,
    async () => new Response("not found", { status: 404 }),
  );
  await expect(html(id, identity)).rejects.toThrow("not JSON");
});
