/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  type HnsOwnerServiceBinding,
  makeHnsOwnerServiceBindingTransport,
} from "../../packages/platform-cf/src/namespace-ownership/hns-owner-service-binding.ts";

const input = {
  actor_id: "user-workerd",
  creation_intent_id: "creation-workerd",
  ceremony_intent_id: "ceremony-workerd",
  requirement_hash: "1".repeat(64),
  generation: 1,
  request_hash: "2".repeat(64),
  provider_binding_hash: "3".repeat(64),
  provider_configuration: {
    kind: "managed" as const,
    reference: "hns-owner-workerd",
    version: "1",
  },
  protocol_version: "hns-txt-v1",
  environment: "test",
  route: {
    family: "hns" as const,
    root_label: "jazleeuw",
    root_label_display: "jazleeuw",
    path_segment: "app.jazleeuw",
    href: "/c/app.jazleeuw",
    app_host: null,
  },
};
const context = { namespace_session_id: "namespace-session-workerd" };

describe("HNS owner Worker service binding", () => {
  it("crosses the real binding and preserves start JSON and poll bytes", async () => {
    const binding = (env as Cloudflare.Env & { HNS_OWNER_VERIFIER: HnsOwnerServiceBinding })
      .HNS_OWNER_VERIFIER;
    const transport = makeHnsOwnerServiceBindingTransport(binding);
    const startBytes = await Effect.runPromise(transport.start({ input, context }));
    expect(JSON.parse(new TextDecoder().decode(startBytes))).toMatchObject({
      upstream_session_ref: "upstream-workerd-binding",
      presentation: {
        payload: {
          ownership_source: "hns_parent_chain_txt",
          challenge_name: "jazleeuw",
        },
      },
    });

    const pollBytes = await Effect.runPromise(
      transport.poll({
        session: {
          ...input,
          provider_id: "hns.owner.v1",
          upstream_session_ref: "upstream-workerd-binding",
          expires_at: "2099-01-01T00:00:00.000Z",
        },
        payload: {},
        context,
      }),
    );
    expect(pollBytes).toEqual(new Uint8Array([0, 1, 127, 255]));
  });
});
