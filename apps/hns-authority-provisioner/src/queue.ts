import { Client } from "pg";

type HnsAuthorityProvisionClaim = Readonly<{
  readonly provision_job_id: string;
  readonly root_import_session_id: string;
  readonly operation_kind: "provision_root_v1";
  readonly request_bytes: Uint8Array;
  readonly request_sha256: string;
  readonly lease_fence: number;
}>;

export type HnsAuthorityProvisionFinalizeInput = Readonly<{
  readonly provision_job_id: string;
  readonly executor_id: string;
  readonly lease_fence: number;
  readonly request_sha256: string;
}> &
  (
    | Readonly<{
        readonly outcome: "completed";
        readonly publish_plan_bytes: Uint8Array;
        readonly publish_plan_sha256: string;
        readonly result_bytes: Uint8Array;
        readonly result_sha256: string;
      }>
    | Readonly<{ readonly outcome: "retry" | "failed"; readonly failure_code: string }>
  );

export type HnsAuthorityProvisionFinalizeResult = Readonly<{
  readonly outcome:
    | "completed"
    | "retry"
    | "failed"
    | "replayed"
    | "conflict"
    | "lost"
    | "not_found";
  readonly root_import_session_id: string | null;
  readonly session_revision: number | null;
}>;

export type HnsAuthorityProvisionQueue = Readonly<{
  readonly claim: (
    executorId: string,
    leaseSeconds: number,
  ) => Promise<HnsAuthorityProvisionClaim | null>;
  readonly finalize: (
    input: HnsAuthorityProvisionFinalizeInput,
  ) => Promise<HnsAuthorityProvisionFinalizeResult>;
}>;

function safePositiveInteger(value: unknown): number | null {
  const parsed = typeof value === "string" && /^[1-9][0-9]*$/u.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function bytes(value: unknown): Uint8Array | null {
  return value instanceof Uint8Array ? new Uint8Array(value) : null;
}

async function withClient<A>(
  connectionString: string,
  use: (client: Client) => Promise<A>,
): Promise<A> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

export function makePostgresHnsAuthorityProvisionQueue(
  connectionString: string,
): HnsAuthorityProvisionQueue {
  if (connectionString.trim() !== connectionString || connectionString.length === 0) {
    throw new Error("HNS authority queue configuration is invalid");
  }
  return {
    claim: (executorId, leaseSeconds) =>
      withClient(connectionString, async (client) => {
        const result = await client.query<Record<string, unknown>>(
          "SELECT * FROM claim_hns_authority_provision_job_v1($1, $2)",
          [executorId, leaseSeconds],
        );
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1) throw new Error("HNS authority queue returned multiple jobs");
        const row = result.rows[0];
        const requestBytes = bytes(row?.request_bytes);
        const leaseFence = safePositiveInteger(row?.lease_fence);
        if (
          typeof row?.provision_job_id !== "string" ||
          typeof row.root_import_session_id !== "string" ||
          row.operation_kind !== "provision_root_v1" ||
          requestBytes === null ||
          typeof row.request_sha256 !== "string" ||
          !/^[0-9a-f]{64}$/u.test(row.request_sha256) ||
          leaseFence === null
        ) {
          throw new Error("HNS authority queue returned an invalid job");
        }
        return {
          provision_job_id: row.provision_job_id,
          root_import_session_id: row.root_import_session_id,
          operation_kind: row.operation_kind,
          request_bytes: requestBytes,
          request_sha256: row.request_sha256,
          lease_fence: leaseFence,
        };
      }),
    finalize: (input) =>
      withClient(connectionString, async (client) => {
        const completed = input.outcome === "completed";
        const result = await client.query<Record<string, unknown>>(
          "SELECT * FROM finalize_hns_authority_provision_job_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            input.provision_job_id,
            input.executor_id,
            input.lease_fence,
            input.request_sha256,
            input.outcome,
            completed ? Buffer.from(input.publish_plan_bytes) : null,
            completed ? input.publish_plan_sha256 : null,
            completed ? Buffer.from(input.result_bytes) : null,
            completed ? input.result_sha256 : null,
            completed ? null : input.failure_code,
          ],
        );
        if (result.rows.length !== 1) throw new Error("HNS authority finalizer returned no result");
        const row = result.rows[0];
        if (row === undefined) throw new Error("HNS authority finalizer returned no result");
        const revision =
          row.session_revision === null ? null : safePositiveInteger(row.session_revision);
        if (
          !["completed", "retry", "failed", "replayed", "conflict", "lost", "not_found"].includes(
            typeof row.outcome === "string" ? row.outcome : "",
          ) ||
          (row.root_import_session_id !== null && typeof row.root_import_session_id !== "string") ||
          (row.session_revision !== null && revision === null)
        ) {
          throw new Error("HNS authority finalizer returned an invalid result");
        }
        return {
          outcome: row.outcome as HnsAuthorityProvisionFinalizeResult["outcome"],
          root_import_session_id: row.root_import_session_id as string | null,
          session_revision: revision,
        };
      }),
  };
}
