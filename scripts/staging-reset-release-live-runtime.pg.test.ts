import { describe, expect, mock, test } from "bun:test";
import { Client } from "pg";
import { localRecoveryTestUrl } from "./staging-persona-recovery-test-target.ts";

const raw = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (!raw && process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1")
  throw new Error("local test URL required");
const suite = raw ? describe : describe.skip;

// The provider/Hyperdrive target reader is the only provider seam the release
// database surface uses. Locally there is no provider, so the binding is
// supplied by the fixture; the surface itself is the real component.
let bindingFixture: unknown;
mock.module("./staging-persona-target-binding.ts", () => ({
  collectStagingProviderBinding: async () => bindingFixture,
}));

const { makeKaraokeDatabaseRelease } = await import("./staging-karaoke-release-database.ts");
const { KaraokeReleaseFailure } = await import("./staging-karaoke-release-failure.ts");
const { readResetGrantCatalog } = await import("./staging-persona-grant-catalog.ts");
const { loadStagingResetArtifacts, validateStagingResetArtifacts } = await import(
  "./staging-persona-reset-plan.ts"
);
const { measureStagingLiveAdmission } = await import("./staging-reset-release-live-runtime.ts");
type LiveConfiguration = Parameters<typeof measureStagingLiveAdmission>[0]["configuration"];

const plan = validateStagingResetArtifacts(loadStagingResetArtifacts());

const ROUTINES = [
  "append_song_owner_policy_revision_v1(text,text,text,bigint,text,text,text)",
  "claim_hns_authority_provision_job_v1(text,integer)",
  "finalize_hns_authority_provision_job_v1(text,text,bigint,text,text,bytea,text,bytea,text,text)",
  "claim_hns_root_import_observation_job_v1(text,integer)",
  "finalize_hns_root_import_observation_job_v1(text,text,bigint,text,text,bytea,text,text)",
  "enqueue_hns_root_import_teardown_job_v1()",
  "observe_song_derivative_video_policy_v1(text,text,bigint,text,text,bigint,text)",
] as const;

type Fixture = {
  readonly admin: Client;
  readonly scoped: string;
  readonly database: string;
  readonly operatorRole: string;
  readonly runtimeRole: string;
};

async function fixture(use: (input: Fixture) => Promise<void>) {
  const source = localRecoveryTestUrl(raw ?? "");
  const database = `live_admission_${crypto.randomUUID().replaceAll("-", "")}`;
  const runtimeRole = `live_runtime_${crypto.randomUUID().replaceAll("-", "")}`;
  const root = new Client({ connectionString: source.toString() });
  const scoped = new URL(source);
  scoped.pathname = `/${database}`;
  const admin = new Client({ connectionString: scoped.toString() });
  await root.connect();
  try {
    await root.query(`CREATE ROLE "${runtimeRole}" LOGIN PASSWORD 'fixture-only'`);
    await root.query(`CREATE DATABASE "${database}"`);
    await admin.connect();
    await admin.query("CREATE SCHEMA api_next");
    await admin.query(
      "CREATE TABLE api_next.schema_migrations(version text PRIMARY KEY, checksum text NOT NULL)",
    );
    for (const migration of plan.migrations.slice(0, 109))
      await admin.query("INSERT INTO api_next.schema_migrations(version,checksum) VALUES($1,$2)", [
        migration.version,
        migration.checksum,
      ]);
    // The approved-privilege compiler resolves these seven pinned signatures.
    for (const signature of ROUTINES)
      await admin.query(
        `CREATE FUNCTION api_next.${signature} RETURNS void LANGUAGE sql AS 'SELECT'`,
      );
    // The database CONNECT fence is held: the runtime role cannot connect and
    // the operator (fixture superuser) can. This is the correctly fenced state
    // the admission path must run under, without a runtime probe session.
    await admin.query(`REVOKE CONNECT ON DATABASE "${database}" FROM PUBLIC`);
    const operatorRole = (await admin.query("SELECT current_user::text AS role")).rows[0].role;
    await use({ admin, scoped: scoped.toString(), database, operatorRole, runtimeRole });
  } finally {
    await admin.query("ROLLBACK").catch(() => undefined);
    await admin.end();
    await root.query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
    await root.query(`DROP ROLE IF EXISTS "${runtimeRole}"`).catch(() => undefined);
    await root.end();
  }
}

function configurationFor(input: {
  readonly runtimeRole: string;
  readonly defaultsDigest: string;
}): LiveConfiguration {
  return {
    version: "staging-reset-release-live-v1",
    executionAuthorized: true,
    approvedPlanDigest: "0".repeat(64),
    plan: {
      version: "staging-karaoke-release-plan-v2",
      ingressApplicationId: "a".repeat(32),
      resumeQueues: [],
      servingWorkers: [],
      reviewedGrantDigest: "d".repeat(64),
      surfaceOrder: ["versions", "database", "ingress", "producers"],
    },
    deploymentInputs: [],
    restoration: {
      ingress: {
        kind: "remove-fence-application",
        remainingApplicationsDigest: "e".repeat(64),
      },
      database: {
        targetBindingDigest: "c".repeat(64),
        reviewedGrantDigest: "d".repeat(64),
        restoreRuntimeConnect: true,
        runtimeRole: input.runtimeRole,
        runtimeIdentityEvidence: "f".repeat(64),
      },
      producers: { schedules: [] },
    },
    acceptance: {
      apiBaseUrl: "https://api.staging.example",
      communityId: "community-1",
      privyAccessToken: "fixture",
    },
    reset: { baselineDigest: "9".repeat(64), defaultsDigest: input.defaultsDigest },
    recovery: { captureId: "capture1", captureEvidenceDigest: "7".repeat(64) },
    markerDirectory: "/tmp/live-admission-fixture",
    validUntilMs: Date.now() + 600_000,
    budgets: {
      removal: { maxOwnLockRows: 1_000, maxClusterLockRows: 1_200, maxClosureObjects: 800 },
      replay: { maxLockRows: 1_000, maxClusterLockRows: 1_200, statementTimeoutMs: 120_000 },
    },
  } as unknown as LiveConfiguration;
}

function fenceObservations() {
  const state = {
    producers: { queues: [{ name: "pirate-media-processing-staging", delivery_paused: true }] },
    ingress: { ingressDenied: true },
  };
  return {
    state,
    fences: {
      observeProducers: async () => structuredClone(state.producers),
      observeIngress: async () => structuredClone(state.ingress),
    },
  };
}

async function connectAsRuntime(scoped: string, runtimeRole: string) {
  const url = new URL(scoped);
  url.username = runtimeRole;
  url.password = "fixture-only";
  const client = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}

suite("live reset/release admission against disposable PostgreSQL", () => {
  test("the fence callback inside a batch transaction preserves the transaction and its committed write", async () => {
    await fixture(async ({ admin, scoped, database, operatorRole, runtimeRole }) => {
      const defaults = await readResetGrantCatalog(admin);
      const configuration = configurationFor({
        runtimeRole,
        defaultsDigest: defaults.defaults_sha256,
      });
      const { fences } = fenceObservations();
      const admission = await measureStagingLiveAdmission({
        admin,
        configuration,
        operatorRole,
        runtimeRole,
        fences,
        expectedDatabase: database,
      });
      expect(admission.targetAndFenceDigest).toMatch(/^[a-f0-9]{64}$/u);
      // Correctly fenced: the runtime credential is refused while admission
      // measures, and admission does not open a runtime session of its own.
      await expect(connectAsRuntime(scoped, runtimeRole)).rejects.toBeDefined();

      await admin.query("BEGIN");
      await admin.query("CREATE TABLE batch_probe(id integer)");
      await admin.query("INSERT INTO batch_probe VALUES (1)");
      const transactionId = (await admin.query("SELECT pg_current_xact_id()::text AS xid")).rows[0]
        .xid;
      // The actual live callback, called from the executor's transaction
      // context. It must observe the drain without beginning or ending the
      // transaction, so the batch survives until the executor commits.
      await admission.assertFreshFence({ transactionId, privilegeMode: "revoked" });
      expect((await admin.query("SELECT pg_current_xact_id()::text AS xid")).rows[0].xid).toBe(
        transactionId,
      );
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM batch_probe")).rows[0].count,
      ).toBe(1);
      await admin.query("COMMIT");

      const observer = new Client({ connectionString: scoped });
      await observer.connect();
      try {
        expect(
          (await observer.query("SELECT count(*)::int AS count FROM batch_probe")).rows[0].count,
        ).toBe(1);
      } finally {
        await observer.end();
      }
      // The idle context keeps working after the committed batch.
      await admission.assertFreshFence({ transactionId: null, privilegeMode: "revoked" });
    });
  });

  test("admission counts other sessions and refuses before any reset step when one exists", async () => {
    await fixture(async ({ admin, scoped, database, operatorRole, runtimeRole }) => {
      const defaults = await readResetGrantCatalog(admin);
      const configuration = configurationFor({
        runtimeRole,
        defaultsDigest: defaults.defaults_sha256,
      });
      const { fences } = fenceObservations();
      const peer = new Client({ connectionString: scoped });
      await peer.connect();
      try {
        await expect(
          measureStagingLiveAdmission({
            admin,
            configuration,
            operatorRole,
            runtimeRole,
            fences,
            expectedDatabase: database,
          }),
        ).rejects.toThrow("session_drain_unproven");
      } finally {
        await peer.end();
      }
      const admission = await measureStagingLiveAdmission({
        admin,
        configuration,
        operatorRole,
        runtimeRole,
        fences,
        expectedDatabase: database,
      });
      expect(admission.runtimeRole).toBe(runtimeRole);
    });
  });

  test("the live fence refuses after the observed fence moves", async () => {
    await fixture(async ({ admin, database, operatorRole, runtimeRole }) => {
      const defaults = await readResetGrantCatalog(admin);
      const configuration = configurationFor({
        runtimeRole,
        defaultsDigest: defaults.defaults_sha256,
      });
      const { state, fences } = fenceObservations();
      const admission = await measureStagingLiveAdmission({
        admin,
        configuration,
        operatorRole,
        runtimeRole,
        fences,
        expectedDatabase: database,
      });
      await expect(admission.assertFenceAndRecovery()).resolves.toBeUndefined();
      state.ingress.ingressDenied = false;
      await expect(admission.assertFenceAndRecovery()).rejects.toThrow(
        "staging_live_fence_changed_restore_required",
      );
    });
  });

  test("the real database surface accepts the reviewed intent and reaches the provider-bound connect", async () => {
    await fixture(async ({ scoped, operatorRole, runtimeRole }) => {
      const runtimeScoped = new URL(scoped);
      runtimeScoped.username = runtimeRole;
      runtimeScoped.password = "fixture-only";
      bindingFixture = {
        target_binding_sha256: "c".repeat(64),
        otherActiveRoleIds: [],
        adminRaw: scoped,
        runtimeRaw: runtimeScoped.toString(),
        admin: { sqlRole: operatorRole },
        runtime: { sqlRole: runtimeRole },
      };
      const reviewed = {
        reviewedGrantDigest: "d".repeat(64),
        targetBindingDigest: "c".repeat(64),
        restoreRuntimeConnect: true as const,
        runtimeRole,
        runtimeIdentityEvidence: "f".repeat(64),
      };
      const execute = (surface: ReturnType<typeof makeKaraokeDatabaseRelease>) =>
        surface
          .execute({ reviewedGrantDigest: reviewed.reviewedGrantDigest }, () =>
            new Date().toISOString(),
          )
          .catch((error: unknown) => error);
      // The reviewed restoration intent is accepted: the failure is the
      // fixture's real connection identity (its database is not named
      // `postgres`), not an admission refusal.
      const accepted = await execute(makeKaraokeDatabaseRelease(reviewed));
      expect(accepted).toBeInstanceOf(KaraokeReleaseFailure);
      expect((accepted as InstanceType<typeof KaraokeReleaseFailure>).stage).toBe(
        "database-connect",
      );
      // Without the explicit intent the same reviewed plan refuses at the
      // surface's first check, which is the defect the live binding had.
      const refused = await execute(
        makeKaraokeDatabaseRelease({ ...reviewed, restoreRuntimeConnect: undefined } as never),
      );
      expect(refused).toBeInstanceOf(KaraokeReleaseFailure);
      expect((refused as InstanceType<typeof KaraokeReleaseFailure>).stage).toBe(
        "database-admission",
      );
    });
  });
});
