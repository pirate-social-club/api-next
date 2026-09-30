import type { HnsChainObservationResultV1 } from "@pirate/application/namespace-ownership";
import { Client, type QueryResultRow } from "pg";
import type { HnsLifecycleClaimV1 } from "./lifecycle-executor.ts";
import {
  HnsLifecycleReadinessContextError,
  type HnsOwnershipPreparationResultV1,
} from "./lifecycle-readiness.ts";
import { observeProvisionalSafeOwnership } from "./provisional-safe-ownership.ts";

async function queryOwnership<Row extends QueryResultRow>(
  connectionString: string,
  query: string,
  values: unknown[],
) {
  const client = new Client({ connectionString });
  let disconnected = false;
  client.on("error", () => {
    disconnected = true;
  });
  try {
    await client.connect();
    const result = await client.query<Row>(query, values);
    if (disconnected) throw new Error("HNS ownership database connection lost");
    return result;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function makePostgresHnsOwnershipPreparation(
  connectionString: string,
  observeSafe: (root: string) => Promise<HnsChainObservationResultV1>,
) {
  return async (
    job: HnsLifecycleClaimV1,
    executorId: string,
  ): Promise<HnsOwnershipPreparationResultV1> => {
    const result = await queryOwnership<Record<string, unknown>>(
      connectionString,
      `SELECT
        s.root_import_session_id, s.namespace_session_id, s.root_label, s.challenge_txt_value,
        s.publish_plan_sha256, s.ownership_result_sha256, s.provision_authorization_kind,
        l.plan_encoded_resource_sha256, l.revision AS lifecycle_revision, l.generation
        FROM hns_root_import_sessions s JOIN hns_root_import_lifecycle l USING(root_import_session_id)
        JOIN hns_root_import_lifecycle_jobs j USING(root_import_session_id)
        WHERE s.root_import_session_id=$1 AND j.lifecycle_job_id=$2
          AND j.state='leased' AND j.job_kind='observe_readiness'
          AND j.leased_by=$3 AND j.lease_fence=$4 AND j.lease_expires_at>clock_timestamp()
          AND j.generation=l.generation AND l.generation=$5
          AND l.phase IN ('checking_authority','ready')`,
      [
        job.root_import_session_id,
        job.lifecycle_job_id,
        executorId,
        job.lease_fence,
        job.generation,
      ],
    );
    if (result.rows.length !== 1) return "refused";
    const row = result.rows[0];
    if (row === undefined) return "refused";
    if (
      typeof row.ownership_result_sha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(row.ownership_result_sha256)
    )
      return "ready";
    if (
      row.ownership_result_sha256 !== null ||
      !["community_provisional", "hns_name_signature"].includes(
        String(row.provision_authorization_kind),
      ) ||
      [
        "root_import_session_id",
        "namespace_session_id",
        "root_label",
        "challenge_txt_value",
        "publish_plan_sha256",
        "plan_encoded_resource_sha256",
      ].some((k) => typeof row[k] !== "string")
    ) {
      throw new HnsLifecycleReadinessContextError();
    }
    const proof = await observeProvisionalSafeOwnership(
      {
        root_import_session_id: String(row.root_import_session_id),
        namespace_session_id: String(row.namespace_session_id),
        root_label: String(row.root_label),
        challenge_txt_value: String(row.challenge_txt_value),
        publish_plan_sha256: String(row.publish_plan_sha256),
        plan_encoded_resource_sha256: String(row.plan_encoded_resource_sha256),
        lifecycle_revision: Number(row.lifecycle_revision),
        generation: Number(row.generation),
      },
      observeSafe,
    );
    const queued = await queryOwnership<{ outcome: string }>(
      connectionString,
      "SELECT * FROM enqueue_hns_safe_ownership_completion_v1($1,$2,$3,$4,$5,$6)",
      [
        job.root_import_session_id,
        job.lifecycle_job_id,
        executorId,
        job.lease_fence,
        Buffer.from(proof.proof_bytes),
        proof.proof_sha256,
      ],
    );
    if (queued.rows.length !== 1) throw new Error("HNS ownership preparation returned no outcome");
    if (queued.rows[0]?.outcome === "ownership_ready") return "ready";
    if (
      queued.rows[0]?.outcome === "revision_conflict" ||
      queued.rows[0]?.outcome === "stale_proof"
    ) {
      return queued.rows[0].outcome;
    }
    return queued.rows[0]?.outcome === "queued" || queued.rows[0]?.outcome === "replayed"
      ? "pending"
      : "refused";
  };
}
