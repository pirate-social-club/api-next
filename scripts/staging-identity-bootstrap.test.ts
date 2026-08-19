import { describe, expect, test } from "bun:test";
import { runStagingIdentityBootstrap } from "./staging-identity-bootstrap";

const account = (userId: string) => ({
  user: {
    user_id: userId,
    primary_wallet_attachment_id: null,
    capability_provider: null,
    verification_capabilities_json: null,
    verified_at: null,
    created_at: "2026-08-16T12:00:00.000Z",
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

const environment = {
  API_NEXT_ENV: "staging",
};

const serialized = (userId = "usr_captain", accountUserId = userId) =>
  JSON.stringify({ user_id: userId, account: account(accountUserId) });

describe("staging identity bootstrap", () => {
  test("refuses every non-staging environment before reading input", async () => {
    await expect(
      runStagingIdentityBootstrap([], {
        environment: { API_NEXT_ENV: "production" },
        inputText: "not-read",
      }),
    ).rejects.toMatchObject({ code: "not-staging" });
  });

  test("rejects malformed and mismatched account documents", async () => {
    let malformedError: unknown;
    try {
      await runStagingIdentityBootstrap([], { environment, inputText: "{}" });
    } catch (error) {
      malformedError = error;
    }
    expect(malformedError).toMatchObject({ code: "invalid-input" });

    let mismatchedError: unknown;
    try {
      await runStagingIdentityBootstrap([], {
        environment,
        inputText: serialized("usr_outer", "usr_inner"),
      });
    } catch (error) {
      mismatchedError = error;
    }
    expect(mismatchedError).toMatchObject({ code: "invalid-input" });
  });

  test("defaults to a no-write dry run and emits only a digest", async () => {
    const result = await runStagingIdentityBootstrap([], {
      environment,
      inputText: serialized(),
    });
    expect(result).toMatchObject({ environment: "staging", mode: "dry-run", action: "validated" });
    expect(result.user_id_sha256).toHaveLength(64);
  });

  test("retires the apply mode instead of bypassing registration", async () => {
    await expect(
      runStagingIdentityBootstrap(["--apply"], {
        environment,
        inputText: serialized(),
      }),
    ).rejects.toMatchObject({ code: "invalid-options" });

    await expect(
      runStagingIdentityBootstrap(["--apply", "--confirm-staging"], {
        environment,
        inputText: serialized(),
      }),
    ).rejects.toMatchObject({ code: "invalid-options" });
  });
});
