import { Client } from "pg";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";
import { KaraokeReleaseFailure } from "./staging-karaoke-release-failure.ts";
import type { KaraokeReleaseSurfaces } from "./staging-karaoke-release-operation.ts";
import { assertKaraokeRepositoryRoot } from "./staging-karaoke-repository-root.ts";
import {
  compileApprovedStagingPrivileges,
  verifyApprovedStagingRuntime,
  verifyStagingRuntimeIdentity,
} from "./staging-persona-approved-privileges.ts";
import { observeMaintainedDatabaseFence } from "./staging-persona-database-collector.ts";
import {
  readResetGrantCatalog,
  restoreReviewedResetGrants,
} from "./staging-persona-grant-catalog.ts";
import { collectStagingProviderBinding } from "./staging-persona-target-binding.ts";

/** Digest of the complete runtime-reachable grant set, including PUBLIC and
 * SET ROLE paths. Ownership/elevated identities are refused by the existing
 * verifier. This digest is a readback fact, never an approval generator. */
export async function readKaraokeRuntimeGrantDigest(admin: Pick<Client, "query">, role: string) {
  const names = await verifyStagingRuntimeIdentity(admin, role);
  const catalog = await readResetGrantCatalog(admin);
  const grants = catalog.grants
    .filter((grant) => grant.grantee === "PUBLIC" || names.includes(grant.grantee))
    .map((grant) => JSON.stringify(grant))
    .sort();
  return reconciliationDigest(JSON.stringify({ roles: [...names].sort(), grants }));
}

export async function assertKaraokeRuntimeGrantDigest(
  admin: Pick<Client, "query">,
  role: string,
  reviewedDigest: string,
) {
  const digest = await readKaraokeRuntimeGrantDigest(admin, role);
  if (digest !== reviewedDigest) throw new Error("karaoke_release_grants_changed");
  return digest;
}

/** Fixed provider/Hyperdrive target binding before opening SQL. No URL, role,
 * or SQL is taken from a submitted completion receipt. A fresh connection
 * after COMMIT proves the grants rather than trusting the executor result. */
