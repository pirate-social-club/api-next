import { afterAll, describe, expect, test } from "bun:test";
import { getPublicProfileByHandle } from "@pirate/application/use-cases/public-profile";
import { Effect } from "effect";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeControlPlaneIdentityStore } from "./identity-repository.ts";
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

suite("Postgres 17 public profile by handle", () => {
  test("maintains current and redirect labels, returns creators, and uses the handle index", async () => {
    await withSchema(async (connection, admin) => {
      await runPostgresMigrations({ connectionString: connection });
      const runtime = makeDirectPostgresControlPlaneLayer(connection);
      const identityStore = makeControlPlaneIdentityStore(runtime);
      const publicProfileStore = makeControlPlanePublicProfileStore(runtime, identityStore);

      await Effect.runPromise(
        identityStore.upsertAccount?.({
          userId: "usr_public",
          account: account("usr_public", "handle_old", "oldcaptain.pirate"),
        }) ?? Effect.die("identity upsert is not installed"),
      );
      await Effect.runPromise(
        identityStore.upsertAccount?.({
          userId: "usr_public",
          account: account("usr_public", "handle_new", "captainpublic.pirate"),
        }) ?? Effect.die("identity upsert is not installed"),
      );
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
      expect(current.profile.id).toBe("usr_public");
      expect(
        current.created_communities.map(({ community, display_name }) => ({
          community,
          display_name,
        })),
      ).toEqual([
        { community: "community-beta", display_name: "Beta Club" },
        { community: "community-alpha", display_name: "Alpha Club" },
      ]);

      const redirected = await Effect.runPromise(
        getPublicProfileByHandle({ handle: "oldcaptain" }, { publicProfileStore }),
      );
      expect(redirected.is_canonical).toBe(false);
      expect(redirected.profile).toEqual(current.profile);
      expect(redirected.resolved_handle_label).toBe("captainpublic.pirate");

      const upsertAccount = identityStore.upsertAccount;
      if (upsertAccount === undefined) throw new Error("identity upsert is not installed");
      await expect(
        Effect.runPromise(
          upsertAccount({
            userId: "usr_collision",
            account: account("usr_collision", "handle_collision", "captainpublic.pirate"),
          }),
        ),
      ).rejects.toMatchObject({ _tag: "ControlPlaneStatementFailed" });
      const rolledBack = await admin.query<{ readonly count: string }>(
        "SELECT count(*)::text AS count FROM users WHERE user_id = 'usr_collision'",
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

  test("redacts deleted users and unresolved aliases as not found, but corrupt accounts as internal", async () => {
    await withSchema(async (connection, admin) => {
      await runPostgresMigrations({ connectionString: connection });
      const runtime = makeDirectPostgresControlPlaneLayer(connection);
      const identityStore = makeControlPlaneIdentityStore(runtime);
      const publicProfileStore = makeControlPlanePublicProfileStore(runtime, identityStore);
      await Effect.runPromise(
        identityStore.upsertAccount?.({
          userId: "usr_deleted",
          account: account("usr_deleted", "handle_deleted", "deletedcaptain.pirate"),
        }) ?? Effect.die("identity upsert is not installed"),
      );
      await admin.query("UPDATE users SET status = 'deleted' WHERE user_id = 'usr_deleted'");
      await expect(
        Effect.runPromise(
          getPublicProfileByHandle({ handle: "deletedcaptain" }, { publicProfileStore }),
        ),
      ).rejects.toMatchObject({ _tag: "NotFound" });

      await admin.query("INSERT INTO users (user_id, account) VALUES ('usr_corrupt', '{}'::jsonb)");
      await admin.query(
        `INSERT INTO public_handle_index
          (handle_id, label_normalized, label_display, status, owner_user_id)
         VALUES ('handle_corrupt', 'corruptcaptain', 'corruptcaptain.pirate', 'active', 'usr_corrupt')`,
      );
      await expect(
        Effect.runPromise(
          getPublicProfileByHandle({ handle: "corruptcaptain" }, { publicProfileStore }),
        ),
      ).rejects.toMatchObject({ _tag: "InternalError" });
    });
    completedTestCount += 1;
  });

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === 2) {
      await Bun.write(sentinelPath, sentinelContents);
    }
  });
});
