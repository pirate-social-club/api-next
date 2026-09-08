import { describe, expect, test } from "bun:test";
import type { RouteAttachmentOwnershipProviderStartInput } from "@pirate/application/namespace-ownership";
import { Effect } from "effect";
import { makeHnsOwnerServiceBindingTransport } from "../../../packages/platform-cf/src/namespace-ownership/hns-owner-service-binding.ts";
import { attachmentObserverFixture } from "./attachment-observer.fixture.ts";
import { type Env, handleRequest } from "./index.ts";
import type { HnsTargetObserverRuntime } from "./target-observer.ts";

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
function transport(targetObserver: HnsTargetObserverRuntime) {
  const wire = makeHnsOwnerServiceBindingTransport({
    fetch: (url, init) => handleRequest(new Request(String(url), init), env, { targetObserver }),
  });
  if (!wire.startRouteAttachment || !wire.pollRouteAttachment)
    throw new Error("Missing attachment transport");
  return {
    startRouteAttachment: wire.startRouteAttachment,
    pollRouteAttachment: wire.pollRouteAttachment,
  };
}
function request(body: unknown, poll = false) {
  return new Request(
    `https://hns-owner.internal/internal/hns-owner/v1/${poll ? "poll" : "start"}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: poll ? "application/octet-stream" : "application/json",
        "Pirate-Namespace-Session-Id": context.namespace_session_id,
        ...(poll ? { "Pirate-HNS-Observation-Id": context.observation_id } : {}),
      },
      body: JSON.stringify(body),
    },
  );
}
describe("community attachment transport and verifier contract", () => {
  test("decodes the actual transport start bytes without a creation intent", async () => {
    const wire = transport(attachmentObserverFixture("pending"));
    const bytes = await Effect.runPromise(wire.startRouteAttachment({ input, context }));
    const result = JSON.parse(new TextDecoder().decode(bytes));
    expect(result.presentation.payload.challenge_name).toBe("harbor");
    expect(result.presentation.payload.challenge_value).toBe(
      `pirate-verification=${result.upstream_session_ref}`,
    );
  });
  for (const status of ["pending", "verified"] as const)
    test(`observes attachment ${status} through the real transport and handler`, async () => {
      let observations = 0;
      const wire = transport(attachmentObserverFixture(status, () => observations++));
      const started = JSON.parse(
        new TextDecoder().decode(
          await Effect.runPromise(wire.startRouteAttachment({ input, context })),
        ),
      );
      const session = {
        ...input,
        provider_id: "hns.owner.v1",
        upstream_session_ref: started.upstream_session_ref,
        expires_at: started.expires_at,
      };
      const bytes = await Effect.runPromise(
        wire.pollRouteAttachment({ session, payload: {}, context }),
      );
      expect(JSON.parse(new TextDecoder().decode(bytes)).status).toBe(status);
      expect(observations).toBe(1);
    });
  test("rejects invalid attachment authority before loading configuration", async () => {
    let resolutions = 0;
    for (const body of [
      { ...input, creation_intent_id: "wrong" },
      { ...input, generation: 0 },
      { ...input, community_id: "" },
      { ...input, operation_kind: "creation" },
      { ...input, route: { ...input.route, href: "/c/app.other" } },
    ]) {
      const response = await handleRequest(request(body), env, {
        resolveTargetObserver: async () => {
          resolutions++;
          return attachmentObserverFixture("pending");
        },
      });
      expect(response.status).toBe(400);
    }
    expect(resolutions).toBe(0);
  });
  test("rejects expired, mixed-operation, extra-field and wrong-configuration polls without observation", async () => {
    let observations = 0;
    const targetObserver = attachmentObserverFixture("verified", () => observations++);
    const session = {
      ...input,
      provider_id: "hns.owner.v1",
      upstream_session_ref: "nvs_test",
      expires_at: new Date(Date.now() + 60000).toISOString(),
    };
    for (const changed of [
      { ...session, expires_at: "2020-01-01T00:00:00.000Z" },
      { ...session, operation_kind: "creation" },
      { ...session, creation_intent_id: "wrong" },
      { ...session, generation: 0 },
    ]) {
      expect(
        (
          await handleRequest(
            request({ operation_kind: "route_attachment", session: changed, payload: {} }, true),
            env,
            { targetObserver },
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await handleRequest(
          request(
            {
              operation_kind: "route_attachment",
              session: { ...session, environment: "production" },
              payload: {},
            },
            true,
          ),
          env,
          { targetObserver },
        )
      ).status,
    ).toBe(502);
    expect(observations).toBe(0);
  });
});
