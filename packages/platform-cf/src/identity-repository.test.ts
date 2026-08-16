import { describe, expect, test } from "bun:test";
import { ControlPlaneDb } from "@pirate/application";
import type { IdentityAccountDocument } from "@pirate/application/use-cases/identity-account";
import { Effect } from "effect";
import {
  IdentityRepositoryError,
  makeControlPlaneIdentityRepository,
} from "./identity-repository.ts";

const account = (userId: string, handleId: string, label: string): IdentityAccountDocument => ({
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
    global_handle_id: handleId,
    primary_linked_handle_id: null,
    xmtp_inbox_id: null,
    created_at: "2026-08-16T12:00:00.000Z",
  },
  global_handle: {
    global_handle_id: handleId,
    label_display: label,
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

function fakeDb() {
  const statements: Array<{ readonly label: string; readonly values: readonly unknown[] }> = [];
  const execute: ControlPlaneDb["Service"]["execute"] = (statement) => {
    statements.push({ label: statement.label, values: statement.values });
    return Effect.succeed({ rows: [], rowCount: 0 });
  };
  const db: ControlPlaneDb["Service"] = {
    execute,
    withTransaction: (use) => use({ execute }),
  };
  return { db, statements };
}

describe("identity public-handle maintenance", () => {
  test("writes the account and current handle index in one transaction, redirecting a rename", async () => {
    const fake = fakeDb();
    const repository = makeControlPlaneIdentityRepository();
    await Effect.runPromise(
      repository
        .upsertAccount({
          userId: "usr_captain",
          account: account("usr_captain", "handle_new", "CaptainNew.pirate"),
        })
        .pipe(Effect.provideService(ControlPlaneDb, fake.db)),
    );
    expect(fake.statements.map(({ label }) => label)).toEqual([
      "identity.users.upsert-account",
      "identity.public-handles.upsert-current",
      "identity.public-handles.redirect-previous",
    ]);
    expect(fake.statements[1]?.values).toEqual([
      "handle_new",
      "captainnew",
      "captainnew.pirate",
      "usr_captain",
    ]);
    expect(fake.statements[2]?.values).toEqual(["usr_captain", "handle_new"]);
  });

  test("rejects malformed or non-canonical account documents before writing", async () => {
    const fake = fakeDb();
    const repository = makeControlPlaneIdentityRepository();
    const invalid = await Effect.runPromise(
      Effect.flip(
        repository
          .upsertAccount({ userId: "usr_captain", account: {} })
          .pipe(Effect.provideService(ControlPlaneDb, fake.db)),
      ),
    );
    expect(invalid).toBeInstanceOf(IdentityRepositoryError);
    expect(fake.statements).toHaveLength(0);
  });
});
