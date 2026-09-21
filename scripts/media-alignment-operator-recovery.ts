import { readFile } from "node:fs/promises";
import { ControlPlaneDb } from "@pirate/application";
import { Effect, Schema } from "effect";
import { makeControlPlaneMediaSubmissionRepository } from "../packages/platform-cf/src/media-submission-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.isPattern(/^[^\s\0](?:[^\0]*[^\s\0])?$/u),
);
const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const PositiveRevision = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const AlignmentRecoveryRequest = Schema.Struct({
  communityId: Identifier,
  submissionId: Identifier,
  actorUserId: Identifier,
  personaId: Identifier,
  idempotencyKey: Identifier,
  evidenceRef: Identifier,
  expectedWorkflowRevision: PositiveRevision,
  expected: Schema.Struct({
    postId: Identifier,
    audioRevision: PositiveRevision,
    analysisRevision: PositiveRevision,
    lyricsRevision: PositiveRevision,
    canonicalAudioSha256: Hash,
    lyricsSha256: Hash,
  }),
});

export function parseMediaAlignmentRecoveryRequest(value: unknown) {
  return Schema.decodeUnknownSync(AlignmentRecoveryRequest, { onExcessProperty: "error" })(value);
}

export async function runMediaAlignmentOperatorRecovery(
  args: readonly string[],
  connectionString?: string,
) {
  if (
    args.length < 2 ||
    args.length > 3 ||
    args[0] !== "--request" ||
    !args[1] ||
    (args.length === 3 && args[2] !== "--execute")
  ) {
    throw new Error("usage: --request <json-file> [--execute]");
  }
  const request = parseMediaAlignmentRecoveryRequest(JSON.parse(await readFile(args[1], "utf8")));
  if (!connectionString?.trim()) throw new Error("CONTROL_PLANE_POSTGRES_ADMIN_URL_required");
  const layer = makeDirectPostgresControlPlaneLayer(
    normalizePostgresConnectionString(connectionString),
  );
  const store = makeControlPlaneMediaSubmissionRepository();
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const identity = yield* db.execute<Readonly<Record<string, unknown>>>({
          label: "media-alignment-operator-recovery.authority",
          text: `SELECT session_user AS principal,current_database() AS database_name,
        (r.rolsuper OR pg_has_role(session_user,d.datdba,'USAGE')) AS authorized
        FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
        WHERE r.rolname=session_user`,
          values: [],
          readonly: true,
        });
        const actor = identity.rows[0];
        if (actor?.authorized !== true || typeof actor.principal !== "string") {
          return yield* Effect.fail(new Error("database_operator_required"));
        }
        const operatorPrincipalId = `postgres:${actor.principal}`;
        if (args[2] !== "--execute") {
          const preview = yield* db.execute<Readonly<Record<string, unknown>>>({
            label: "media-alignment-operator-recovery.preview",
            text: `SELECT submission.operation_id,submission.author_persona_id,
          submission.status,submission.workflow_revision::integer AS workflow_revision,
          submission.post_id,publication.audio_revision::integer AS audio_revision,
          publication.analysis_revision::integer AS analysis_revision,
          publication.lyrics_revision::integer AS lyrics_revision,
          publication.canonical_audio_sha256,
          CASE WHEN publication.lyrics_text IS NULL THEN NULL
            ELSE encode(sha256(convert_to(publication.lyrics_text,'UTF8')),'hex')
          END AS lyrics_sha256,
          alignment.status AS alignment_status,alignment.failure_code AS alignment_failure_code,
          recovery.recovery_action_id,recovery.state AS recovery_state,
          recovery.result_kind AS recovery_result_kind
        FROM media_post_submissions submission
        LEFT JOIN media_publication_projections publication
          ON publication.community_id=submission.community_id
         AND publication.actor_user_id=submission.actor_user_id
         AND publication.submission_id=submission.submission_id
         AND publication.operation_id=submission.operation_id
         AND publication.post_id=submission.post_id
        LEFT JOIN media_alignment_projections alignment
          ON alignment.community_id=publication.community_id
         AND alignment.actor_user_id=publication.actor_user_id
         AND alignment.submission_id=publication.submission_id
         AND alignment.operation_id=publication.operation_id
         AND alignment.post_id=publication.post_id
         AND alignment.audio_revision=publication.audio_revision
         AND alignment.analysis_revision=publication.analysis_revision
         AND alignment.lyrics_revision=publication.lyrics_revision
         AND alignment.canonical_audio_sha256=publication.canonical_audio_sha256
        LEFT JOIN media_alignment_recovery_actions recovery
          ON recovery.community_id=publication.community_id
         AND recovery.actor_user_id=publication.actor_user_id
         AND recovery.submission_id=publication.submission_id
         AND recovery.operation_id=publication.operation_id
         AND recovery.post_id=publication.post_id
         AND recovery.audio_revision=publication.audio_revision
         AND recovery.analysis_revision=publication.analysis_revision
         AND recovery.lyrics_revision=publication.lyrics_revision
        WHERE submission.community_id=$1 AND submission.actor_user_id=$2
          AND submission.submission_id=$3`,
            values: [request.communityId, request.actorUserId, request.submissionId],
            readonly: true,
          });
          return {
            execute: false,
            database: actor.database_name,
            operatorPrincipalId,
            request,
            current: preview.rows[0] ?? null,
          } as const;
        }
        const result = yield* store.requestAlignmentRecovery({ ...request, operatorPrincipalId });
        return {
          execute: true,
          database: actor.database_name,
          operatorPrincipalId,
          result,
        } as const;
      }).pipe(Effect.provide(layer)),
    ),
  );
}

if (import.meta.main) {
  try {
    const result = await runMediaAlignmentOperatorRecovery(
      Bun.argv.slice(2),
      process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL,
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    // Database causes may contain credentials. Only emit allowlisted reasons.
    const reason =
      typeof error === "object" && error !== null && "reason" in error ? error.reason : null;
    const safeReasons = [
      "invalid-input",
      "not-found",
      "idempotency-conflict",
      "stale-revision",
      "transition-rejected",
      "invalid-row",
    ];
    const code =
      typeof reason === "string" && safeReasons.includes(reason)
        ? reason
        : error instanceof Error && error.message === "database_operator_required"
          ? "database_operator_required"
          : "alignment_operator_recovery_failed";
    console.error(JSON.stringify({ code, success: false }));
    process.exitCode = 1;
  }
}
