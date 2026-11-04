import { describe, expect, test } from "bun:test";
import { ControlPlaneAcquireFailed } from "@pirate/application";
import type {
  HnsForwarderGatewayAuthoritySourceV1,
  HnsHostAuthorityStateV1,
} from "@pirate/application/hns-host-serving";
import { Effect } from "effect";
import { makeCoalescingHnsGatewayAuthoritySourceV1 } from "./hns-community-app-gateway-authority-postgres.ts";

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<A>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, reject, resolve };
}

describe("coalescing HNS gateway authority source", () => {
  test("honors an explicit deadline without changing the default", async () => {
    const source: HnsForwarderGatewayAuthoritySourceV1 = {
      resolve: () =>
        Effect.promise(() => new Promise((resolve) => setTimeout(() => resolve(null), 80))),
    };
    const wrapped = makeCoalescingHnsGatewayAuthoritySourceV1(source, 10);
    await expect(Effect.runPromise(wrapped.resolve("app.slow.invalid"))).rejects.toBeDefined();
  });

  test("coalesces the same host while different hosts resolve concurrently", async () => {
    const gates = [deferred<null>(), deferred<null>()];
    const calls: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const source: HnsForwarderGatewayAuthoritySourceV1 = {
      resolve: (host) =>
        Effect.promise(async () => {
          const gate = gates[calls.length];
          if (gate === undefined) throw new Error("unexpected authority query");
          calls.push(host);
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          try {
            return await gate.promise;
          } finally {
            active -= 1;
          }
        }),
    };
    const wrapped = makeCoalescingHnsGatewayAuthoritySourceV1(source);

    const first = Effect.runPromise(wrapped.resolve("app.first.invalid"));
    const duplicate = Effect.runPromise(wrapped.resolve("app.first.invalid"));
    const isolated = Effect.runPromise(wrapped.resolve("app.second.invalid"));
    await Bun.sleep(0);
    expect(calls).toEqual(["app.first.invalid", "app.second.invalid"]);
    gates[0]?.resolve(null);
    gates[1]?.resolve(null);

    expect(await Promise.all([first, duplicate, isolated])).toEqual([null, null, null]);
    expect(maximumActive).toBe(2);
  });

  test("briefly caches only unclaimed answers", async () => {
    let calls = 0;
    let clock = 1_000;
    const source: HnsForwarderGatewayAuthoritySourceV1 = {
      resolve: () =>
        Effect.sync(() => {
          calls += 1;
          return null;
        }),
    };
    const wrapped = makeCoalescingHnsGatewayAuthoritySourceV1(source, 1_500, () => clock);

    await Effect.runPromise(wrapped.resolve("app.fresh.invalid"));
    await Effect.runPromise(wrapped.resolve("app.fresh.invalid"));
    expect(calls).toBe(1);
    clock += 3_000;
    await Effect.runPromise(wrapped.resolve("app.fresh.invalid"));

    expect(calls).toBe(2);
  });

  test("never caches claimed answers", async () => {
    let calls = 0;
    const claimed = { variant: "community_app_v1" } as unknown as HnsHostAuthorityStateV1;
    const source: HnsForwarderGatewayAuthoritySourceV1 = {
      resolve: () =>
        Effect.sync(() => {
          calls += 1;
          return claimed;
        }),
    };
    const wrapped = makeCoalescingHnsGatewayAuthoritySourceV1(source);
    await Effect.runPromise(wrapped.resolve("app.claimed.invalid"));
    await Effect.runPromise(wrapped.resolve("app.claimed.invalid"));
    expect(calls).toBe(2);
  });

  test("bounds the unclaimed cache during distinct-host floods", async () => {
    let calls = 0;
    const source: HnsForwarderGatewayAuthoritySourceV1 = {
      resolve: () =>
        Effect.sync(() => {
          calls += 1;
          return null;
        }),
    };
    const wrapped = makeCoalescingHnsGatewayAuthoritySourceV1(source);
    for (let index = 0; index < 1_025; index += 1) {
      await Effect.runPromise(wrapped.resolve(`host${index}.invalid`));
    }
    await Effect.runPromise(wrapped.resolve("host0.invalid"));
    expect(calls).toBe(1_026);
  });

  test("evicts failures so a later request can retry", async () => {
    let calls = 0;
    const source: HnsForwarderGatewayAuthoritySourceV1 = {
      resolve: () =>
        Effect.suspend(() => {
          calls += 1;
          return calls === 1
            ? Effect.fail(
                new ControlPlaneAcquireFailed({
                  elapsedMs: 1,
                  limitMs: 1_500,
                  phase: "acquisition",
                }),
              )
            : Effect.succeed(null);
        }),
    };
    const wrapped = makeCoalescingHnsGatewayAuthoritySourceV1(source);

    await expect(Effect.runPromise(wrapped.resolve("app.retry.invalid"))).rejects.toBeDefined();
    expect(await Effect.runPromise(wrapped.resolve("app.retry.invalid"))).toBeNull();
    expect(calls).toBe(2);
  });
});
