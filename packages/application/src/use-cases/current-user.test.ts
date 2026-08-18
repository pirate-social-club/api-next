import { describe, expect, test } from "bun:test";
import type { IdentityStore } from "@pirate/application";
import { AuthError, InternalError } from "@pirate/contracts";
import { Effect } from "effect";
import { getCurrentUser } from "./current-user.ts";
import type { IdentityAccountDocument } from "./identity-account.ts";

const account: IdentityAccountDocument = {
  user: {
    user_id: "usr_current",
    primary_wallet_attachment_id: "wallet_current",
    capability_provider: null,
    verification_capabilities_json: null,
    verified_at: null,
    created_at: "2026-08-16T12:00:00.000Z",
  },
  profile: {
    user_id: "usr_current",
    display_name: "Current Captain",
    bio: null,
    bio_source: "none",
    avatar_ref: null,
    avatar_source: "none",
    cover_ref: null,
    cover_source: "none",
    preferred_locale: "en",
    display_verified_nationality_badge: 0,
    global_handle_id: "handle_current",
    primary_linked_handle_id: null,
    xmtp_inbox_id: null,
    created_at: "2026-08-16T12:00:00.000Z",
  },
  global_handle: {
    global_handle_id: "handle_current",
    label_display: "current.pirate",
    status: "active",
    tier: "generated",
    issuance_source: "generated_signup",
    redirect_target_global_handle_id: null,
    price_paid_cents: null,
    free_rename_consumed: 0,
    issued_at: "2026-08-16T12:00:00.000Z",
    replaced_at: null,
  },
  linked_handles: [],
  wallet_attachments: [
    {
      wallet_attachment_id: "wallet_current",
      chain_namespace: "eip155:1",
      wallet_address_display: "0xcurrent",
      is_primary: 1,
    },
  ],
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
};

const identityStore: IdentityStore["Service"] = {
  findUser: (userId) =>
    Effect.succeed(userId === "usr_current" ? { userId: "usr_current", account } : null),
  resolveCanonical: ({ sourceUserId }) =>
    Effect.succeed({ sourceUserId, canonicalUserId: sourceUserId, aliasPath: [] }),
};

describe("getCurrentUser", () => {
  test("returns the identity projection without a community query", async () => {
    const result = await Effect.runPromise(
      getCurrentUser({ userId: "usr_current" }, { identityStore }),
    );

    expect(result).toMatchObject({
      id: "usr_current",
      object: "user",
      primary_wallet_attachment: "wallet_current",
    });
    expect(result).toEqual(
      expect.not.objectContaining({ community_posting_state: expect.anything() }),
    );
  });

  test("fails closed for an invalid or missing identity", async () => {
    await expect(
      Effect.runPromise(Effect.flip(getCurrentUser({ userId: " usr_current" }, { identityStore }))),
    ).resolves.toBeInstanceOf(AuthError);
    await expect(
      Effect.runPromise(Effect.flip(getCurrentUser({ userId: "usr_missing" }, { identityStore }))),
    ).resolves.toBeInstanceOf(AuthError);
  });

  test("redacts projection corruption as an internal error", async () => {
    const malformed: IdentityStore["Service"] = {
      ...identityStore,
      findUser: () => Effect.succeed({ userId: "usr_current", account: {} }),
    };
    await expect(
      Effect.runPromise(
        Effect.flip(getCurrentUser({ userId: "usr_current" }, { identityStore: malformed })),
      ),
    ).resolves.toBeInstanceOf(InternalError);
  });
});
