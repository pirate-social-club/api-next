import { describe, expect, test } from "bun:test";
import { ControlPlaneAcquireFailed } from "@pirate/application";
import type { HnsForwarderGatewayAuthoritySourceV1 } from "@pirate/application/hns-host-serving";
import { Effect } from "effect";
import { makeSerializedCoalescingHnsGatewayAuthoritySourceV1 } from "./hns-community-app-gateway-authority-postgres.ts";

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<A>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, reject, resolve };
}

describe("serialized HNS gateway authority source", () => {
  test("coalesces only concurrent requests for the same normalized host", async () => {
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
    const wrapped = makeSerializedCoalescingHnsGatewayAuthoritySourceV1(source);

    const first = Effect.runPromise(wrapped.resolve("app.first.invalid"));
    const duplicate = Effect.runPromise(wrapped.resolve("app.first.invalid"));
    const isolated = Effect.runPromise(wrapped.resolve("app.second.invalid"));
    await Bun.sleep(0);
    expect(calls).toEqual(["app.first.invalid"]);
    gates[0]?.resolve(null);
    await Bun.sleep(0);
    expect(calls).toEqual(["app.first.invalid", "app.second.invalid"]);
    gates[1]?.resolve(null);

    expect(await Promise.all([first, duplicate, isolated])).toEqual([null, null, null]);
    expect(maximumActive).toBe(1);
  });

  test("evicts settled successes so a later request resolves afresh", async () => {
    let calls = 0;
    const source: HnsForwarderGatewayAuthoritySourceV1 = {
      resolve: () =>
        Effect.sync(() => {
          calls += 1;
          return null;
        }),
    };
    const wrapped = makeSerializedCoalescingHnsGatewayAuthoritySourceV1(source);

    await Effect.runPromise(wrapped.resolve("app.fresh.invalid"));
    await Effect.runPromise(wrapped.resolve("app.fresh.invalid"));

    expect(calls).toBe(2);
  });

  test("evicts failures and continues the serialization queue", async () => {
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
    const wrapped = makeSerializedCoalescingHnsGatewayAuthoritySourceV1(source);

    await expect(Effect.runPromise(wrapped.resolve("app.retry.invalid"))).rejects.toBeDefined();
    expect(await Effect.runPromise(wrapped.resolve("app.retry.invalid"))).toBeNull();
    expect(calls).toBe(2);
  });
});
