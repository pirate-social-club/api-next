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
    return Effect.succeed({
      rows: [],
      rowCount: statement.label === "identity.public-handles.upsert-current" ? 1 : 0,
    });
  };
  const db: ControlPlaneDb["Service"] = {
    execute,
    withTransaction: (use) => use({ execute }),
  };
  return { db, statements };
}

function registrationDb(
  respond: (
    label: string,
    call: number,
  ) => { readonly rows: readonly unknown[]; readonly rowCount: number },
) {
  const labels: string[] = [];
  let call = 0;
  const execute: ControlPlaneDb["Service"]["execute"] = (statement) => {
    labels.push(statement.label);
    const result = respond(statement.label, call);
    call += 1;
    return Effect.succeed(result as { readonly rows: readonly never[]; readonly rowCount: number });
  };
  const db: ControlPlaneDb["Service"] = {
    execute,
    withTransaction: (use) => use({ execute }),
  };
  return { db, labels };
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
      "identity.public-handles.redirect-previous",
      "identity.public-handles.upsert-current",
    ]);
    expect(fake.statements[2]?.values).toEqual([
      "handle_new",
      "captainnew",
      "captainnew.pirate",
      "usr_captain",
    ]);
    expect(fake.statements[1]?.values).toEqual(["usr_captain", "handle_new"]);
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

describe("identity credential registration", () => {
  const input = {
    provider: "privy" as const,
    providerAppId: "privy-staging",
    providerSubject: "did:privy:subject",
    credentialId: "credential-new",
    userId: "user-new",
    account: account("user-new", "handle-new", "generated-new.pirate"),
  };

  test("creates the account, handle, and credential in one transaction", async () => {
    const fake = registrationDb((label) => ({
      rows: [],
      rowCount: label === "identity.credentials.read" ? 0 : 1,
    }));
    const result = await Effect.runPromise(
      makeControlPlaneIdentityRepository()
        .registerCredential(input)
        .pipe(Effect.provideService(ControlPlaneDb, fake.db)),
    );
    expect(result).toEqual({ kind: "created", canonicalUserId: "user-new" });
    expect(fake.labels).toEqual([
      "identity.registration.lock-credential",
      "identity.registration.insert-user",
      "identity.registration.insert-handle",
      "identity.registration.insert-credential",
    ]);
    expect(fake.labels.some((label) => label.includes("delete"))).toBe(false);
  });

  test("returns a tombstone without attempting account mutation", async () => {
    const fake = registrationDb(() => ({
      rows: [{ canonical_user_id: "user-old", status: "tombstoned", user_status: "deleted" }],
      rowCount: 1,
    }));
    const result = await Effect.runPromise(
      makeControlPlaneIdentityRepository()
        .registerCredential(input)
        .pipe(Effect.provideService(ControlPlaneDb, fake.db)),
    );
    expect(result).toEqual({ kind: "tombstoned" });
    expect(fake.labels).toEqual(["identity.registration.lock-credential"]);
  });

  test("classifies an unrelated credential-id conflict for bounded regeneration", async () => {
    const fake = registrationDb((label, call) => ({
      rows: [],
      rowCount: label === "identity.registration.insert-credential" || call === 0 ? 0 : 1,
    }));
    const result = await Effect.runPromise(
      makeControlPlaneIdentityRepository()
        .registerCredential(input)
        .pipe(Effect.provideService(ControlPlaneDb, fake.db)),
    );
    expect(result).toEqual({ kind: "candidate_collision", field: "credential_id" });
    expect(fake.labels.at(-1)).toBe("identity.credentials.read");
  });
});
