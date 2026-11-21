import { test } from "node:test";
import assert from "node:assert/strict";
import * as Domain from "@alchemy.run/domain";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { AdmissionModel, Ceremony, CreateCeremony } from "../src/model.ts";
import { HnsObserver, cancel, observe, create } from "../src/service.ts";
import { state, hash, binding, observation } from "./fixtures.ts";

test("cancellation fences a successful observation already in flight", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      const observer = Layer.succeed(
        HnsObserver,
        HnsObserver.of({
          baseline: () => Effect.succeed({ records: [], ownershipEpoch: hash }),
          observe: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return {
                status: "verified" as const,
                observation: {
                  ...observation(),
                  inclusionTime: Math.floor(Date.now() / 1000) - 60,
                },
              };
            }),
        }),
      );
      const live = Layer.merge(
        observer,
        AdmissionModel.layer(Layer.empty).pipe(Layer.provide(Domain.InMemory)),
      );
      yield* Effect.gen(function* () {
        const model = yield* Ceremony;
        const now = Math.floor(Date.now() / 1000);
        yield* model.send(
          hash,
          new CreateCeremony({
            snapshot: {
              ...state(),
              consented: true,
              phase: "AwaitingPublication",
              publicationDeadline: now + 172800,
              consentDeadline: now + 259200,
            },
          }),
        );
        const fiber = yield* Effect.forkChild(
          observe(hash).pipe(Effect.result),
        );
        yield* Deferred.await(entered);
        const reserved = (yield* model.get(hash))!;
        yield* cancel(hash, reserved.revision);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(fiber);
        const final = (yield* model.get(hash))!;
        assert.equal(final.phase, "Cancelled");
        assert.equal(final.maturedAt, null);
        assert.equal(final.lastObservation, null);
      }).pipe(Effect.provide(live));
    }),
  );
});

test("resource overflow is an actionable capacity result and creates no ceremony", async () => {
  const observer = Layer.succeed(
    HnsObserver,
    HnsObserver.of({
      baseline: () =>
        Effect.succeed({
          records: [{ type: "TXT", txt: ["a".repeat(255), "b".repeat(180)] }],
          ownershipEpoch: hash,
        }),
      observe: () => Effect.die("unexpected_probe"),
    }),
  );
  const live = Layer.merge(
    observer,
    AdmissionModel.layer(Layer.empty).pipe(Layer.provide(Domain.InMemory)),
  );
  const error = await Effect.runPromise(
    create({ binding, idempotencyKey: hash }).pipe(
      Effect.flip,
      Effect.provide(live),
    ),
  );
  assert.equal(error.reason, "resource_capacity_exceeded");
});
