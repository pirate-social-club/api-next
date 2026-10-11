import { expect, test } from "bun:test";
import { VerificationProviderStartInput } from "@pirate/application/verification";
import { VERY_WEB_CONFIGURATION_REFERENCE, VERY_WEB_CONFIGURATION_VERSION } from "@pirate/domain";
import { veryHumanMembershipPlan } from "@pirate/platform-cf/community-join-intent-resolver";
import { Cause, Effect, Exit, Result, Schema } from "effect";
import { makeIsolatedRewardClaimProvider } from "../../tests/rewards-e2e/claim-provider.ts";

async function expectRejected<A, E>(effect: Effect.Effect<A, E>) {
  const exit = await Effect.runPromiseExit(effect);
  if (!Exit.isFailure(exit)) throw new Error("Expected claim verification to refuse");
  const failure = Cause.findError(exit.cause);
  if (!Result.isSuccess(failure)) throw new Error("Expected a typed provider rejection");
  expect(failure.success).toMatchObject({ _tag: "VerificationProviderRejected" });
}

function startInput(actorId = "fixture-participant") {
  const plan = veryHumanMembershipPlan("development");
  if (typeof plan !== "object" || plan === null) throw new Error("Missing claim plan");
  return Schema.decodeUnknownSync(VerificationProviderStartInput)({
    ...plan,
    actor_id: actorId,
    intent_id: "reward-claim_00000000-0000-4000-8000-000000000001",
    request_hash: "a".repeat(64),
    request_mode: "dynamic",
    provider_configuration: {
      kind: "dynamic",
      reference: VERY_WEB_CONFIGURATION_REFERENCE,
      version: VERY_WEB_CONFIGURATION_VERSION,
    },
  });
}

test("the stub cannot issue a community membership or profile verification", async () => {
  const adapter = makeIsolatedRewardClaimProvider();
  for (const intent_id of ["community-join_fixture", "profile_fixture"]) {
    await expectRejected(adapter.start({ ...startInput(), intent_id }));
  }
});

test("staging and production cannot start a simulated claim ceremony", async () => {
  const adapter = makeIsolatedRewardClaimProvider();
  for (const environment of ["staging", "production"]) {
    await expectRejected(adapter.start({ ...startInput(), environment }));
  }
});

test("a simulated claim is labelled and binds a stable subject to its actor", async () => {
  const adapter = makeIsolatedRewardClaimProvider();
  const complete = async (actor: string) => {
    const start = await Effect.runPromise(adapter.start(startInput(actor)));
    if (start.presentation.kind !== "embedded_sdk")
      throw new Error("Expected embedded claim fixture");
    expect(start.presentation.payload).toEqual({
      fixture: true,
      simulated_verification: "SIMULATED_REWARDS_CLAIM_VERIFICATION",
    });
    const bundle = await Effect.runPromise(
      adapter.complete({
        session: start.session,
        submission: { channel: "client_result", payload: { fixture: true } },
      }),
    );
    return bundle.subject_keys[0]?.subject_digest;
  };
  const first = await complete("fixture-study");
  expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(await complete("fixture-study")).toBe(first);
  expect(await complete("fixture-karaoke")).not.toBe(first);
});

test("completion refuses a session outside the isolated environment", async () => {
  const adapter = makeIsolatedRewardClaimProvider();
  const start = await Effect.runPromise(adapter.start(startInput()));
  await expectRejected(
    adapter.complete({
      session: { ...start.session, environment: "staging" },
      submission: { channel: "client_result", payload: { fixture: true } },
    }),
  );
});
