// Test setup only: genuine account registration creates the immutable owner
// in the SAME normal transaction as user/credential birth. No activity fallback,
// direct owner-row seed, guard bypass or alternate Study store is installed.
import { expect } from "bun:test";
import type { IdentityAccountDocument } from "@pirate/application/use-cases/identity-account";
import { Effect } from "effect";
import { makeControlPlaneIdentityRepository } from "./identity-repository.ts";
import type { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const account = (userId: string, label: string, createdAt: string): IdentityAccountDocument => ({
  user: {
    user_id: userId,
    primary_wallet_attachment_id: null,
    capability_provider: null,
    verification_capabilities_json: null,
    verified_at: null,
    created_at: createdAt,
  },
  profile: {
    user_id: userId,
    display_name: "Captain",
    bio: null,
    bio_source: "none",
    avatar_ref: null,
    avatar_source: "none",
    cover_ref: null,
    cover_source: "none",
    preferred_locale: "en",
    display_verified_nationality_badge: 0,
    global_handle_id: `handle-${userId}`,
    primary_linked_handle_id: null,
    xmtp_inbox_id: null,
    created_at: createdAt,
  },
  global_handle: {
    global_handle_id: `handle-${userId}`,
    label_display: `${label}.pirate`,
    status: "active",
    tier: "generated",
    issuance_source: "generated_signup",
    redirect_target_global_handle_id: null,
    price_paid_cents: null,
    free_rename_consumed: 0,
    issued_at: createdAt,
    replaced_at: null,
  },
  linked_handles: [],
  wallet_attachments: [],
  onboarding: {
    generated_handle_assigned: true,
    cleanup_rename_available: false,
    unique_human_verification_status: "not_started",
    namespace_verification_status: "not_started",
    community_creation_ready: false,
    missing_requirements: [],
    reddit_verification_status: "not_started",
    reddit_import_status: "not_started",
  },
});

export const makeOwnedOrdinaryAccountBirthFixture = (
  runtime: ReturnType<typeof makeDirectPostgresControlPlaneLayer>,
) => {
  const repository = makeControlPlaneIdentityRepository();
  return async (userId: string): Promise<void> => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        repository
          .registerCredential({
            provider: "privy",
            providerAppId: "owned-ordinary-study-fixture",
            providerSubject: `did:privy:owned-fixture-${userId}`,
            credentialId: `owned-fixture-credential-${userId}`,
            userId,
            account: account(userId, `fixture-${userId}`, new Date().toISOString()),
          })
          .pipe(Effect.provide(runtime)),
      ),
    );
    expect(outcome.kind).toBe("created");
    if (outcome.kind !== "created")
      throw new Error("Owned fixture account birth did not commit creation");
    expect(outcome.canonicalUserId).toBe(userId);
  };
};
