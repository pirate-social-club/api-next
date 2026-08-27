import { afterAll, describe, expect, test } from "bun:test";
import { projectIdentityAccount } from "@pirate/application/use-cases/identity-account";
import { getPublicProfileByHandle } from "@pirate/application/use-cases/public-profile";
import { platformPirateHandleStateV1Hash } from "@pirate/domain";
import { Effect } from "effect";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeControlPlaneIdentityStore } from "./identity-repository.ts";
import {
  createActivePersonaFixture,
  createWalletBackedAccountFixture,
} from "./persona-wallet.pg-fixture.ts";
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
  process.env.CONTROL_PLANE_POSTGRES_PLATFORM_PIRATE_RENAME_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-platform-pirate-rename-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-platform-pirate-rename-suite-complete\n";
let completed = 0;
const testCount = 3;

const schemaIdentifier = (): string =>
  `api_next_platform_pirate_${crypto.randomUUID().replaceAll("-", "")}`;
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
    created_at: "2026-08-27T10:00:00.000Z",
  },
  profile: {
    user_id: userId,
    display_name: "Fixture Captain",
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
    created_at: "2026-08-27T10:00:00.000Z",
  },
  global_handle: {
    global_handle_id: handleId,
    label_normalized: label,
    label_display: `${label}.pirate`,
    status: "active",
    tier: "generated",
    issuance_source: "generated_signup",
    redirect_target_global_handle_id: null,
    price_paid_cents: null,
    free_rename_consumed: 0,
    issued_at: "2026-08-27T10:00:00.000Z",
    replaced_at: null,
  },
  linked_handles: [],
  wallet_attachments: [],
  onboarding: {
    generated_handle_assigned: true,
    cleanup_rename_available: true,
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
    const scoped = connectionForSchema(connectionString, schema);
    await runPostgresMigrations({ connectionString: scoped });
    return await use(scoped, admin);
  } finally {
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

const authority = async (admin: Client, accountId: string) => {
  const result = await admin.query<{
    platform_handle_id: string;
    owner_persona_id: string;
    generation: string;
    label_normalized: string;
    cleanup_rename_consumed: boolean;
  }>(
    `SELECT stable.platform_handle_id,stable.owner_persona_id,stable.generation,
            active.label_normalized,stable.cleanup_rename_consumed
       FROM platform_pirate_handles AS stable
       JOIN public_handle_index AS active ON active.handle_id=stable.active_handle_id
      WHERE stable.actor_account_id=$1`,
    [accountId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("missing fixture authority");
  return row;
};

const policy = {
  label_policy_id: "pirate_ascii_ldh_3_32_v1",
  label_policy_revision: 1,
  label_policy_hash: "7139c5f71b651833a68b14d03b2ef93f9b528b73bd53c455546cdb10a54eb873",
  reserved_labels_id: "pirate_platform_reserved_labels_v1",
  reserved_labels_revision: 1,
  reserved_labels_hash: "e7f1a3e99c5eb1bd51e880db3aa6c7caeca83f2b7dcce4dfddb54c45c49ea304",
  confusability_policy_id: "pirate_ascii_skeleton_v1",
  confusability_policy_revision: 1,
  confusability_policy_hash: "b50884c3e97a4ea50fc6da0c2b0d15669bcb0647886011521b5dbb1fd7ddfa92",
} as const;

suite("Postgres 17 global Pirate cleanup rename", () => {
  test("commits one rename, direct redirect, private snapshot, replay, and public resolution", async () => {
    await withSchema(async (connection, admin) => {
      await createWalletBackedAccountFixture(admin, {
        userId: "account_rename_01",
        account: account("account_rename_01", "platform_handle_01", "new-0123456789abcdefabcd"),
      });
      const current = await authority(admin, "account_rename_01");
      const runtime = makeDirectPostgresControlPlaneLayer(connection);
      const store = makeControlPlanePlatformPirateHandleStore(runtime);
      const input = {
        accountId: "account_rename_01",
        personaId: current.owner_persona_id,
        platformHandleId: current.platform_handle_id,
        expectedStateHash: platformPirateHandleStateV1Hash({
          platform_handle_id: current.platform_handle_id,
          owner_persona_id: current.owner_persona_id,
          generation: Number(current.generation),
          handle_label: current.label_normalized,
          state: "active",
          cleanup_rename_consumed: current.cleanup_rename_consumed,
          redirect_to_label: null,
        }).sha256,
        desiredLabel: "captain-data",
        confusabilityKey: "captaindata",
        desiredLabelValid: true,
        policy,
        idempotencyKey: "rename-fixture-01",
        requestHash: "9".repeat(64),
      } as const;
      const available = await Effect.runPromise(
        store.checkAvailability({
          accountId: input.accountId,
          personaId: input.personaId,
          platformHandleId: input.platformHandleId,
          desiredLabel: input.desiredLabel,
          confusabilityKey: input.confusabilityKey,
          desiredLabelValid: true,
          policy: input.policy,
        }),
      );
      expect(available).toEqual({ kind: "available" });
      const renamed = await Effect.runPromise(store.rename(input));
      expect(renamed).toMatchObject({
        kind: "renamed",
        handle: {
          platform_handle_id: "platform_handle_01",
          handle_label: "captain-data",
          generation: 2,
          cleanup_rename_available: false,
        },
        previous: {
          handle_label: "new-0123456789abcdefabcd",
          redirect_to_label: "captain-data",
        },
      });
      const replayed = await Effect.runPromise(store.rename(input));
      expect(replayed.kind).toBe("replayed");
      const conflict = await Effect.runPromise(
        store.rename({ ...input, requestHash: "8".repeat(64) }),
      );
      expect(conflict).toEqual({ kind: "idempotency_conflict" });
      const stale = await Effect.runPromise(
        store.rename({
          ...input,
          desiredLabel: "second-captain",
          confusabilityKey: "secondcaptain",
          idempotencyKey: "rename-fixture-stale",
          requestHash: "7".repeat(64),
        }),
      );
      expect(stale).toEqual({ kind: "stale_platform_handle" });
      if (renamed.kind !== "renamed") throw new Error("expected rename result");
      const consumed = await Effect.runPromise(
        store.rename({
          ...input,
          expectedStateHash: renamed.handle.state_hash,
          desiredLabel: "second-captain",
          confusabilityKey: "secondcaptain",
          idempotencyKey: "rename-fixture-consumed",
          requestHash: "6".repeat(64),
        }),
      );
      expect(consumed).toEqual({ kind: "cleanup_rename_unavailable" });

      const rows = await admin.query<{
        label_normalized: string;
        status: string;
        target: string | null;
        platform_handle_id: string;
      }>(
        `SELECT old.label_normalized,old.status,target.label_normalized AS target,
                old.platform_handle_id
           FROM public_handle_index AS old
           LEFT JOIN public_handle_index AS target
             ON target.handle_id=old.redirect_target_handle_id
          ORDER BY old.generation`,
      );
      expect(rows.rows).toEqual([
        {
          label_normalized: "new-0123456789abcdefabcd",
          status: "redirect",
          target: "captain-data",
          platform_handle_id: "platform_handle_01",
        },
        {
          label_normalized: "captain-data",
          status: "active",
          target: null,
          platform_handle_id: "platform_handle_01",
        },
      ]);
      const snapshot = await admin.query<{
        label: string;
        consumed: boolean;
        available: boolean;
      }>(
        `SELECT account #>> '{global_handle,label_display}' AS label,
                (account #>> '{global_handle,free_rename_consumed}')::boolean AS consumed,
                (account #>> '{onboarding,cleanup_rename_available}')::boolean AS available
           FROM users WHERE user_id='account_rename_01'`,
      );
      expect(snapshot.rows[0]).toEqual({
        label: "captain-data.pirate",
        consumed: true,
        available: false,
      });

      const identity = makeControlPlaneIdentityStore(runtime);
      const storedIdentity = await Effect.runPromise(identity.findUser("account_rename_01"));
      if (storedIdentity === null) throw new Error("missing renamed account projection");
      expect(projectIdentityAccount(storedIdentity)).toMatchObject({
        profile: {
          global_handle: {
            label: "captain-data.pirate",
            free_rename_consumed: true,
            cleanup_rename_available: false,
          },
        },
        onboarding: { cleanup_rename_available: false },
      });
      await createActivePersonaFixture(admin, {
        accountId: "account_rename_01",
        personaId: "persona_rename_sibling_01",
      });
      await expect(
        admin.query(
          `UPDATE platform_pirate_handles
              SET owner_persona_id='persona_rename_sibling_01'
            WHERE platform_handle_id='platform_handle_01'`,
        ),
      ).rejects.toThrow("platform Pirate identity ownership is immutable");
      const publicStore = makeControlPlanePublicProfileStore(runtime, identity);
      const historical = await Effect.runPromise(
        getPublicProfileByHandle(
          { handle: "new-0123456789abcdefabcd" },
          { publicProfileStore: publicStore },
        ),
      );
      const canonical = await Effect.runPromise(
        getPublicProfileByHandle({ handle: "captain-data" }, { publicProfileStore: publicStore }),
      );
      expect(historical.is_canonical).toBe(false);
      expect(historical.profile.global_handle.id).toBe("gh_platform_handle_01");
      expect(canonical.is_canonical).toBe(true);
      expect(canonical.profile.global_handle.id).toBe("gh_platform_handle_01");
      await expect(
        admin.query("DELETE FROM public_handle_index WHERE label_normalized='captain-data'"),
      ).rejects.toThrow();
    });
    completed += 1;
  });

  test("serializes confusable concurrent claimants to one winner", async () => {
    await withSchema(async (connection, admin) => {
      await createWalletBackedAccountFixture(admin, {
        userId: "account_race_01",
        account: account("account_race_01", "platform_race_01", "new-11111111111111111111"),
      });
      await createWalletBackedAccountFixture(admin, {
        userId: "account_race_02",
        account: account("account_race_02", "platform_race_02", "new-22222222222222222222"),
      });
      const runtime = makeDirectPostgresControlPlaneLayer(connection);
      const store = makeControlPlanePlatformPirateHandleStore(runtime);
      const first = await authority(admin, "account_race_01");
      const second = await authority(admin, "account_race_02");
      const rename = (
        row: Awaited<ReturnType<typeof authority>>,
        accountId: string,
        label: string,
      ) =>
        Effect.runPromise(
          store.rename({
            accountId,
            personaId: row.owner_persona_id,
            platformHandleId: row.platform_handle_id,
            expectedStateHash: platformPirateHandleStateV1Hash({
              platform_handle_id: row.platform_handle_id,
              owner_persona_id: row.owner_persona_id,
              generation: Number(row.generation),
              handle_label: row.label_normalized,
              state: "active",
              cleanup_rename_consumed: false,
              redirect_to_label: null,
            }).sha256,
            desiredLabel: label,
            confusabilityKey: "captaindata",
            desiredLabelValid: true,
            policy,
            idempotencyKey: `race-${accountId}`,
            requestHash: accountId.endsWith("01") ? "1".repeat(64) : "2".repeat(64),
          }),
        );
      const outcomes = await Promise.all([
        rename(first, "account_race_01", "captain-data"),
        rename(second, "account_race_02", "c4pt4in-d4t4"),
      ]);
      expect(outcomes.filter(({ kind }) => kind === "renamed")).toHaveLength(1);
      expect(outcomes.filter(({ kind }) => kind === "handle_unavailable")).toHaveLength(1);
      const active = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM public_handle_index
          WHERE status='active' AND confusability_key='captaindata'`,
      );
      expect(active.rows[0]?.count).toBe("1");
    });
    completed += 1;
  });

  test("enforces reserved history and account-scoped submission limits", async () => {
    await withSchema(async (connection, admin) => {
      await createWalletBackedAccountFixture(admin, {
        userId: "account_policy_01",
        account: account("account_policy_01", "platform_policy_01", "new-33333333333333333333"),
      });
      const current = await authority(admin, "account_policy_01");
      const runtime = makeDirectPostgresControlPlaneLayer(connection);
      const store = makeControlPlanePlatformPirateHandleStore(runtime);
      const stateHash = platformPirateHandleStateV1Hash({
        platform_handle_id: current.platform_handle_id,
        owner_persona_id: current.owner_persona_id,
        generation: Number(current.generation),
        handle_label: current.label_normalized,
        state: "active",
        cleanup_rename_consumed: false,
        redirect_to_label: null,
      }).sha256;
      const attempt = (
        desiredLabel: string,
        idempotencyKey: string,
        expectedStateHash = stateHash,
      ) =>
        Effect.runPromise(
          store.rename({
            accountId: "account_policy_01",
            personaId: current.owner_persona_id,
            platformHandleId: current.platform_handle_id,
            expectedStateHash,
            desiredLabel,
            confusabilityKey: desiredLabel.replaceAll("-", ""),
            desiredLabelValid: true,
            policy,
            idempotencyKey,
            requestHash: crypto.randomUUID().replaceAll("-", "").repeat(2),
          }),
        );

      expect(await attempt("admin", "policy-reserved-exact")).toEqual({
        kind: "handle_unavailable",
      });
      expect(await attempt("new-abc", "policy-reserved-prefix")).toEqual({
        kind: "handle_unavailable",
      });
      for (const suffix of ["one", "two", "three"]) {
        expect(await attempt(`stale-${suffix}`, `policy-stale-${suffix}`, "f".repeat(64))).toEqual({
          kind: "stale_platform_handle",
        });
      }
      const limited = await attempt("rate-fenced", "policy-rate-fenced");
      expect(limited.kind).toBe("rate_limited");
      if (limited.kind !== "rate_limited") throw new Error("expected rate limit");
      expect(limited.retryAfterSeconds).toBeGreaterThan(0);

      await createWalletBackedAccountFixture(admin, {
        userId: "account_reuse_01",
        account: account("account_reuse_01", "platform_reuse_01", "new-44444444444444444444"),
      });
      const reuse = await authority(admin, "account_reuse_01");
      await expect(
        admin.query(
          `INSERT INTO public_handle_index (
             handle_id,label_normalized,label_display,status,owner_user_id,
             owner_persona_id,redirect_target_handle_id
           ) VALUES (
             'reuse-retained-placeholder','new-33333333333333333333',
             'new-33333333333333333333.pirate','active','account_reuse_01',$1,NULL
           )`,
          [reuse.owner_persona_id],
        ),
      ).rejects.toThrow();
    });
    completed += 1;
  });
});

afterAll(async () => {
  if (connectionString !== undefined && completed === testCount) {
    await Bun.write(sentinelPath, sentinelContents);
  }
});
