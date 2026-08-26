/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env as testEnv } from "cloudflare:test";
import {
  HNS_COMMUNITY_APP_API_REPLAY_SCOPE,
  makeDurableObjectHnsForwarderReplayStore,
} from "@pirate/platform-cf/hns-forwarder-replay-store";
import { describe, expect, it } from "vitest";
import type { HnsForwarderReplayStoreDO } from "../../packages/platform-cf/src/hns-forwarder-replay-store-do.ts";

const env = testEnv as unknown as {
  readonly HNS_COMMUNITY_APP_API_REPLAY: DurableObjectNamespace<HnsForwarderReplayStoreDO>;
};

describe("HNS forwarder replay Durable Object", () => {
  it("atomically consumes one unsafe nonce in the api-next scope", async () => {
    let now = 1_770_000_000;
    const store = makeDurableObjectHnsForwarderReplayStore({
      namespace: env.HNS_COMMUNITY_APP_API_REPLAY,
      consumerScope: HNS_COMMUNITY_APP_API_REPLAY_SCOPE,
      clock: { nowUnixSeconds: () => now },
      retentionSeconds: 306,
    });

    const attempts = await Promise.all(
      Array.from({ length: 12 }, () => store.consume("gateway-key-workerd", "nonce-workerd")),
    );
    expect(attempts.filter(Boolean)).toHaveLength(1);

    now += 306;
    expect(await store.consume("gateway-key-workerd", "nonce-workerd")).toBe(true);
  });

  it("keeps consumer scopes independent and rejects malformed identities", async () => {
    const options = {
      namespace: env.HNS_COMMUNITY_APP_API_REPLAY,
      clock: { nowUnixSeconds: () => 1_770_000_000 },
      retentionSeconds: 306,
    } as const;
    const apiStore = makeDurableObjectHnsForwarderReplayStore({
      ...options,
      consumerScope: HNS_COMMUNITY_APP_API_REPLAY_SCOPE,
    });
    const independentStore = makeDurableObjectHnsForwarderReplayStore({
      ...options,
      consumerScope: "pirate:hns-forwarder-v3:solid-community-app:v1",
    });

    expect(await apiStore.consume("gateway-key-workerd", "nonce-shared")).toBe(true);
    expect(await independentStore.consume("gateway-key-workerd", "nonce-shared")).toBe(true);
    expect(await apiStore.consume("bad key", "nonce-workerd")).toBe(false);
    expect(await apiStore.consume("gateway-key-workerd", "")).toBe(false);
  });
});
