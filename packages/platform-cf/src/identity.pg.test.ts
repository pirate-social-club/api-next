import { afterAll, describe, expect, test } from "bun:test";
import type { IdentityAccountDocument } from "@pirate/application/use-cases/identity-account";
import { Cause, Effect, Exit, Result } from "effect";
import type { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "../../../scripts/postgres-test-baseline.ts";
import {
  makeControlPlaneIdentityRepository,
  makeControlPlaneIdentityStore,
} from "./identity-repository";
import { makeDirectPostgresControlPlaneLayer } from "./postgres";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_IDENTITY_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-identity-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-identity-suite-complete\n";
let completedTestCount = 0;

const account = (userId: string, handleId: string, label: string): IdentityAccountDocument => ({
  user: {
    user_id: userId,
    primary_wallet_attachment_id: null,
    capability_provider: null,
    verification_capabilities_json: null,
    verified_at: null,
    created_at: "2026-08-19T00:00:00.000Z",
  },
  profile: {
    user_id: userId,
    display_name: null,
    bio: null,
    bio_source: "none",
    avatar_ref: null,
    avatar_source: "none",
    cover_ref: null,
    cover_source: "none",
    preferred_locale: null,
    display_verified_nationality_badge: 0,
    global_handle_id: handleId,
    primary_linked_handle_id: null,
    xmtp_inbox_id: null,
    created_at: "2026-08-19T00:00:00.000Z",
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
    issued_at: "2026-08-19T00:00:00.000Z",
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

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionForSchema(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  const option = encodeURIComponent(`-c search_path=${schema}`);
  return `${raw}${separator}options=${option}`;
}

async function withSchema<A>(use: (connection: string, admin: Client) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  return withReusablePostgresTestSchema({
    baseConnectionString: connectionString,
    schemaName: "packages_platform_cf_src_identity_pg_test_ts",
    use: async ({ admin, schema }) => {
      await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      return await use(connectionForSchema(connectionString, schema), admin);
    },
  });
}

async function apply(connection: string): Promise<void> {
  await applyPostgresTestBaselineConnection({ connectionString: connection });
}

function failureOf<A, E>(exit: Exit.Exit<A, E>): E {
  if (!Exit.isFailure(exit)) throw new Error("expected a failed effect");
  const failure = Cause.findError(exit.cause);
  if (!Result.isSuccess(failure)) throw new Error("expected a typed repository error");
  return failure.success;
}

async function resolve(connection: string, sourceUserId: string) {
  const identityStore = makeControlPlaneIdentityStore(
    makeDirectPostgresControlPlaneLayer(connection),
  );
  return Effect.runPromiseExit(identityStore.resolveCanonical({ sourceUserId }));
}

suite("Postgres 17 identity repository", () => {
  test("follows active aliases and merge aliases to an active canonical user", async () => {
    await withSchema(async (connection, admin) => {
      await apply(connection);
      await admin.query("INSERT INTO users (user_id) VALUES ($1), ($2), ($3)", [
        "usr_source",
        "usr_merge",
        "usr_canonical",
      ]);
      await admin.query(
        `INSERT INTO account_aliases (source_user_id, canonical_user_id, kind, status)
         VALUES ($1, $2, 'alias', 'active'), ($3, $4, 'merge', 'completed')`,
        ["usr_source", "usr_merge", "usr_merge", "usr_canonical"],
      );

      const result = await resolve(connection, "usr_source");
      expect(Exit.isSuccess(result) ? result.value : undefined).toEqual({
        sourceUserId: "usr_source",
        canonicalUserId: "usr_canonical",
        aliasPath: ["usr_source", "usr_merge"],
      });
    });
    completedTestCount += 1;
  });

  test("fails closed for alias cycles and missing canonical users", async () => {
    await withSchema(async (connection, admin) => {
      await apply(connection);
      await admin.query("INSERT INTO users (user_id) VALUES ($1), ($2), ($3)", [
        "usr_cycle_a",
        "usr_cycle_b",
        "usr_missing_source",
      ]);
      await admin.query(
        `INSERT INTO account_aliases (source_user_id, canonical_user_id, kind, status)
         VALUES ($1, $2, 'alias', 'active'), ($2, $1, 'alias', 'active'),
                ($3, 'usr_missing_canonical', 'alias', 'active')`,
        ["usr_cycle_a", "usr_cycle_b", "usr_missing_source"],
      );

      const cycle = await resolve(connection, "usr_cycle_a");
      expect(failureOf(cycle)).toMatchObject({ _tag: "IdentityResolutionError", reason: "cyclic" });
      const missing = await resolve(connection, "usr_missing_source");
      expect(failureOf(missing)).toMatchObject({
        _tag: "IdentityResolutionError",
        reason: "missing",
      });
    });
    completedTestCount += 1;
  });

  test("fences concurrent registration to one credential, account, and handle", async () => {
    await withSchema(async (connection, admin) => {
      await apply(connection);
      const repository = makeControlPlaneIdentityRepository();
      const runtime = makeDirectPostgresControlPlaneLayer(connection);
      const register = (suffix: "a" | "b") =>
        Effect.runPromise(
          Effect.scoped(
            repository
              .registerCredential({
                provider: "privy",
                providerAppId: "privy-staging",
                providerSubject: "did:privy:concurrent",
                credentialId: `credential-${suffix}`,
                userId: `user-${suffix}`,
                minimumAgeAttestation: {
                  version: "minimum-age-attestation-v1",
                  minimum_age: 16,
                  affirmed: true,
                },
                account: account(
                  `user-${suffix}`,
                  `handle-${suffix}`,
                  `generated-${suffix}.pirate`,
                ),
              })
              .pipe(Effect.provide(runtime)),
          ),
        );

      const outcomes = await Promise.all([register("a"), register("b")]);
      expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual([
        "already_registered",
        "created",
      ]);
      const canonicalIds = outcomes.flatMap((outcome) =>
        "canonicalUserId" in outcome ? [outcome.canonicalUserId] : [],
      );
      expect(new Set(canonicalIds).size).toBe(1);

      const counts = await admin.query<{
        readonly users: string;
        readonly handles: string;
        readonly credentials: string;
      }>(`SELECT
            (SELECT count(*) FROM users)::text AS users,
            (SELECT count(*) FROM public_handle_index)::text AS handles,
            (SELECT count(*) FROM identity_credentials)::text AS credentials`);
      expect(counts.rows[0]).toEqual({ users: "1", handles: "0", credentials: "1" });
    });
    completedTestCount += 1;
  });

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === 3) {
      await Bun.write(sentinelPath, sentinelContents);
    }
  });
});
