import type { Client } from "pg";
import { promoteImportedHnsInventorySuccessor } from "./hns-imported-inventory-successor.ts";

type ReadyInput = {
  readonly observation_job_id: string;
  readonly executor_id: string;
  readonly lease_fence: number;
  readonly request_sha256: string;
  readonly result_bytes: Uint8Array;
  readonly result_sha256: string;
};
type FinalizeResult = {
  readonly outcome: "ready" | "retry" | "failed" | "replayed" | "conflict" | "lost" | "not_found";
  readonly root_import_session_id: string | null;
  readonly session_revision: number | null;
};

export class HnsInventoryRenewalCommitUnknown extends Error {
  constructor(readonly rootImportSessionId: string) {
    super("HNS inventory renewal commit outcome requires reconciliation");
  }
}

export async function finalizeImportedInventoryRenewal(
  client: Client,
  input: ReadyInput,
): Promise<FinalizeResult> {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  let transactionOpen = true;
  try {
    await client.query("SET LOCAL lock_timeout TO '10s'");
    await client.query("SET LOCAL statement_timeout TO '20s'");
    const prepared = await client.query<{
      outcome: FinalizeResult["outcome"] | "prepared";
      root_import_session_id: string | null;
      session_revision: string | null;
    }>("SELECT * FROM prepare_hns_root_inventory_renewal_v1($1,$2,$3,$4,'ready',$5,$6,NULL)", [
      input.observation_job_id,
      input.executor_id,
      input.lease_fence,
      input.request_sha256,
      Buffer.from(input.result_bytes),
      input.result_sha256,
    ]);
    const row = prepared.rows[0];
    if (prepared.rows.length !== 1 || row === undefined)
      throw new Error("HNS inventory renewal preparation returned invalid rows");
    if (row.outcome === "prepared") {
      await promoteImportedHnsInventorySuccessor(client, input.result_bytes, input.result_sha256);
      const completed = await client.query(
        `UPDATE hns_root_health_renewal_jobs
        SET state='completed', leased_by=NULL, lease_expires_at=NULL,
          result_bytes=$5::bytea, result_sha256=$6, failure_code=NULL,
          completed_at=clock_timestamp(), updated_at=clock_timestamp()
        WHERE renewal_job_id=$1 AND state='leased' AND leased_by=$2
          AND lease_fence=$3 AND lease_expires_at>clock_timestamp()
          AND root_import_session_id=$4 RETURNING renewal_job_id`,
        [
          input.observation_job_id,
          input.executor_id,
          input.lease_fence,
          row.root_import_session_id,
          Buffer.from(input.result_bytes),
          input.result_sha256,
        ],
      );
      if (completed.rowCount !== 1) {
        await client.query("ROLLBACK");
        transactionOpen = false;
        return {
          outcome: "lost",
          root_import_session_id: row.root_import_session_id,
          session_revision: row.session_revision === null ? null : Number(row.session_revision),
        };
      }
    }
    transactionOpen = false;
    try {
      await client.query("COMMIT");
    } catch {
      throw new HnsInventoryRenewalCommitUnknown(row.root_import_session_id ?? "");
    }
    return {
      outcome: row.outcome === "prepared" ? "ready" : row.outcome,
      root_import_session_id: row.root_import_session_id,
      session_revision: row.session_revision === null ? null : Number(row.session_revision),
    };
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK");
    throw error;
  }
}
