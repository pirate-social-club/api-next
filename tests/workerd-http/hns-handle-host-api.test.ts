/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { HnsHandlePersonaHostAuthorityStateV1 } from "@pirate/application/hns-host-serving";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeHnsHandleHostApiComposition } from "../../apps/http-worker/src/hns-handle-host-api-composition.ts";
import { createHttpWorker } from "../../apps/http-worker/src/transport.ts";

const path = "/internal/hns/solid-handle-host-authority/v1/resolve";
const requestText =
  '["pirate-hns-solid-handle-host-authority-request-v1","name.xn--pokmon-dva",["handle_persona_v1",["sale_namespace_activation_01",3],["verified_namespace_v1","route_evidence_7",7],["handle_grant_01",2],"persona_public_01"],"gateway-deployment-handle-v1"]';

const state: HnsHandlePersonaHostAuthorityStateV1 = {
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

function request(app: ReturnType<typeof createHttpWorker>, assertion = "access-workerd") {
  return app.request(`https://worker.internal${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "cf-access-jwt-assertion": assertion,
    },
    body: requestText,
  });
}

describe("HNS handle-host authority API in Workerd", () => {
  it("authenticates, re-resolves current authority, and returns only the frozen response", async () => {
    let resolutions = 0;
    const app = createHttpWorker({
      hnsHandleHostApi: makeHnsHandleHostApiComposition(true, {
        protected_origin: "https://worker.internal",
        access_validator: {
          verify: async (assertion) => {
            if (assertion !== "access-workerd") throw new Error("denied");
          },
        },
        authority_source: {
          resolve: () => {
            resolutions += 1;
            return Effect.succeed(state);
          },
        },
      }),
    });
    const response = await request(app);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(
      '["pirate-hns-solid-handle-host-authority-response-v1","active","name.xn--pokmon-dva","xn--pokmon-dva","name","com_cmt_public_namespace_test","persona_public_01",["handle_persona_v1",["sale_namespace_activation_01",3],["verified_namespace_v1","route_evidence_7",7],["handle_grant_01",2],"persona_public_01"],"gateway-deployment-handle-v1"]',
    );
    expect(resolutions).toBe(1);
  });

  it("authenticates before decode and collapses inactive authority to not found", async () => {
    let resolutions = 0;
    const app = createHttpWorker({
      hnsHandleHostApi: makeHnsHandleHostApiComposition(true, {
        protected_origin: "https://worker.internal",
        access_validator: {
          verify: async (assertion) => {
            if (assertion !== "access-workerd") throw new Error("denied");
          },
        },
        authority_source: {
          resolve: () => {
            resolutions += 1;
            return Effect.succeed({ ...state, handle_grant_active: false });
          },
        },
      }),
    });
    expect((await request(app, "denied")).status).toBe(401);
    expect(resolutions).toBe(0);
    expect((await request(app)).status).toBe(404);
    expect(resolutions).toBe(1);
  });
});
