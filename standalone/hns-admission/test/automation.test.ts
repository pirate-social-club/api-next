import { test } from "node:test";
import assert from "node:assert/strict";
import { Clock, Effect, Layer } from "effect";
import { make } from "@alchemy.run/domain/InMemory";
import { OperationalModel, Ceremony, CreateCeremony } from "../src/model.ts";
import { AutomationLive } from "../src/automation.ts";
import { HnsObserver, observe } from "../src/service.ts";
import { state, hash } from "./fixtures.ts";
test("durable polling survives hours of observer outages, coalesces probes, and enforces stored expiry after a late wake", async () => {
  let now = 1000,
    probes = 0;
  const memory = make({ manual: true, now: () => now * 1000 });
  const observer = Layer.succeed(
    HnsObserver,
    HnsObserver.of({
      baseline: () => Effect.succeed({ records: [], ownershipEpoch: hash }),
      observe: () =>
        Effect.sync(() => {
          probes++;
          return {
            status: "unavailable" as const,
            reason: "observer_disagreement" as const,
          };
        }),
    }),
  );
  const live = OperationalModel.layer(
    AutomationLive.pipe(Layer.provide(observer)),
  ).pipe(Layer.provide(memory.layer), Layer.provideMerge(observer));
  await Effect.runPromise(
    Effect.gen(function* () {
      const actual = yield* Clock.Clock;
      const clock: Clock.Clock = Object.assign(Object.create(actual), {
        currentTimeMillisUnsafe: () => now * 1000,
        currentTimeMillis: Effect.sync(() => now * 1000),
      });
      yield* Effect.gen(function* () {
        const model = yield* Ceremony;
        yield* model.send(
          hash,
          new CreateCeremony({
            snapshot: {
              ...state(),
              consented: true,
              phase: "AwaitingPublication",
            },
          }),
        );
        yield* memory.control.drain;
        for (let i = 0; i < 30; i++) {
          now += 301;
          yield* memory.control.drain;
        }
        assert.ok(
          probes >= 30,
          "known outage retries must continue past native retry limits",
        );
        const before = probes;
        yield* Effect.all([observe(hash), observe(hash)], { concurrency: 2 });
        assert.equal(
          probes,
          before,
          "a replay during the next-observation interval does no RPC work",
        );
        assert.equal(
          (yield* model.get(hash))!.condition,
          "observer_disagreement",
        );
        now = 200000;
        yield* memory.control.drain;
        assert.equal((yield* model.get(hash))!.phase, "Expired");
        assert.equal(
          probes,
          before,
          "a late wake checks stored deadlines before probing",
        );
        assert.equal(memory.control.failures.length, 0);
      }).pipe(Effect.provide(live), Effect.provideService(Clock.Clock, clock));
    }),
  );
});
