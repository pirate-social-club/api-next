import { test } from "node:test";
import assert from "node:assert/strict";
import * as Domain from "@alchemy.run/domain";
import { Effect, Layer } from "effect";
import {
  AdmissionModel,
  Ceremony,
  CreateCeremony,
  ApplyObservation,
  CheckDeadlines,
} from "../src/model.ts";
import { state, hash } from "./fixtures.ts";
const memory = AdmissionModel.layer(Layer.empty).pipe(
  Layer.provide(Domain.InMemory),
);
test("Alchemy aggregate fences concurrent mutation and keeps equal-create idempotency", async () => {
  const program = Effect.gen(function* () {
    const model = yield* Ceremony,
      s = state();
    yield* model.send(hash, new CreateCeremony({ snapshot: s }));
    yield* model.send(
      hash,
      new CreateCeremony({
        snapshot: {
          ...s,
          nonce: "0x" + "33".repeat(32),
          resourceDigest: "0x" + "44".repeat(32),
        },
      }),
    );
    assert.equal((yield* model.get(hash))!.nonce, s.nonce);
    const results = yield* Effect.all(
      [
        model
          .send(
            hash,
            new ApplyObservation({
              expectedRevision: 1,
              action: { type: "Cancel" },
            }),
          )
          .pipe(Effect.result),
        model
          .send(
            hash,
            new ApplyObservation({
              expectedRevision: 1,
              action: { type: "Cancel" },
            }),
          )
          .pipe(Effect.result),
      ],
      { concurrency: 2 },
    );
    assert.equal(results.filter((r) => r._tag === "Success").length, 1);
    assert.equal((yield* model.get(hash))!.phase, "Cancelled");
  });
  await Effect.runPromise(program.pipe(Effect.provide(memory)));
});
