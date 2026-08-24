import { describe, expect, test } from "bun:test";
import { startVerification } from "@pirate/application/verification";
import { Effect } from "effect";
import {
  makeStaticVerificationIntentResolver,
  PLATFORM_AGE_18_VERIFICATION_INTENT_ID,
} from "../verification-intent-resolver.ts";
import { makePlatformVerificationProviderRegistry } from "./provider-registry.ts";

describe("Self Pass start composition", () => {
  test("resolves a trusted intent through planning, hashing, reservation, and session start", async () => {
    const registry = await Effect.runPromise(
      makePlatformVerificationProviderRegistry({
        self_pass: {
          callback_origin: "https://api.pirate.test",
          app_name: "Pirate",
          mock_passport: false,
        },
      }),
    );
    const intents = makeStaticVerificationIntentResolver(registry.list(), "development");
    let reserved: Readonly<{ request_hash: string }> | undefined;
    const result = await Effect.runPromise(
      startVerification(
        {
          actor_id: "user-1",
          intent_id: PLATFORM_AGE_18_VERIFICATION_INTENT_ID,
          provider_id: "self.pass",
        },
        {
          registry,
          intents,
          store: {
            reserve: ({ start }) => {
              reserved = start;
              return Effect.succeed({
                kind: "acquired" as const,
                reservation: {
                  reservation_id: start.request_hash,
                  fence_token: 1,
                  lease_expires_at: "2099-08-17T00:00:00.000Z",
                },
              });
            },
            finalize: (_reservation, start) => Effect.succeed({ kind: "created" as const, start }),
            release: () => Effect.succeed(undefined),
          },
        },
      ),
    );
    expect(reserved).toMatchObject({
      actor_id: "user-1",
      intent_id: PLATFORM_AGE_18_VERIFICATION_INTENT_ID,
      method: "document",
      requested_requirements: [
        { claim_id: "age.minimum", minimum_age: "18" },
        { claim_id: "credential.subject_unique" },
        { claim_id: "document.valid" },
      ],
      requested_claim_ids: ["age.minimum", "credential.subject_unique", "document.valid"],
      scope: { issuer: "self.pass", rp_scope: "pirate-social" },
    });
    expect(reserved?.request_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(result).toMatchObject({
      provider_id: "self.pass",
      replayed: false,
      presentation: {
        kind: "embedded_sdk",
        protocol: "self",
        payload: {
          endpoint: "https://api.pirate.test/verification/callbacks/self.pass",
          endpoint_type: "https",
          disclosures: { minimum_age: 18 },
          dev_mode: false,
        },
      },
    });
  });
});
