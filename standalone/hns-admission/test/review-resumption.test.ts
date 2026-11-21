import { test } from "node:test";
import assert from "node:assert/strict";
import { Clock, Effect, Layer } from "effect";
import { make } from "@alchemy.run/domain/InMemory";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  AdmissionModel,
  Ceremony,
  CreateCeremony,
  ApplyObservation,
} from "../src/model.ts";
import {
  create,
  consent,
  current,
  observe,
  HnsObserver,
} from "../src/service.ts";
import { handle, HttpAccess } from "../src/http.ts";
import { consentData } from "../src/protocol.ts";
import { advance } from "../src/ceremony.ts";
import { nextWake } from "../src/automation.ts";
import { binding, hash, state, observation } from "./fixtures.ts";

test("expired consent can be renewed while status polling keeps its revision stable", async () => {
  let now = 1000;
  const account = privateKeyToAccount(generatePrivateKey());
  const selected = { ...binding, controller: account.address.toLowerCase() };
  const memory = make({ manual: true, now: () => now * 1000 });
  const observer = Layer.succeed(
    HnsObserver,
    HnsObserver.of({
      baseline: () => Effect.succeed({ records: [], ownershipEpoch: hash }),
      observe: () =>
        Effect.succeed({ status: "unavailable", reason: "observer_timeout" }),
    }),
  );
  const live = Layer.merge(
    observer,
    AdmissionModel.layer(Layer.empty).pipe(Layer.provide(memory.layer)),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const actual = yield* Clock.Clock;
      const clock: Clock.Clock = Object.assign(Object.create(actual), {
        currentTimeMillisUnsafe: () => now * 1000,
        currentTimeMillis: Effect.sync(() => now * 1000),
      });
      yield* Effect.gen(function* () {
        const created = yield* create({
          binding: selected,
          idempotencyKey: hash,
        });
        const sign = (issuedAt: number, deadline: number) =>
          account.signTypedData(
            consentData(selected, {
              ceremonyId: created.id,
              bindingDigest: created.bindingDigest,
              resourceDigest: created.resourceDigest,
              nonce: created.nonce,
              issuedAt,
              deadline,
            }),
          );
        yield* consent(created.id, {
          expectedRevision: created.revision,
          issuedAt: now,
          deadline: 1001,
          signature: yield* Effect.promise(() => sign(now, 1001)),
        });
        now = 1002;
        const expired = yield* current(created.id);
        assert.equal(expired.condition, "consent_expired");
        const polled = [];
        for (let i = 0; i < 4; i++) {
          now++;
          polled.push(yield* current(created.id));
        }
        const renewed = yield* consent(created.id, {
          expectedRevision: expired.revision,
          issuedAt: now,
          deadline: now + 1000,
          signature: yield* Effect.promise(() => sign(now, now + 1000)),
        }).pipe(Effect.result);
        assert.equal(
          renewed._tag,
          "Success",
          "polling must not invalidate the revision the operator signed against",
        );
        assert.ok(polled.every((s) => s.revision === expired.revision));
      }).pipe(Effect.provide(live), Effect.provideService(Clock.Clock, clock));
    }),
  );
});

test("five authorized status reads perform zero observer reads", async () => {
  let baselineReads = 0;
  const observer = Layer.succeed(
    HnsObserver,
    HnsObserver.of({
      baseline: () =>
        Effect.sync(() => {
          baselineReads++;
          return { records: [], ownershipEpoch: hash };
        }),
      observe: () => Effect.die("status_must_not_observe"),
    }),
  );
  const memory = make();
  const access = Layer.succeed(
    HttpAccess,
    HttpAccess.of({ authorize: () => Effect.void }),
  );
  const live = Layer.mergeAll(
    observer,
    access,
    AdmissionModel.layer(Layer.empty).pipe(Layer.provide(memory.layer)),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const created = yield* create({ binding, idempotencyKey: hash });
      const model = yield* Ceremony;
      yield* model.send(
        created.id,
        new ApplyObservation({
          expectedRevision: created.revision,
          action: { type: "Consent", deadline: created.consentDeadline },
        }),
      );
      const before = baselineReads;
      for (let i = 0; i < 5; i++) {
        const reply = yield* handle(
          new Request(
            `https://admission.fixture.test/v1/ceremonies/${created.id}`,
          ),
        );
        assert.equal(reply.status, 200);
        const body = yield* Effect.promise(() => reply.json());
        assert.equal(body.operationId, created.id);
      }
      assert.equal(
        baselineReads,
        before,
        "status polling must read persisted progress, not both HSD nodes",
      );
    }).pipe(Effect.provide(live)),
  );
});

