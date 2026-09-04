import { Client } from "pg";

type HnsRootObservationClaim = Readonly<{
  readonly observation_job_id: string;
  readonly root_import_session_id: string;
  readonly operation_kind: "observe_root_v1" | "teardown_root_v1" | "renew_health_v1";
  readonly request_bytes: Uint8Array;
  readonly request_sha256: string;
  readonly publish_plan_bytes: Uint8Array;
  readonly publish_plan_sha256: string;
  readonly provision_result_bytes: Uint8Array;
  readonly provision_result_sha256: string;
  readonly lease_fence: number;
}>;

type HnsRootObservationFinalizeInput = Readonly<{
  readonly observation_job_id: string;
  readonly operation_kind: HnsRootObservationClaim["operation_kind"];
  readonly executor_id: string;
  readonly lease_fence: number;
  readonly request_sha256: string;
}> &
  (
    | Readonly<{
        readonly outcome: "ready";
        readonly result_bytes: Uint8Array;
        readonly result_sha256: string;
      }>
    | Readonly<{ readonly outcome: "retry" | "failed"; readonly failure_code: string }>
  );

export type HnsRootObservationFinalizeResult = Readonly<{
  readonly outcome: "ready" | "retry" | "failed" | "replayed" | "conflict" | "lost" | "not_found";
  readonly root_import_session_id: string | null;
  readonly session_revision: number | null;
}>;

export type HnsRootObservationQueue = Readonly<{
  readonly claim: (
    executorId: string,
    leaseSeconds: number,
  ) => Promise<HnsRootObservationClaim | null>;
  readonly finalize: (
    input: HnsRootObservationFinalizeInput,
  ) => Promise<HnsRootObservationFinalizeResult>;
}>;

function positiveInteger(value: unknown): number | null {
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

export function makePostgresHnsRootObservationQueue(
  connectionString: string,
): HnsRootObservationQueue {
  if (connectionString.trim() !== connectionString || connectionString.length === 0) {
    throw new Error("HNS root observation queue configuration is invalid");
  }
  return {
    claim: (executorId, leaseSeconds) =>
      withClient(connectionString, async (client) => {
        let result = await client.query<Record<string, unknown>>(
          "SELECT * FROM claim_hns_root_import_observation_job_v1($1,$2)",
          [executorId, leaseSeconds],
        );
        if (result.rows.length === 0) {
          result = await client.query<Record<string, unknown>>(
            "SELECT * FROM claim_hns_root_health_renewal_job_v1($1,$2)",
            [executorId, leaseSeconds],
          );
        }
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1)
          throw new Error("HNS observation queue returned multiple jobs");
        const row = result.rows[0];
        const requestBytes = bytes(row?.request_bytes);
        const publishPlanBytes = bytes(row?.publish_plan_bytes);
        const provisionResultBytes = bytes(row?.provision_result_bytes);
        const leaseFence = positiveInteger(row?.lease_fence);
        if (
          typeof row?.observation_job_id !== "string" ||
          typeof row.root_import_session_id !== "string" ||
          (row.operation_kind !== "observe_root_v1" &&
            row.operation_kind !== "teardown_root_v1" &&
            row.operation_kind !== "renew_health_v1") ||
          requestBytes === null ||
          publishPlanBytes === null ||
          provisionResultBytes === null ||
          typeof row.request_sha256 !== "string" ||
          typeof row.publish_plan_sha256 !== "string" ||
          typeof row.provision_result_sha256 !== "string" ||
          ![row.request_sha256, row.publish_plan_sha256, row.provision_result_sha256].every(
            (value) => /^[0-9a-f]{64}$/u.test(value),
          ) ||
          leaseFence === null
        ) {
          throw new Error("HNS observation queue returned an invalid job");
        }
        return {
          observation_job_id: row.observation_job_id,
          root_import_session_id: row.root_import_session_id,
          operation_kind: row.operation_kind,
          request_bytes: requestBytes,
          request_sha256: row.request_sha256,
          publish_plan_bytes: publishPlanBytes,
          publish_plan_sha256: row.publish_plan_sha256,
          provision_result_bytes: provisionResultBytes,
          provision_result_sha256: row.provision_result_sha256,
          lease_fence: leaseFence,
        };
      }),
    finalize: (input) =>
      withClient(connectionString, async (client) => {
        const ready = input.outcome === "ready";
        const finalizer =
          input.operation_kind === "renew_health_v1"
            ? "finalize_hns_root_health_renewal_job_v1"
            : "finalize_hns_root_import_observation_job_v1";
        const result = await client.query<Record<string, unknown>>(
          `SELECT * FROM ${finalizer}($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            input.observation_job_id,
            input.executor_id,
            input.lease_fence,
            input.request_sha256,
            input.outcome,
            ready ? Buffer.from(input.result_bytes) : null,
            ready ? input.result_sha256 : null,
            ready ? null : input.failure_code,
          ],
        );
        if (result.rows.length !== 1)
          throw new Error("HNS observation finalizer returned no result");
        const row = result.rows[0];
        const revision =
          row?.session_revision === null ? null : positiveInteger(row?.session_revision);
        const outcomes = ["ready", "retry", "failed", "replayed", "conflict", "lost", "not_found"];
        if (
          row === undefined ||
          typeof row.outcome !== "string" ||
          !outcomes.includes(row.outcome) ||
          (row.root_import_session_id !== null && typeof row.root_import_session_id !== "string") ||
          (row.session_revision !== null && revision === null)
        ) {
          throw new Error("HNS observation finalizer returned an invalid result");
        }
        return {
          outcome: row.outcome as HnsRootObservationFinalizeResult["outcome"],
          root_import_session_id: row.root_import_session_id as string | null,
          session_revision: revision,
        };
      }),
  };
}
