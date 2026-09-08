import { createHash } from "node:crypto";
import type { Client } from "pg";
import { STAGING_RESET_RELEASE } from "./staging-persona-reset-plan.ts";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Internal readback on the executor's already admitted transaction. This is
 * not admission, a reset command, or evidence that an empty database was reset.
 * The executor calls it only after its full schema/privilege/outside-catalog
 * verification and successful replay. */
export async function readPhasedResetCompletionEvidence(
  admin: Pick<Client, "query">,
  expected: {
    readonly database: string;
    readonly role: string;
    readonly schemaOid: number;
    readonly baselineDigest: string;
    readonly migrations: readonly { readonly version: string; readonly checksum: string }[];
  },
) {
  const identity = (
    await admin.query(`SELECT current_database() AS database,
    session_user AS login, current_user AS active,
    current_setting('server_version') AS server_version,
    'api_next'::regnamespace::oid AS schema_oid`)
  ).rows[0];
  if (
    !identity ||
    identity.database !== expected.database ||
    identity.login !== expected.role ||
    identity.active !== expected.role ||
    identity.schema_oid !== expected.schemaOid ||
    typeof identity.server_version !== "string" ||
    !identity.server_version ||
    identity.server_version.length > 1024
  )
    throw new Error("reset_completion_identity_changed");
  const rows = (
    await admin.query("SELECT version,checksum FROM api_next.schema_migrations ORDER BY version")
  ).rows;
  const ledger = rows.map(({ version, checksum }) => Object.freeze({ version, checksum }));
  const approved = expected.migrations.map(({ version, checksum }) => ({ version, checksum }));
  if (
    ledger.length !== STAGING_RESET_RELEASE.migrationCount ||
    JSON.stringify(ledger) !== JSON.stringify(approved) ||
    ledger.at(-1)?.version !== STAGING_RESET_RELEASE.terminalVersion
  )
    throw new Error("reset_completion_ledger_changed");
  await admin.query("SET LOCAL search_path=api_next,pg_catalog");
  const counts = (
    await admin.query(`WITH evidence AS MATERIALIZED (
      SELECT persona_id, count(DISTINCT community_id) AS communities
      FROM api_next.persona_community_binding_evidence_v1() GROUP BY persona_id
    ) SELECT
      (SELECT count(*)::int FROM api_next.personas p WHERE NOT EXISTS
        (SELECT 1 FROM evidence e WHERE e.persona_id=p.persona_id)) AS unbound,
      (SELECT count(*)::int FROM evidence WHERE communities=1) AS "singleCommunity",
      (SELECT count(*)::int FROM evidence WHERE communities>1) AS "multiCommunity",
      api_next.persona_community_binding_evidence_digest_v1() AS digest`)
  ).rows[0];
  if (
    counts?.unbound !== 0 ||
    counts.singleCommunity !== 0 ||
    counts.multiCommunity !== 0 ||
    counts.digest !== "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  )
    throw new Error("reset_completion_persona_evidence_changed");
  const personaCounts = Object.freeze({
    unbound: counts.unbound as number,
    singleCommunity: counts.singleCommunity as number,
    multiCommunity: counts.multiCommunity as number,
  });
  const completion = Object.freeze({
    version: "staging-karaoke-reset-completion-v1" as const,
    verifiedAt: new Date().toISOString(),
    serverVersion: identity.server_version as string,
    terminalMigration: STAGING_RESET_RELEASE.terminalVersion,
    ledgerDigest: digest(ledger),
    personaCounts,
    personaEvidenceDigest: counts.digest as string,
  });
  return Object.freeze({
    completion,
    proof: Object.freeze({
      sourceSha: STAGING_RESET_RELEASE.sourceSha,
      manifestSha256: STAGING_RESET_RELEASE.manifestSha256,
      baselineSha256: STAGING_RESET_RELEASE.baselineSha256,
      baselineShapeDigest: expected.baselineDigest,
      database: identity.database as string,
      schemaOid: identity.schema_oid as number,
      adminRoleDigest: digest(identity.active),
      ledger: Object.freeze(ledger),
      completion,
    }),
  });
}
