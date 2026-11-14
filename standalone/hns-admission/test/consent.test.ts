import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Effect, Layer } from "effect";
import * as Domain from "@alchemy.run/domain";
import { AdmissionModel } from "../src/model.ts";
import {
  HnsObserver,
  create,
  consent,
  current,
  instructions,
} from "../src/service.ts";
import { consentData } from "../src/protocol.ts";
import { binding, hash } from "./fixtures.ts";
const observer = Layer.succeed(
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
test("actual EOA consent is bound to the whole resource and never consumed on failed verification", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const changed = { ...binding, controller: account.address.toLowerCase() };
  const layers = Layer.merge(
    observer,
    AdmissionModel.layer(Layer.empty).pipe(Layer.provide(Domain.InMemory)),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const s = yield* create({ idempotencyKey: hash, binding: changed });
      const data = consentData(changed, {
        ceremonyId: s.id,
        bindingDigest: s.bindingDigest,
        resourceDigest: s.resourceDigest,
        nonce: s.nonce,
        issuedAt: s.createdAt,
        deadline: s.consentDeadline,
      });
      const wrong = yield* Effect.promise(() =>
        account.signTypedData({
          ...data,
          message: { ...data.message, resourceDigest: hash as `0x${string}` },
        }),
      );
      const failed = yield* consent(s.id, {
        expectedRevision: s.revision,
        issuedAt: s.createdAt,
        deadline: s.consentDeadline,
        signature: wrong,
      }).pipe(Effect.result);
      assert.equal(failed._tag, "Failure");
      assert.equal((yield* current(s.id)).revision, 1);
      const signature = yield* Effect.promise(() =>
        account.signTypedData(data),
      );
      const accepted = yield* consent(s.id, {
        expectedRevision: s.revision,
        issuedAt: s.createdAt,
        deadline: s.consentDeadline,
        signature,
      });
      assert.equal(accepted.phase, "AwaitingPublication");
      assert.equal((yield* instructions(accepted))!.records.length, 3);
    }).pipe(Effect.provide(layers)),
  );
});
