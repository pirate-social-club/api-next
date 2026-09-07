import type { RouteAttachmentOwnershipProviderStartInput } from "@pirate/application/namespace-ownership";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { type Env, handleRequest } from "../../apps/hns-owner-verifier/src/index.ts";
import type { HnsTargetObserverRuntime } from "../../apps/hns-owner-verifier/src/target-observer.ts";
import { makeHnsOwnerServiceBindingTransport } from "../../packages/platform-cf/src/namespace-ownership/hns-owner-service-binding.ts";

const env: Env = {
  HNS_OWNERSHIP_SOURCE: "hns_parent_chain_txt",
  HNS_CHALLENGE_TTL_SECONDS: "3600",
  HNS_EVIDENCE_TTL_SECONDS: "2592000",
  HNS_PROVIDER_ENVIRONMENT: "staging",
  HNS_PROVIDER_CONFIGURATION_REFERENCE: "hns-owner-staging",
  HNS_PROVIDER_CONFIGURATION_VERSION: "hns-owner-config-v1",
};
const input: RouteAttachmentOwnershipProviderStartInput = {
  operation_kind: "route_attachment",
  actor_id: "user-1",
  community_id: "community-1",
  attachment_intent_id: "attachment-1",
  ceremony_intent_id: "ceremony-1",
  requirement_hash: "4".repeat(64),
  generation: 1,
  request_hash: "5".repeat(64),
  provider_binding_hash: "6".repeat(64),
  provider_configuration: {
    kind: "managed",
    reference: "hns-owner-staging",
    version: "hns-owner-config-v1",
  },
  protocol_version: "hns-txt-v1",
  environment: "staging",
  route: {
    family: "hns",
    root_label: "harbor",
    root_label_display: "harbor",
    path_segment: "app.harbor",
    href: "/c/app.harbor",
    app_host: null,
  },
};
const context = { namespace_session_id: "namespace-session-1", observation_id: "observation-1" };

test("attachment service-binding bytes decode in workerd without creation authority", async () => {
  const targetObserver: HnsTargetObserverRuntime = {
    configuration: {
      provider_id: "hns.owner.v1",
      provider_configuration_reference: "hns-owner-staging",
      provider_configuration_version: "hns-owner-config-v1",
      provider_configuration_digest: "1".repeat(64),
      environment: "staging",
      ownership_source: "hns_parent_chain_txt",
      observer_deadline_ms: 12000,
      lease_policy: {
        expected_block_interval_seconds: 600,
        minimum_safe_remaining_blocks: 144,
        expiry_safety_blocks: 144,
        evidence_lease_seconds: 2592000,
      },
    },
    observer: {
      observe: async () => {
        throw new Error("Start must not observe");
      },
    },
  };
  const wire = makeHnsOwnerServiceBindingTransport({
    fetch: (url, init) => handleRequest(new Request(String(url), init), env, { targetObserver }),
  });
  if (!wire.startRouteAttachment) throw new Error("Missing attachment transport");
  const bytes = await Effect.runPromise(wire.startRouteAttachment({ input, context }));
  expect(JSON.parse(new TextDecoder().decode(bytes)).presentation.payload.challenge_name).toBe(
    "harbor",
  );
});
