import { test } from "node:test";
import assert from "node:assert/strict";
import * as Domain from "@alchemy.run/domain";
import { Effect, Layer } from "effect";
import { AdmissionModel } from "../src/model.ts";
import { handle, HttpAccess } from "../src/http.ts";
import { HnsObserver } from "../src/service.ts";
import { binding, hash } from "./fixtures.ts";
import { strictJson } from "../src/strict-json.ts";
const fixtureObserver = Layer.succeed(
  HnsObserver,
  HnsObserver.of({
    baseline: () =>
      Effect.succeed({
        records: [{ type: "NS", ns: "ns1.example." }],
        ownershipEpoch: hash,
      }),
    observe: () =>
      Effect.succeed({ status: "unavailable", reason: "observer_timeout" }),
  }),
);
const fixtureAccess = Layer.succeed(
  HttpAccess,
  HttpAccess.of({
    authorize: (request) =>
      request.headers.get("x-fixture-access") === "yes"
        ? Effect.void
        : Effect.fail({
            _tag: "AdmissionError",
            reason: "invalid_signature",
          } as import("../src/service.ts").AdmissionError),
  }),
);
const app = Layer.mergeAll(
  fixtureObserver,
  fixtureAccess,
  AdmissionModel.layer(Layer.empty).pipe(Layer.provide(Domain.InMemory)),
);
test("HTTP creates pending work, preserves idempotency and never offers submission", async () => {
  const program = Effect.gen(function* () {
    const headers = {
      "content-type": "application/json",
      "x-fixture-access": "yes",
    };
    const post = (body: unknown) =>
      new Request("https://admission.test/v1/ceremonies", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    const input = { idempotencyKey: hash, binding };
    const a = yield* handle(post(input));
    assert.equal(a.status, 202);
    const av = yield* Effect.promise(() => a.json());
    const b = yield* handle(post(input));
    const bv = yield* Effect.promise(() => b.json());
    assert.equal(av.operationId, bv.operationId);
    assert.equal(av.status, "waiting");
    const denied = yield* handle(
      new Request("https://admission.test/v1/ceremonies", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
    assert.equal(denied.status, 403);
    const conflict = yield* handle(
      post({ ...input, binding: { ...binding, chainId: 1 } }),
    );
    assert.equal(conflict.status, 409);
    const get = yield* handle(
      new Request("https://admission.test/v1/operations/" + av.operationId, {
        headers,
      }),
    );
    const gv = yield* Effect.promise(() => get.json());
    assert.equal(
      gv.revision,
      av.revision,
      "a status read must not create a revision",
    );
    assert.equal(
      (yield* handle(
        new Request("https://admission.test/v1/submit", {
          method: "POST",
          headers,
          body: "{}",
        }),
      )).status,
      404,
    );
    const unknown = yield* handle(post({ ...input, unexpected: true }));
    assert.equal(unknown.status, 400);
  });
  await Effect.runPromise(program.pipe(Effect.provide(app)));
});
test("strict JSON rejects duplicate escaped keys and excessive nesting", () => {
  assert.throws(
    () => strictJson('{"communityId":1,"communi\\u0074yId":2}'),
    /duplicate_json_key/,
  );
  assert.deepEqual(strictJson('{"a":[{"b":1}]}'), { a: [{ b: 1 }] });
  assert.throws(
    () => strictJson("[".repeat(66) + "0" + "]".repeat(66)),
    /json_too_deep/,
  );
});
