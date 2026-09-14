import { readFile } from "node:fs/promises";
import { ControlPlaneDb } from "@pirate/application";
import { Effect } from "effect";
import { reprocessMediaSubmission } from "../packages/platform-cf/src/media-operator-reprocess-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";

type Request = Omit<Parameters<typeof reprocessMediaSubmission>[0], "operatorPrincipalId">;

export function parseReprocessRequest(value: unknown): Request {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid_request");
  const row = value as Record<string, unknown>;
  const strings = ["communityId", "submissionId", "actorUserId", "idempotencyKey", "evidenceRef"];
  const revisions = ["expectedCreationRevision", "expectedWorkflowRevision"];
  if (
    Object.keys(row).length !== strings.length + revisions.length ||
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
    revisions.some((key) => !Number.isSafeInteger(row[key]) || Number(row[key]) < 1)
  )
    throw new Error("invalid_request");
  return row as Request;
}

export async function runOperatorReprocess(args: readonly string[], connectionString?: string) {
  if (
    args.length < 2 ||
    args.length > 3 ||
    args[0] !== "--request" ||
    !args[1] ||
    (args.length === 3 && args[2] !== "--execute")
  )
    throw new Error("usage: --request <json-file> [--execute]");
  const request = parseReprocessRequest(JSON.parse(await readFile(args[1], "utf8")));
  if (!connectionString?.trim()) throw new Error("CONTROL_PLANE_POSTGRES_ADMIN_URL_required");
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const identity = yield* db.execute<Readonly<Record<string, unknown>>>({
          label: "media-operator-command.authority",
          text: `SELECT session_user AS principal, current_database() AS database_name,
        (r.rolsuper OR pg_has_role(session_user,d.datdba,'USAGE')) AS authorized
        FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
        WHERE r.rolname=session_user`,
          values: [],
          readonly: true,
        });
        const actor = identity.rows[0];
        if (actor?.authorized !== true || typeof actor.principal !== "string")
          return yield* Effect.fail(new Error("database_operator_required"));
        const operatorPrincipalId = `postgres:${actor.principal}`;
        if (args[2] !== "--execute") {
          const current = yield* db.execute<Readonly<Record<string, unknown>>>({
            label: "media-operator-command.preview",
            text: `SELECT operation_id,status,phase,failure_code,last_safe_phase,
          creation_revision,workflow_revision,workflow_replacement_sequence,post_id
          FROM media_post_submissions WHERE community_id=$1 AND actor_user_id=$2 AND submission_id=$3`,
            values: [request.communityId, request.actorUserId, request.submissionId],
            readonly: true,
          });
          return {
            execute: false,
            database: actor.database_name,
            operatorPrincipalId,
            request,
            current: current.rows[0] ?? null,
          };
        }
        const result = yield* reprocessMediaSubmission({ ...request, operatorPrincipalId });
        return { execute: true, database: actor.database_name, operatorPrincipalId, result };
      }).pipe(
        Effect.provide(
          makeDirectPostgresControlPlaneLayer(normalizePostgresConnectionString(connectionString)),
        ),
      ),
    ),
  );
}

if (import.meta.main) {
  try {
    const result = await runOperatorReprocess(
      Bun.argv.slice(2),
      process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL,
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    // Driver causes can include connection details. Keep credentials out of output.
    const reason =
      typeof error === "object" && error !== null && "reason" in error ? error.reason : null;
    const safeReasons = [
      "invalid-input",
      "not-found",
      "stale-revision",
      "idempotency-conflict",
      "transition-rejected",
      "invalid-row",
    ];
    const code =
      typeof reason === "string" && safeReasons.includes(reason)
        ? reason
        : "operator_reprocess_failed";
    console.error(JSON.stringify({ code, success: false }));
    process.exitCode = 1;
  }
}
