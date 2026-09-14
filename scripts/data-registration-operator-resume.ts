import { readFile } from "node:fs/promises";
import { ControlPlaneDb } from "@pirate/application";
import { Effect } from "effect";
import { makeDataRegistrationStore } from "../packages/platform-cf/src/data-registration-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";

type Request = Readonly<{
  registrationOperationId: string;
  idempotencyKey: string;
  evidenceRef: string;
  reasonCode: "receipt_inconclusive" | "terms_evidence_unavailable";
  expectedWorkflowRevision: number;
}>;

export function parseDataResumeRequest(value: unknown): Request {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid_request");
  }
  const row = value as Record<string, unknown>;
  const strings = ["registrationOperationId", "idempotencyKey", "evidenceRef"];
  if (
    Object.keys(row).length !== strings.length + 2 ||
    strings.some((key) => {
      const entry = row[key];
      return (
        typeof entry !== "string" ||
        entry.length < 1 ||
        entry.length > 512 ||
        entry.trim() !== entry ||
        entry.includes("\0")
      );
    }) ||
    (row.reasonCode !== "receipt_inconclusive" &&
      row.reasonCode !== "terms_evidence_unavailable") ||
    !Number.isSafeInteger(row.expectedWorkflowRevision) ||
    Number(row.expectedWorkflowRevision) < 1
  ) {
    throw new Error("invalid_request");
  }
  return row as Request;
}

export async function runDataOperatorResume(args: readonly string[], connectionString?: string) {
  if (
    args.length < 2 ||
    args.length > 3 ||
    args[0] !== "--request" ||
    !args[1] ||
    (args.length === 3 && args[2] !== "--execute")
  ) {
    throw new Error("usage: --request <json-file> [--execute]");
  }
  const request = parseDataResumeRequest(JSON.parse(await readFile(args[1], "utf8")));
  if (!connectionString?.trim()) throw new Error("CONTROL_PLANE_POSTGRES_ADMIN_URL_required");
  const layer = makeDirectPostgresControlPlaneLayer(
    normalizePostgresConnectionString(connectionString),
  );
  const identity = await Effect.runPromise(
    Effect.provide(layer)(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Readonly<Record<string, unknown>>>({
          label: "data-operator-resume.authority",
          text: `SELECT session_user AS principal, current_database() AS database_name,
        (r.rolsuper OR pg_has_role(session_user,d.datdba,'USAGE')) AS authorized
        FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
        WHERE r.rolname=session_user`,
          values: [],
          readonly: true,
        });
        return result.rows[0];
      }),
    ),
  );
  if (identity?.authorized !== true || typeof identity.principal !== "string") {
    throw new Error("database_operator_required");
  }
  const operatorPrincipalId = `postgres:${identity.principal}`;
  const database = identity.database_name;
  if (args[2] !== "--execute") {
    const current = await Effect.runPromise(
      Effect.provide(layer)(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Readonly<Record<string, unknown>>>({
            label: "data-operator-resume.preview",
            text: `SELECT registration_operation_id,community_id,actor_user_id,submission_id,
              state,workflow_revision,current_attempt_id,failure_code
              FROM data_registration_operations WHERE registration_operation_id=$1`,
            values: [request.registrationOperationId],
            readonly: true,
          });
          return result.rows[0] ?? null;
        }),
      ),
    );
    return { execute: false, database, operatorPrincipalId, request, current };
  }
  const store = makeDataRegistrationStore(layer);
  const result = await store.resumeReconciliation({
    registrationOperationId: request.registrationOperationId,
    operatorPrincipalId,
    idempotencyKey: request.idempotencyKey,
    evidenceRef: request.evidenceRef,
    reasonCode: request.reasonCode,
    expectedWorkflowRevision: BigInt(request.expectedWorkflowRevision),
  });
  return { execute: true, database, operatorPrincipalId, result };
}

if (import.meta.main) {
  try {
    const result = await runDataOperatorResume(
      Bun.argv.slice(2),
      process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL,
    );
    console.log(
      JSON.stringify(
        result,
        (_key, value) => (typeof value === "bigint" ? value.toString() : value),
        2,
      ),
    );
  } catch (error) {
    // Driver causes can include connection details. Keep credentials out of output.
    const reason =
      typeof error === "object" && error !== null && "reason" in error ? error.reason : null;
    const safeReasons = ["invalid-input", "not-found", "stale-state", "identity-conflict"];
    const code =
      typeof reason === "string" && safeReasons.includes(reason)
        ? reason
        : error instanceof Error && error.message === "database_operator_required"
          ? "database_operator_required"
          : "operator_resume_failed";
    console.error(JSON.stringify({ code, success: false }));
    process.exitCode = 1;
  }
}