export function makeKaraokeDatabaseRelease(configuration: {
  readonly reviewedGrantDigest: string;
  readonly targetBindingDigest: string;
  readonly restoreRuntimeConnect: true;
  /** Verified against the runtime connection before the fence denied it. The
   * release cannot discover it: a correctly fenced database refuses exactly the
   * connection identity discovery would need, and loosening the fence to ask
   * would defeat the fence. */
  readonly runtimeRole: string;
  /** Digest of the pre-fence SQL identity observation that established
   * `runtimeRole`. Agreement with provider metadata is not evidence that the
   * earlier connection check happened, so the observation is carried into the
   * receipt rather than assumed. */
  readonly runtimeIdentityEvidence: string;
}) {
  const input = structuredClone(configuration);
  // The stdin bundle has no scripts/ module directory. The release CLI is
  // required to run from its api-next checkout; Git objects still undergo the exact
  // approved SHA, manifest and baseline validation, independent of HEAD.
  const repositoryRoot = assertKaraokeRepositoryRoot();
  if (!/^[a-f0-9]{64}$/.test(configuration.runtimeIdentityEvidence))
    throw new Error("karaoke_release_runtime_identity_evidence_missing");
  const bound = async () => {
    const binding = await collectStagingProviderBinding();
    if (
      binding.target_binding_sha256 !== input.targetBindingDigest ||
      binding.otherActiveRoleIds.length !== 0
    )
      throw new Error("karaoke_release_database_target_changed");
    return binding;
  };
  const connect = async (raw: string) => {
    const client = new Client({
      connectionString: normalizePostgresConnectionString(raw),
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
      application_name: "staging-release-proof",
    });
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
  };
  const identity = async (admin: Client, role: string) => {
    const row = (
      await admin.query(
        "SELECT current_database() AS database,session_user AS login,current_user AS active,current_setting('server_version') AS version",
      )
    ).rows[0];
    if (row?.database !== "postgres" || row.login !== role || row.active !== role)
      throw new Error("karaoke_release_database_identity_changed");
    return row.version as string;
  };
  /** The role is a reviewed input, bound here to the verified provider target.
   * Both facts are established before the fence; neither needs a connection the
   * fence refuses. */
  const boundRuntimeRole = (binding: Awaited<ReturnType<typeof bound>>) => {
    if (input.runtimeRole !== binding.runtime.sqlRole)
      throw new Error(`karaoke_release_runtime_role_mismatch:${input.runtimeRole}`);
    return input.runtimeRole;
  };
  /** Recheck through the runtime connection once CONNECT is restored. Until
   * then this connection is denied by design. */
  const recheckRuntimeRole = async (binding: Awaited<ReturnType<typeof bound>>) => {
    const runtime = await connect(binding.runtimeRaw);
    try {
      const row = (await runtime.query("SELECT session_user AS login,current_user AS active"))
        .rows[0];
      const derived = row?.active as string | undefined;
      if (!derived || row?.login !== derived)
        throw new Error("karaoke_release_runtime_role_underived");
      if (derived !== input.runtimeRole)
        throw new Error(`karaoke_release_runtime_role_mismatch:${derived}`);
      return derived;
    } finally {
      await runtime.end().catch(() => undefined);
    }
  };
  const readback = async () => {
    const binding = await bound();
    const runtimeRole = boundRuntimeRole(binding);
    const admin = await connect(binding.adminRaw);
    try {
      await admin.query("BEGIN READ ONLY");
      const serverVersion = await identity(admin, binding.admin.sqlRole);
      await verifyApprovedStagingRuntime(admin, runtimeRole, repositoryRoot);
      const grantDigest = await assertKaraokeRuntimeGrantDigest(
        admin,
        runtimeRole,
        input.reviewedGrantDigest,
      );
      const allowed = (
        await admin.query(
          "SELECT has_database_privilege($1,current_database(),'CONNECT') AS allowed",
          [runtimeRole],
        )
      ).rows[0]?.allowed;
      if (allowed !== true) throw new Error("karaoke_release_connect_unproven");
      // CONNECT is proven restored above, so the role is rechecked through the
      // connection that will actually use it.
      await recheckRuntimeRole(binding);
      return {
        serverVersion,
        grantDigest,
        targetBindingDigest: binding.target_binding_sha256,
        runtimeConnect: true,
      };
    } finally {
      await admin.query("ROLLBACK").catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  };
  const execute: KaraokeReleaseSurfaces["database"] = async (directive, now) => {
    let stage = "database-admission";
    try {
      if (
        JSON.stringify(directive) !==
          JSON.stringify({ reviewedGrantDigest: input.reviewedGrantDigest }) ||
        input.restoreRuntimeConnect !== true
      )
        throw new Error("karaoke_release_database_directive_changed");
      const binding = await bound();
      // The stage keeps the role until the binding check passes, so a mismatch
      // fails with the role in the failure record rather than an opaque stage.
      stage = `database-runtime-role:${input.runtimeRole}`;
      const runtimeRole = boundRuntimeRole(binding);
      stage = "database-connect";
      const admin = await connect(binding.adminRaw);
      try {
        await identity(admin, binding.admin.sqlRole);
        stage = "database-held-fence";
        await observeMaintainedDatabaseFence({
          admin,
          expectedAdmin: binding.admin.sqlRole,
          runtimes: [{ role: runtimeRole, connectionString: binding.runtimeRaw }],
        });
        await admin.query("BEGIN");
        stage = "database-grant-restoration";
        await admin.query("SET LOCAL lock_timeout='3s'");
        const approved = await compileApprovedStagingPrivileges(admin, runtimeRole, repositoryRoot);
        // This is the already-reviewed fixed grant vocabulary, not arbitrary
        // SQL from configuration or an inferred grant for a new object.
        await restoreReviewedResetGrants(
          admin,
          approved.reviewed,
          approved.reviewed,
          approved.policy,
        );
        await verifyApprovedStagingRuntime(admin, runtimeRole, repositoryRoot);
        await assertKaraokeRuntimeGrantDigest(admin, runtimeRole, input.reviewedGrantDigest);
        const sql = (
          await admin.query(
            "SELECT format('GRANT CONNECT ON DATABASE %I TO %I',current_database(),$1::text) AS statement",
            [runtimeRole],
          )
        ).rows[0]?.statement;
        if (typeof sql !== "string") throw new Error("karaoke_release_connect_unproven");
        await admin.query(sql);
        stage = "database-commit";
        await admin.query("COMMIT");
      } finally {
        await admin.query("ROLLBACK").catch(() => undefined);
        await admin.end().catch(() => undefined);
      }
      stage = "database-independent-readback";
      const providerEvidence = JSON.stringify({
        ...(await readback()),
        runtimeRole: input.runtimeRole,
        runtimeIdentityEvidence: input.runtimeIdentityEvidence,
      });
      return {
        surface: "database",
        releasedAt: now(),
        receipt: reconciliationDigest(providerEvidence),
        providerEvidence,
      };
    } catch (error) {
      throw new KaraokeReleaseFailure(stage, error);
    }
  };
  return {
    execute,
    async observeRestored(): Promise<"restored" | "fenced" | "uncertain"> {
      try {
        await readback();
        return "restored";
      } catch {
        return "uncertain";
      }
    },
  };
}
