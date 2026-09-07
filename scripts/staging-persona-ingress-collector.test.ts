import { expect, test } from "bun:test";
import {
  collectStagingIngressFence,
  selectStagingIngressApplication,
  verifyStagingIngressBlockPolicies,
} from "./staging-persona-ingress-collector.ts";
import {
  STAGING_HTTP_INGRESS_HOSTS,
  STAGING_HTTP_WORKER_ID,
} from "./staging-persona-ingress-fence.ts";

const id = "a".repeat(32);
const account = "b".repeat(32);
const application = {
  id,
  type: "self_hosted",
  destinations: [{ type: "worker", worker_id: STAGING_HTTP_WORKER_ID }],
};
const policy = {
  id: "c".repeat(32),
  decision: "deny",
  include: [{ everyone: {} }],
  exclude: [],
  require: [],
};
const transport = (respond: (request: Request) => Response | Promise<Response>): typeof fetch =>
  Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => respond(new Request(url, init)),
    { preconnect() {} },
  );
const envelope = (result: unknown[]) =>
  Response.json({ success: true, result, result_info: { page: 1, total_pages: 1 } });

test("requires the fixed Worker and rejects hostname/path/preview overrides", () => {
  expect(selectStagingIngressApplication([application], id).id).toBe(id);
  for (const override of [
    { id: "d".repeat(32), type: "self_hosted", domain: "*.pirate.sc/admin" },
    {
      id: "d".repeat(32),
      type: "self_hosted",
      destinations: [{ type: "public", uri: `${STAGING_HTTP_INGRESS_HOSTS[1]}/x` }],
    },
    {
      id: "d".repeat(32),
      type: "self_hosted",
      destinations: [{ type: "preview_worker", worker_id: STAGING_HTTP_WORKER_ID }],
    },
    { ...application, id: "d".repeat(32) },
    {
      id: "d".repeat(32),
      type: "self_hosted",
      domain: STAGING_HTTP_INGRESS_HOSTS[0],
      destinations: [{ type: "all_workers" }],
    },
    { id: "d".repeat(32), type: "self_hosted", destinations: [{ type: "unknown_override" }] },
  ])
    expect(() => selectStagingIngressApplication([application, override], id)).toThrow();
  expect(() => selectStagingIngressApplication([], id)).toThrow();
});

test("admits only an unconditional block-everyone policy", () => {
  expect(verifyStagingIngressBlockPolicies([policy]).decision).toBe("deny");
  for (const candidate of [
    [],
    [policy, policy],
    [{ ...policy, decision: "allow" }],
    [{ ...policy, decision: "bypass" }],
    [{ ...policy, include: [{ email: { email: "operator@example.test" } }] }],
    [{ ...policy, exclude: [{ everyone: {} }] }],
  ])
    expect(() => verifyStagingIngressBlockPolicies(candidate)).toThrow();
});

test("reads provider inventory twice and probes both hosts without credentials", async () => {
  let inventory = 0;
  let policies = 0;
  const probes: string[] = [];
  const result = await collectStagingIngressFence({
    accountId: account,
    applicationId: id,
    apiToken: "fixture-only",
    fetch: transport((request) => {
      expect(request.redirect).toBe("manual");
      const url = new URL(request.url);
      if (url.hostname === "api.cloudflare.com") {
        expect(request.headers.get("authorization")).toBe("Bearer fixture-only");
        if (url.pathname.endsWith("/policies")) {
          policies++;
          return envelope([policy]);
        }
        inventory++;
        return envelope([application]);
      }
      expect(request.headers.has("authorization")).toBe(false);
      expect(request.headers.has("cookie")).toBe(false);
      probes.push(url.hostname);
      return new Response(null, { status: 403 });
    }),
  });
  expect(result.ingressDenied).toBe(true);
  expect(inventory).toBe(2);
  expect(policies).toBe(2);
  expect(probes).toEqual([...STAGING_HTTP_INGRESS_HOSTS]);
  expect(JSON.stringify(result)).not.toContain("fixture-only");
});

test("fails closed on provider pagination failure, redirect, changed policy or an admitted host", async () => {
  for (const fault of ["pagination", "redirect", "changed", "probe"]) {
    let policies = 0;
    await expect(
      collectStagingIngressFence({
        accountId: account,
        applicationId: id,
        apiToken: "fixture-only",
        fetch: transport((request) => {
          const url = new URL(request.url);
          if (url.hostname !== "api.cloudflare.com")
            return new Response(null, { status: fault === "probe" ? 200 : 403 });
          if (fault === "redirect") return new Response(null, { status: 302 });
          if (fault === "pagination")
            return Response.json({
              success: true,
              result: [],
              result_info: { page: 1, total_pages: 21 },
            });
          if (url.pathname.endsWith("/policies")) {
            policies++;
            return envelope([
              { ...policy, decision: fault === "changed" && policies > 1 ? "allow" : "deny" },
            ]);
          }
          return envelope([application]);
        }),
      }),
    ).rejects.toThrow("staging_ingress_fence_unproven");
  }
});
