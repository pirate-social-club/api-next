import { readFile } from "node:fs/promises";
import { ControlPlaneDb } from "@pirate/application";
import { Effect, Schema } from "effect";
import { makeDataRegistrationStore } from "../packages/platform-cf/src/data-registration-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.isPattern(/^[^\s\0](?:[^\0]*[^\s\0])?$/u),
);
const Request = Schema.Struct({
  registrationOperationId: Identifier,
  idempotencyKey: Identifier,
  evidenceRef: Identifier,
  reasonCode: Schema.Literal("explicit_additional_workflow_attempt"),
  reviewedWorkflowDisposition: Schema.Literals(["finished", "missing"]),
  expectedWorkflowRevision: Schema.Literal(4),
});
export function parseDataAdditionalAttemptRequest(
  value: unknown,
): Schema.Schema.Type<typeof Request> {
  try {
    return Schema.decodeUnknownSync(Request, { onExcessProperty: "error" })(value);
  } catch {
    throw new Error("invalid_request");
  }
}

export async function runDataOperatorAdditionalAttempt(
  args: readonly string[],
  connectionString?: string,
) {
  const preview = args.length === 2 && args[0] === "--request" && !!args[1];
  const execute =
    args.length === 4 &&
    args[0] === "--request" &&
    !!args[1] &&
    args[2] === "--execute" &&
    args[3] === "--assert-reviewed-terminal";
  if ((!preview && !execute) || args[1] === undefined)
    throw new Error("usage: --request <json-file> [--execute --assert-reviewed-terminal]");
  const request = parseDataAdditionalAttemptRequest(JSON.parse(await readFile(args[1], "utf8")));
  if (!connectionString?.trim()) throw new Error("CONTROL_PLANE_POSTGRES_ADMIN_URL_required");
  const layer = makeDirectPostgresControlPlaneLayer(
    normalizePostgresConnectionString(connectionString),
  );
  const identity = await Effect.runPromise(
    Effect.provide(layer)(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Readonly<Record<string, unknown>>>({
          label: "data-operator-additional-attempt.authority",
          text: `SELECT session_user AS principal,current_database() AS database_name,
        (r.rolsuper OR pg_has_role(session_user,d.datdba,'USAGE')) AS authorized
        FROM pg_roles r JOIN pg_database d ON d.datname=current_database() WHERE r.rolname=session_user`,
          values: [],
          readonly: true,
        });
        return result.rows[0];
      }),
    ),
  );
  if (identity?.authorized !== true || typeof identity.principal !== "string")
    throw new Error("database_operator_required");
  const operatorPrincipalId = `postgres:${identity.principal}`;
  const database = identity.database_name;
  if (!execute) {
    const current = await Effect.runPromise(
      Effect.provide(layer)(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Readonly<Record<string, unknown>>>({
            label: "data-operator-additional-attempt.preview",
            text: `SELECT operation.registration_operation_id,operation.community_id,
          operation.actor_user_id,operation.submission_id,operation.state,
          operation.workflow_revision,operation.workflow_instance_id,operation.current_attempt_id,
          operation.failure_code,launch.outbox_id AS current_outbox_id,
          launch.state AS current_outbox_state,launch.event_type AS current_outbox_event_type,
          (SELECT count(*)::int FROM data_registration_signing_attempts WHERE registration_operation_id=operation.registration_operation_id) AS attempt_count,
          (SELECT count(*)::int FROM data_registration_attempt_transitions WHERE registration_operation_id=operation.registration_operation_id) AS transition_count,
          (SELECT count(*)::int FROM data_registration_receipt_observations WHERE registration_operation_id=operation.registration_operation_id) AS receipt_count,
          action.idempotency_key AS prior_idempotency_key, action.outbox_id AS prior_outbox_id
          FROM data_registration_operations operation
          LEFT JOIN data_registration_outbox launch ON launch.registration_operation_id=operation.registration_operation_id
            AND launch.workflow_revision=operation.workflow_revision AND launch.workflow_instance_id=operation.workflow_instance_id
          LEFT JOIN data_operator_additional_workflow_attempt_actions action ON action.registration_operation_id=operation.registration_operation_id
          WHERE operation.registration_operation_id=$1`,
            values: [request.registrationOperationId],
            readonly: true,
          });
          return result.rows[0] ?? null;
        }),
      ),
    );
    return { execute: false, database, operatorPrincipalId, request, current };
  }
  const result = await makeDataRegistrationStore(layer).requestAdditionalWorkflowAttempt({
    ...request,
    operatorPrincipalId,
    expectedWorkflowRevision: 4n,
  });
  return { execute: true, database, operatorPrincipalId, result };
}

if (import.meta.main) {
  try {
    const result = await runDataOperatorAdditionalAttempt(
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
    const reason =
      typeof error === "object" && error !== null && "reason" in error ? error.reason : null;
    const code =
      typeof reason === "string" &&
      ["invalid-input", "not-found", "stale-state", "identity-conflict"].includes(reason)
        ? reason
        : error instanceof Error && error.message === "database_operator_required"
          ? "database_operator_required"
          : "operator_additional_attempt_failed";
    console.error(JSON.stringify({ code, success: false }));
    process.exitCode = 1;
  }
}
