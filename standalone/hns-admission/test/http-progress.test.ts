import { test } from "node:test";
import assert from "node:assert/strict";
import * as Domain from "@alchemy.run/domain";
import { Effect, Layer } from "effect";
import { AdmissionModel, Ceremony, CreateCeremony } from "../src/model.ts";
import { handle, HttpAccess } from "../src/http.ts";
import { HnsObserver, AdmissionError } from "../src/service.ts";
import { state, hash } from "./fixtures.ts";
import { bindingDigest, consentData } from "../src/protocol.ts";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

test("corrupt retained publication data preserves resumable operation identity", async () => {
  const observer = Layer.succeed(
    HnsObserver,
    HnsObserver.of({
      baseline: () =>
        Effect.fail(new AdmissionError({ reason: "observer_timeout" })),
      observe: () =>
        Effect.succeed({ status: "unavailable", reason: "observer_timeout" }),
    }),
  );
  const access = Layer.succeed(
    HttpAccess,
    HttpAccess.of({ authorize: () => Effect.void }),
  );
  const live = Layer.mergeAll(
    observer,
    access,
    AdmissionModel.layer(Layer.empty).pipe(Layer.provide(Domain.InMemory)),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const model = yield* Ceremony,
        now = Math.floor(Date.now() / 1000);
      const retained = {
        ...state(),
        phase: "AwaitingPublication" as const,
        consented: true,
        publicationDeadline: now + 172800,
        consentDeadline: now + 259200,
      };
      yield* model.send(hash, new CreateCeremony({ snapshot: retained }));
      for (const kind of ["ceremonies", "operations"]) {
        const response = yield* handle(
          new Request(`https://admission.fixture.test/v1/${kind}/${hash}`),
        );
        assert.equal(response.status, 503);
        const body = yield* Effect.promise(() => response.json());
        assert.equal(body.status, "unavailable");
        assert.equal(body.reason, "internal_error");
        assert.equal(body.operationId, hash);
        assert.equal(body.phase, retained.phase);
        assert.equal(body.revision, retained.revision);
        assert.equal(body.publicationDeadline, retained.publicationDeadline);
        assert.equal(body.consentDeadline, retained.consentDeadline);
        assert.equal(body.bindingDigest, retained.bindingDigest);
      }
      assert.equal((yield* model.get(hash))!.phase, retained.phase);
    }).pipe(Effect.provide(live)),
  );
});

test("an unavailable consent preflight retains the original nonce and retryable revision", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const binding = {
    ...state().binding,
    controller: account.address.toLowerCase(),
  };
  let baselineCalls = 0;
  const observer = Layer.succeed(
    HnsObserver,
    HnsObserver.of({
      baseline: () =>
        ++baselineCalls === 1
          ? Effect.succeed({ records: [], ownershipEpoch: hash })
          : Effect.fail(new AdmissionError({ reason: "observer_timeout" })),
      observe: () =>
        Effect.succeed({ status: "unavailable", reason: "observer_timeout" }),
    }),
  );
  const access = Layer.succeed(
    HttpAccess,
    HttpAccess.of({ authorize: () => Effect.void }),
  );
  const live = Layer.mergeAll(
    observer,
    access,
    AdmissionModel.layer(Layer.empty).pipe(Layer.provide(Domain.InMemory)),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const post = (path: string, body: unknown) =>
        new Request("https://admission.fixture.test" + path, {
          method: "POST",
          body: JSON.stringify(body),
        });
      const createdResponse = yield* handle(
        post("/v1/ceremonies", { idempotencyKey: hash, binding }),
      );
      assert.equal(createdResponse.status, 202);
      const created = yield* Effect.promise(() => createdResponse.json());
      const issuedAt = created.consent.createdAt;
      const signature = yield* Effect.promise(() =>
        account.signTypedData(
          consentData(binding, {
            ceremonyId: created.operationId,
            bindingDigest: bindingDigest(binding),
            resourceDigest: created.consent.resourceDigest,
            nonce: created.consent.nonce,
            issuedAt,
            deadline: created.consentDeadline,
          }),
        ),
      );
      const response = yield* handle(
        post(`/v1/ceremonies/${created.operationId}/consent`, {
          expectedRevision: created.revision,
          issuedAt,
          deadline: created.consentDeadline,
          signature,
        }),
      );
      assert.equal(response.status, 503);
      const body = yield* Effect.promise(() => response.json());
      assert.equal(body.operationId, created.operationId);
      assert.equal(body.revision, created.revision);
      assert.equal(body.phase, "AwaitingConsent");
      assert.equal(body.reason, "observer_timeout");
      const model = yield* Ceremony,
        retained = (yield* model.get(created.operationId))!;
      assert.equal(retained.revision, body.revision);
      assert.equal(retained.consented, false);
      assert.equal(retained.nonce, created.consent.nonce);
    }).pipe(Effect.provide(live)),
  );
});
