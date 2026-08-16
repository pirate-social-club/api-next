import { describe, expect, test } from "bun:test";
import type { IdentityStore } from "@pirate/application";
import { AuthError } from "@pirate/contracts";
import { Cause, Effect, Exit, Result } from "effect";
import {
  type IdentityAccountDocument,
  IdentityAccountInvalid,
  projectIdentityAccount,
} from "./identity-account.ts";
import { getMyProfile } from "./profile.ts";
import { authenticateSession, authorizeSession } from "./session-authentication.ts";
import { makeSessionIdentityStore } from "./session-exchange.ts";

const accountDocument: IdentityAccountDocument = {
  user: {
    user_id: "usr_canonical",
    primary_wallet_attachment_id: "wallet_primary",
    capability_provider: "self",
    verification_capabilities_json: null,
    verified_at: null,
    created_at: "2026-08-16T12:00:00.000Z",
  },
  profile: {
    user_id: "usr_canonical",
    display_name: "Captain",
    bio: null,
    bio_source: "none",
    avatar_ref: null,
    avatar_source: "none",
    cover_ref: null,
    cover_source: "none",
    preferred_locale: "en",
    display_verified_nationality_badge: 0,
    global_handle_id: "handle_captain",
    primary_linked_handle_id: null,
    xmtp_inbox_id: null,
    created_at: "2026-08-16T12:00:00.000Z",
  },
  global_handle: {
    global_handle_id: "handle_captain",
    label_display: "captain.pirate",
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
      wallet_attachment_id: "wallet_primary",
      chain_namespace: "eip155:1",
      wallet_address_display: "0x1234",
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
    Effect.succeed(
      userId === "usr_canonical" ? { userId: "usr_canonical", account: accountDocument } : null,
    ),
  resolveCanonical: ({ sourceUserId }) =>
    Effect.succeed({
      sourceUserId,
      canonicalUserId: "usr_canonical",
      aliasPath: sourceUserId === "usr_canonical" ? [] : [sourceUserId],
    }),
};

function failureOf<A, E>(exit: Exit.Exit<A, E>): E {
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.findError(exit.cause);
  if (!Result.isSuccess(failure)) throw new Error("expected typed failure");
  return failure.success;
}

describe("identity account application boundary", () => {
  test("decodes JSONB input and applies the retained domain projections", () => {
    const projected = projectIdentityAccount({ userId: "usr_canonical", account: accountDocument });
    expect(projected).toMatchObject({
      user: { id: "usr_canonical", object: "user" },
      profile: {
        id: "usr_canonical",
        object: "profile",
        primary_wallet_address: "0x1234",
        global_handle: { label: "captain.pirate" },
      },
      wallet_attachments: [{ wallet_attachment: "wallet_primary", is_primary: true }],
    });
  });

  test("fails closed for malformed or cross-user account documents", () => {
    expect(() => projectIdentityAccount({ userId: "usr_canonical", account: {} })).toThrow(
      IdentityAccountInvalid,
    );
    expect(() => projectIdentityAccount({ userId: "usr_other", account: accountDocument })).toThrow(
      IdentityAccountInvalid,
    );
  });

  test("resolves aliases once and shares the same account projection with profile", async () => {
    const session = await Effect.runPromise(
      makeSessionIdentityStore(identityStore).resolve({ sourceUserId: "usr_source" }),
    );
    if (session === null) throw new Error("expected seeded session account");
    const profile = await Effect.runPromise(
      getMyProfile({ userId: session.canonicalUserId }, { identityStore }),
    );
    expect(session.canonicalUserId).toBe("usr_canonical");
    expect(session.profile).toEqual(profile);
  });

  test("authenticates one bearer session and rejects malformed authorization", async () => {
    const verifier = {
      verify: ({ token }: { readonly token: string; readonly requiredClassification: "user" }) =>
        token === "valid-token"
          ? Effect.succeed({
              userId: "usr_canonical",
              classification: "user" as const,
              scope: { tokens: ["pirate_app_session"] },
            })
          : Effect.fail(new Error("invalid")),
    };
    const session = await Effect.runPromise(
      authenticateSession({ authorization: "Bearer valid-token" }, { verifier }),
    );
    await Effect.runPromise(authorizeSession({ session, allowedKinds: ["user"] }));

    const rejected = await Effect.runPromiseExit(
      authenticateSession({ authorization: "bearer valid-token" }, { verifier }),
    );
    expect(failureOf(rejected)).toBeInstanceOf(AuthError);
  });
});
