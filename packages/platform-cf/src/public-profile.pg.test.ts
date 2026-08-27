import { afterAll, describe, expect, test } from "bun:test";
import { getPublicProfileByHandle } from "@pirate/application/use-cases/public-profile";
import { platformPirateHandleStateV1Hash, platformPirateLabelPolicyV1 } from "@pirate/domain";
import { Effect } from "effect";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeControlPlaneIdentityStore } from "./identity-repository.ts";
import { createWalletBackedAccountFixture } from "./persona-wallet.pg-fixture.ts";
import { makeControlPlanePlatformPirateHandleStore } from "./platform-pirate-handle-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlanePublicProfileStore } from "./public-profile-repository.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_PUBLIC_PROFILE_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-public-profile-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-public-profile-suite-complete\n";
let completedTestCount = 0;

const schemaIdentifier = (): string =>
  `api_next_public_profile_${crypto.randomUUID().replaceAll("-", "")}`;
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const connectionForSchema = (raw: string, schema: string): string => {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
};

const account = (userId: string, handleId: string, label: string) => ({
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
    display_name: "Public Captain",
    bio: "A public bio",
    bio_source: "manual",
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
    tier: "standard",
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

async function withSchema<A>(use: (connection: string, admin: Client) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = schemaIdentifier();
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  try {
    return await use(connectionForSchema(connectionString, schema), admin);
  } finally {
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

async function expectDeferredFailure(
  admin: Client,
  text: string,
  values: readonly unknown[],
  code: string,
): Promise<void> {
  await admin.query("BEGIN");
  try {
    await admin.query({ text, values: [...values] });
    await expect(admin.query("COMMIT")).rejects.toMatchObject({ code });
  } finally {
    await admin.query("ROLLBACK").catch(() => undefined);
  }
}

suite("Postgres 17 public profile by handle", () => {
  test("maintains current and redirect labels, returns creators, and uses the handle index", async () => {
    await withSchema(async (connection, admin) => {
      await runPostgresMigrations({ connectionString: connection });
      const runtime = makeDirectPostgresControlPlaneLayer(connection);
      const identityStore = makeControlPlaneIdentityStore(runtime);
      const publicProfileStore = makeControlPlanePublicProfileStore(runtime, identityStore);

      await createWalletBackedAccountFixture(admin, {
        userId: "usr_public",
        account: account("usr_public", "handle_old", "new-0123456789abcdefabcd.pirate"),
      });
      const owner = (
        await admin.query<{ persona_id: string }>(
          "SELECT persona_id FROM personas WHERE account_id='usr_public' AND is_first_persona",
        )
      ).rows[0]?.persona_id;
      if (owner === undefined) throw new Error("missing first public-profile persona");
      const renameStore = makeControlPlanePlatformPirateHandleStore(runtime);
      const renamed = await Effect.runPromise(
        renameStore.rename({
          accountId: "usr_public",
          personaId: owner,
          platformHandleId: "handle_old",
          expectedStateHash: platformPirateHandleStateV1Hash({
            platform_handle_id: "handle_old",
            owner_persona_id: owner,
            generation: 1,
            handle_label: "new-0123456789abcdefabcd",
            state: "active",
            cleanup_rename_consumed: false,
            redirect_to_label: null,
          }).sha256,
          desiredLabel: "captainpublic",
          confusabilityKey: "captainpublic",
          desiredLabelValid: true,
          policy: platformPirateLabelPolicyV1(),
          idempotencyKey: "public-profile-cleanup",
          requestHash: "a".repeat(64),
        }),
      );
      expect(renamed.kind).toBe("renamed");
      await admin.query(
        `INSERT INTO communities
           (community_id, display_name, created_by_user_id, created_at, updated_at)
         VALUES ('community-alpha', 'Alpha Club', 'usr_public', '2026-04-17T00:00:00Z', now()),
                ('community-beta', 'Beta Club', 'usr_public', '2026-04-18T00:00:00Z', now()),
                ('community-hidden', 'Hidden Club', 'usr_public', '2026-04-19T00:00:00Z', now())`,
      );
      await admin.query(
        "UPDATE communities SET status = 'hidden' WHERE community_id = 'community-hidden'",
      );

      const current = await Effect.runPromise(
        getPublicProfileByHandle({ handle: "@@CAPTAINPUBLIC.PIRATE" }, { publicProfileStore }),
      );
      expect(current.is_canonical).toBe(true);
      expect(current.requested_handle_label).toBe("captainpublic.pirate");
      expect(current.resolved_handle_label).toBe("captainpublic.pirate");
      expect(current.profile.id).toBe(owner);
      expect(current.created_communities).toEqual([]);

      const redirected = await Effect.runPromise(
        getPublicProfileByHandle({ handle: "new-0123456789abcdefabcd" }, { publicProfileStore }),
      );
      expect(redirected.is_canonical).toBe(false);
      expect(redirected.profile).toEqual(current.profile);
      expect(redirected.resolved_handle_label).toBe("captainpublic.pirate");

      await createWalletBackedAccountFixture(admin, {
        userId: "usr_collision",
        account: account(
          "usr_collision",
          "handle_collision_seed",
          "new-11111111111111111111.pirate",
        ),
      });
      const collisionOwner = (
        await admin.query<{ persona_id: string }>(
          "SELECT persona_id FROM personas WHERE account_id='usr_collision' AND is_first_persona",
        )
      ).rows[0]?.persona_id;
      if (collisionOwner === undefined) throw new Error("missing collision persona");
      const collision = await Effect.runPromise(
        renameStore.rename({
          accountId: "usr_collision",
          personaId: collisionOwner,
          platformHandleId: "handle_collision_seed",
          expectedStateHash: platformPirateHandleStateV1Hash({
            platform_handle_id: "handle_collision_seed",
            owner_persona_id: collisionOwner,
            generation: 1,
            handle_label: "new-11111111111111111111",
            state: "active",
            cleanup_rename_consumed: false,
            redirect_to_label: null,
          }).sha256,
          desiredLabel: "captainpublic",
          confusabilityKey: "captainpublic",
          desiredLabelValid: true,
          policy: platformPirateLabelPolicyV1(),
          idempotencyKey: "public-profile-collision",
          requestHash: "b".repeat(64),
        }),
      );
      expect(collision).toEqual({ kind: "handle_unavailable" });
      const rolledBack = await admin.query<{ readonly count: string }>(
        `SELECT count(*)::text AS count FROM public_handle_index
          WHERE owner_user_id='usr_collision' AND label_normalized='captainpublic'`,
      );
      expect(rolledBack.rows[0]?.count).toBe("0");

      await admin.query("SET enable_seqscan = off");
      const explain = await admin.query<{ readonly plan: unknown }>(
        `EXPLAIN (FORMAT JSON)
         SELECT handle_id FROM public_handle_index
          WHERE label_normalized = 'captainpublic'
          LIMIT 1`,
      );
      expect(JSON.stringify(explain.rows)).toContain("public_handle_index_label_normalized_uidx");
    });
    completedTestCount += 1;
  });

  test("redacts deleted accounts and unresolved aliases as not found", async () => {
    await withSchema(async (connection, admin) => {
      await runPostgresMigrations({ connectionString: connection });
      const runtime = makeDirectPostgresControlPlaneLayer(connection);
      const identityStore = makeControlPlaneIdentityStore(runtime);
      const publicProfileStore = makeControlPlanePublicProfileStore(runtime, identityStore);
      await createWalletBackedAccountFixture(admin, {
        userId: "usr_deleted",
        account: account("usr_deleted", "handle_deleted", "deletedcaptain.pirate"),
      });
      await admin.query("UPDATE users SET status = 'deleted' WHERE user_id = 'usr_deleted'");
      await expect(
        Effect.runPromise(
          getPublicProfileByHandle({ handle: "deletedcaptain" }, { publicProfileStore }),
        ),
      ).rejects.toMatchObject({ _tag: "NotFound" });
    });
    completedTestCount += 1;
  });

  test("enforces active ownership and direct same-owner redirect history at commit", async () => {
    await withSchema(async (connection, admin) => {
      await runPostgresMigrations({ connectionString: connection });
      const runtime = makeDirectPostgresControlPlaneLayer(connection);
      const identityStore = makeControlPlaneIdentityStore(runtime);
      const upsertAccount = identityStore.upsertAccount;
      if (upsertAccount === undefined) throw new Error("identity upsert is not installed");

      await createWalletBackedAccountFixture(admin, {
        userId: "usr_owner",
        account: account("usr_owner", "handle_owned", "ownedcaptain.pirate"),
      });
      await Effect.runPromise(
        upsertAccount({
          userId: "usr_owner",
          account: account("usr_owner", "handle_owned", "ownedcaptain.pirate"),
        }),
      );
      await expect(
        Effect.runPromise(
          upsertAccount({
            userId: "usr_other",
            account: account("usr_other", "handle_owned", "intrudercaptain.pirate"),
          }),
        ),
      ).rejects.toMatchObject({ _tag: "IdentityResolutionError", reason: "invalid" });
      const unchanged = await admin.query<{
        readonly owner_user_id: string;
        readonly label_normalized: string;
        readonly status: string;
      }>(
        `SELECT owner_user_id, label_normalized, status
           FROM public_handle_index WHERE handle_id = 'handle_owned'`,
      );
      expect(unchanged.rows).toEqual([
        { owner_user_id: "usr_owner", label_normalized: "ownedcaptain", status: "active" },
      ]);
      expect(
        (await admin.query("SELECT user_id FROM users WHERE user_id = 'usr_other'")).rows,
      ).toEqual([]);

      await admin.query(
        `INSERT INTO users (user_id, account) VALUES
          ('usr_foreign', '{}'::jsonb), ('usr_cycle', '{}'::jsonb)`,
      );
      const ownerPersona = (
        await admin.query<{ persona_id: string }>(
          "SELECT persona_id FROM personas WHERE account_id='usr_owner' AND is_first_persona",
        )
      ).rows[0]?.persona_id;
      if (ownerPersona === undefined) throw new Error("missing owner persona");
      await admin.query(
        `INSERT INTO public_handle_index
          (handle_id, label_normalized, label_display, status, owner_user_id,owner_persona_id,
           platform_handle_id,generation)
         SELECT 'handle_foreign','foreigncaptain','foreigncaptain.pirate','active',
                'usr_foreign',persona_id,'handle_foreign',1
           FROM personas WHERE account_id='usr_foreign' AND is_first_persona`,
      );
      await admin.query(
        `INSERT INTO public_handle_index
          (handle_id, label_normalized, label_display, status, owner_user_id,owner_persona_id,
           platform_handle_id,generation)
         VALUES ('handle_retired', 'retiredcaptain', 'retiredcaptain.pirate', 'retired',
                 'usr_owner',$1,'handle_owned',2)`,
        [ownerPersona],
      );

      await expectDeferredFailure(
        admin,
        `INSERT INTO public_handle_index
          (handle_id, label_normalized, label_display, status, owner_user_id, redirect_target_handle_id)
         VALUES ($1, $2, $3, 'redirect', $4, $5)`,
        [
          "handle_missing_source",
          "missingcaptain",
          "missingcaptain.pirate",
          "usr_owner",
          "handle_missing_target",
        ],
        "23503",
      );
      await expectDeferredFailure(
        admin,
        `INSERT INTO public_handle_index
          (handle_id, label_normalized, label_display, status, owner_user_id, redirect_target_handle_id)
         VALUES ($1, $2, $3, 'redirect', $4, $5)`,
        [
          "handle_retired_source",
          "retiredsource",
          "retiredsource.pirate",
          "usr_owner",
          "handle_retired",
        ],
        "23514",
      );
      await expectDeferredFailure(
        admin,
        `INSERT INTO public_handle_index
          (handle_id, label_normalized, label_display, status, owner_user_id, redirect_target_handle_id)
         VALUES ($1, $2, $3, 'redirect', $4, $5)`,
        [
          "handle_foreign_source",
          "foreignsource",
          "foreignsource.pirate",
          "usr_owner",
          "handle_foreign",
        ],
        "23514",
      );
      await expectDeferredFailure(
        admin,
        `INSERT INTO public_handle_index
          (handle_id, label_normalized, label_display, status, owner_user_id, redirect_target_handle_id)
         VALUES
          ('handle_cycle2_a', 'cycle2a', 'cycle2a.pirate', 'redirect', 'usr_cycle', 'handle_cycle2_b'),
          ('handle_cycle2_b', 'cycle2b', 'cycle2b.pirate', 'redirect', 'usr_cycle', 'handle_cycle2_a')`,
        [],
        "23503",
      );
      await expectDeferredFailure(
        admin,
        `INSERT INTO public_handle_index
          (handle_id, label_normalized, label_display, status, owner_user_id, redirect_target_handle_id)
         VALUES
          ('handle_cycle3_a', 'cycle3a', 'cycle3a.pirate', 'redirect', 'usr_cycle', 'handle_cycle3_b'),
          ('handle_cycle3_b', 'cycle3b', 'cycle3b.pirate', 'redirect', 'usr_cycle', 'handle_cycle3_c'),
          ('handle_cycle3_c', 'cycle3c', 'cycle3c.pirate', 'redirect', 'usr_cycle', 'handle_cycle3_a')`,
        [],
        "23503",
      );
    });
    completedTestCount += 1;
  });

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === 3) {
      await Bun.write(sentinelPath, sentinelContents);
    }
  });
});
