import { describe, expect, test } from "bun:test";
import type { HnsHandlePersonaHostAuthorityStateV1 } from "@pirate/platform-cf/hns-handle-host-api";
import { Effect } from "effect";
import { makeHnsHandleHostApiComposition } from "./hns-handle-host-api-composition.ts";
import { createHttpWorker } from "./transport.ts";

const path = "/internal/hns/solid-handle-host-authority/v1/resolve";
const requestText =
  '["pirate-hns-solid-handle-host-authority-request-v1","name.xn--pokmon-dva",["handle_persona_v1",["sale_namespace_activation_01",3],["verified_namespace_v1","route_evidence_7",7],["handle_grant_01",2],"persona_public_01"],"gateway-deployment-handle-v1"]';
const responseText =
  '["pirate-hns-solid-handle-host-authority-response-v1","active","name.xn--pokmon-dva","xn--pokmon-dva","name","com_cmt_public_namespace_test","persona_public_01",["handle_persona_v1",["sale_namespace_activation_01",3],["verified_namespace_v1","route_evidence_7",7],["handle_grant_01",2],"persona_public_01"],"gateway-deployment-handle-v1"]';

const activeState: HnsHandlePersonaHostAuthorityStateV1 = {
  variant: "handle_persona_v1",
  normalized_host: "name.xn--pokmon-dva",
  canonical_root: "xn--pokmon-dva",
  canonical_handle_label: "name",
  community_id: "com_cmt_public_namespace_test",
  sale_namespace_activation_id: "sale_namespace_activation_01",
  sale_namespace_activation_generation: 3,
  sale_namespace_activation_status: "active",
  sale_namespace_dns_zone_id: "dns-zone-handle",
  sale_namespace_dns_zone_generation: 4,
  sale_namespace_gateway_deployment_reference: "gateway-deployment-handle-v1",
  namespace_authority_kind: "verified_namespace_v1",
  namespace_authority_reference: "route_evidence_7",
  namespace_authority_generation: 7,
  namespace_authority_effective: true,
  handle_grant_id: "handle_grant_01",
  handle_grant_generation: 2,
  handle_grant_active: true,
  fulfillment_kind: "hosted_persona_v1",
  owner_persona_id: "persona_public_01",
  owner_persona_public: true,
  dns_zone: {
    dns_zone_activation_id: "dns-zone-handle",
    dns_zone_activation_generation: 4,
    status: "active",
    stable_chain_delegation_matches: true,
    dnssec_ds_authenticates_zone: true,
    retained_zone_digest_matches: true,
    gateway_deployment_reference: "gateway-deployment-handle-v1",
    gateway_certificate_spki_sha256: "a".repeat(64),
    gateway_health: "healthy",
  },
};

const worker = (state: HnsHandlePersonaHostAuthorityStateV1 | null) =>
  createHttpWorker({
    hnsHandleHostApi: makeHnsHandleHostApiComposition(true, {
      access_validator: {
        verify: async (jwt) => {
          if (jwt !== "access-ok") throw new Error("denied");
        },
      },
      authority_source: { resolve: () => Effect.succeed(state) },
    }),
  });

const post = (
  app: ReturnType<typeof createHttpWorker>,
  overrides: Readonly<{
    method?: string;
    body?: string;
    headers?: Readonly<Record<string, string>>;
  }> = {},
) =>
  app.request(`https://api-next.internal${path}`, {
    method: overrides.method ?? "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "cf-access-jwt-assertion": "access-ok",
      ...Object.fromEntries(new Headers(overrides.headers)),
    },
    body: overrides.body ?? requestText,
  });

describe("HNS handle-host private authority transport", () => {
  test("returns only the exact active response with no-store", async () => {
    const response = await post(worker(activeState));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe(responseText);
  });

  test("authenticates before decoding and collapses inactive state", async () => {
    const app = worker(activeState);
    const missing = await post(app, { headers: { "cf-access-jwt-assertion": "" } });
    expect(missing.status).toBe(401);
    const malformed = await post(app, {
      body: "not-json",
      headers: { "cf-access-jwt-assertion": "denied" },
    });
    expect(malformed.status).toBe(401);
    const inactive = await post(worker({ ...activeState, handle_grant_active: false }));
    expect(inactive.status).toBe(404);
    expect(await inactive.text()).not.toContain("handle_grant");
  });

  test("rejects wrong methods, media types, and noncanonical bytes", async () => {
    const app = worker(activeState);
    expect((await post(app, { method: "PUT" })).status).toBe(400);
    expect((await post(app, { headers: { accept: "text/plain" } })).status).toBe(400);
    expect((await post(app, { body: `${requestText}\n` })).status).toBe(400);
  });

  test("fails closed when the composition is absent", async () => {
    const response = await post(createHttpWorker());
    expect(response.status).toBe(401);
  });
});
