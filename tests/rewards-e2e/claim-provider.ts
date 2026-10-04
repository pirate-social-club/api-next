import {
  type VerificationProviderAdapter,
  VerificationProviderRejected,
} from "@pirate/application/verification";
import { Effect } from "effect";
import { makeRewardClaimVeryStub } from "../../packages/testing/src/verification/reward-claim-stub.ts";

export const simulatedClaimLabel = "SIMULATED_REWARDS_CLAIM_VERIFICATION";

function allowed(environment: string, intentId: string): boolean {
  return environment === "development" && /^reward-claim_[a-f0-9-]{36}$/i.test(intentId);
}

function rejected(operation: "start" | "complete") {
  return new VerificationProviderRejected({ provider_id: "very.web", operation });
}

/** Imported exclusively by the isolated test entrypoint, never by normal Workers. */
export function makeIsolatedRewardClaimProvider(): VerificationProviderAdapter {
  const template = makeRewardClaimVeryStub("0".repeat(64));
  return {
    manifest: { ...template.manifest, environments: ["development"] },
    plan: (input) =>
      input.environment === "development"
        ? template.plan(input)
        : Effect.succeed({ status: "unsupported" as const }),
    start: (input) => {
      if (!allowed(input.environment, input.intent_id)) return Effect.fail(rejected("start"));
      return template.start(input).pipe(
        Effect.map((result) => ({
          ...result,
          presentation: {
            ...result.presentation,
            payload: { fixture: true, simulated_verification: simulatedClaimLabel },
          },
        })),
      );
    },
    complete: (input) => {
      if (!allowed(input.session.environment, input.session.intent_id)) {
        return Effect.fail(rejected("complete"));
      }
      const actor = input.session.actor_id;
      return Effect.tryPromise({
        try: async () => {
          const digest = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(`pirate.rewards.e2e.simulated-claim.v1\0${actor}`),
          );
          return Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
        },
        catch: () => rejected("complete"),
      }).pipe(Effect.flatMap((digest) => makeRewardClaimVeryStub(digest).complete(input)));
    },
  };
}