test("fresh mature evidence recovers the original ceremony after an outage across its maturity deadline", async () => {
  const now = 90000;
  let probes = 0;
  const memory = make({ manual: true, now: () => now * 1000 });
  const observer = Layer.succeed(
    HnsObserver,
    HnsObserver.of({
      baseline: () => Effect.die("unexpected_baseline"),
      observe: () =>
        Effect.sync(() => {
          probes++;
          return {
            status: "verified",
            observation: {
              ...observation(),
              inclusionTime: 1000,
              fetchedAt: now,
              tipTime: now,
            },
          };
        }),
    }),
  );
  const live = Layer.merge(
    observer,
    AdmissionModel.layer(Layer.empty).pipe(Layer.provide(memory.layer)),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const actual = yield* Clock.Clock;
      const clock: Clock.Clock = Object.assign(Object.create(actual), {
        currentTimeMillisUnsafe: () => now * 1000,
        currentTimeMillis: Effect.succeed(now * 1000),
      });
      yield* Effect.gen(function* () {
        const model = yield* Ceremony;
        yield* model.send(
          hash,
          new CreateCeremony({
            snapshot: {
              ...state(),
              phase: "Maturing",
              consented: true,
              firstIncludedAt: 1000,
              maturityDeadline: 87400,
              updatedAt: 80000,
            },
          }),
        );
        assert.equal((yield* current(hash)).phase, "Expired");
        const recovered = yield* observe(hash);
        assert.equal(probes, 1);
        assert.equal(recovered.phase, "ReadyToSubmit");
        assert.equal(recovered.challenge, state().challenge);
        assert.equal(
          recovered.publicationDeadline,
          state().publicationDeadline,
        );
      }).pipe(Effect.provide(live), Effect.provideService(Clock.Clock, clock));
    }),
  );
});

test("deadline recovery cannot revive cancellation, changed ownership or late publication", () => {
  const s = {
    ...state(),
    phase: "Cancelled" as const,
    consented: true,
    updatedAt: 90000,
  };
  const observed = {
    type: "Observed" as const,
    now: 90001,
    includedAt: 1000,
    ownershipEpoch: hash,
    safe: true,
    transferPending: false,
  };
  assert.equal(advance(s, observed).phase, "Cancelled");
  assert.notEqual(
    advance(
      { ...s, phase: "Expired", condition: "maturity_deadline" },
      { ...observed, ownershipEpoch: "0x" + "33".repeat(32) },
    ).phase,
    "ReadyToSubmit",
  );
  assert.notEqual(
    advance(
      { ...s, phase: "Expired", condition: "publication_deadline" },
      { ...observed, now: 200000, includedAt: 180000 },
    ).phase,
    "ReadyToSubmit",
  );
});

test("a backward clock read does not throw or reopen a deadline", () => {
  const s = { ...state(), updatedAt: 1000 };
  assert.deepEqual(advance(s, { type: "Tick", now: 999 }), s);
  assert.equal(
    nextWake({ ...s, consented: true, phase: "AwaitingPublication" }, 999),
    1001,
  );
});

test("expired maturity accepts renewed consent without extending publication or republishing", () => {
  const original = {
    ...state(),
    phase: "Expired" as const,
    condition: "maturity_deadline" as const,
    consented: false,
    consentDeadline: 80000,
    firstIncludedAt: 1000,
    maturityDeadline: 87400,
    updatedAt: 90000,
  };
  const renewed = advance(original, {
    type: "Consent",
    now: 90000,
    deadline: 91000,
  });
  assert.equal(renewed.phase, "Expired", "renewal alone is not fresh evidence");
  const ready = advance(renewed, {
    type: "Observed",
    now: 90001,
    includedAt: 1000,
    ownershipEpoch: hash,
    safe: true,
    transferPending: false,
  });
  assert.equal(ready.phase, "ReadyToSubmit");
  assert.equal(ready.challenge, original.challenge);
  assert.equal(ready.publicationDeadline, original.publicationDeadline);
  assert.equal(ready.maturityDeadline, original.maturityDeadline);
  assert.equal(
    advance(renewed, { type: "Cancel", now: 90001 }).phase,
    "Cancelled",
  );
});

test("observation reservation and retry preserve a known expiry across a backward clock", async () => {
  for (const available of [true, false]) {
    let now = 87402;
    const memory = make({ manual: true, now: () => now * 1000 });
    const observer = Layer.succeed(
      HnsObserver,
      HnsObserver.of({
        baseline: () => Effect.die("unexpected_baseline"),
        observe: () =>
          Effect.sync(() =>
            available
              ? {
                  status: "verified" as const,
                  observation: {
                    ...observation(),
                    inclusionTime: 1000,
                    fetchedAt: now,
                    tipTime: now,
                  },
                }
              : {
                  status: "unavailable" as const,
                  reason: "observer_timeout" as const,
                },
          ),
      }),
    );
    const live = Layer.merge(
      observer,
      AdmissionModel.layer(Layer.empty).pipe(Layer.provide(memory.layer)),
    );
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
                phase: "Maturing",
                consented: true,
                consentDeadline: 87401,
                firstIncludedAt: 1000,
                maturityDeadline: 87400,
                updatedAt: 87000,
              },
            }),
          );
          const expired = yield* current(hash);
          assert.equal(expired.phase, "Expired");
          assert.equal(expired.updatedAt, 87402);
          now = 87399;
          const result = yield* observe(hash);
          assert.notEqual(
            result.phase,
            "ReadyToSubmit",
            "known expired consent cannot become usable after rollback",
          );
          assert.ok(
            result.updatedAt >= expired.updatedAt,
            "reservation must preserve the durable time watermark",
          );
          assert.ok(
            result.nextObservationAt >= expired.updatedAt + 60,
            "retry scheduling must use monotonic effective time",
          );
        }).pipe(
          Effect.provide(live),
          Effect.provideService(Clock.Clock, clock),
        );
      }),
    );
  }
});
