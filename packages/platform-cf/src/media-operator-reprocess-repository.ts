import { createHash, randomUUID } from "node:crypto";
import { ControlPlaneDb } from "@pirate/application";
import { Effect } from "effect";
import { deterministicMediaWorkflowInstanceId } from "../../domain/src/media-submission.ts";
import { MediaSubmissionRepositoryError } from "./media-submission-repository.ts";

type ReprocessInput = Readonly<{
  communityId: string;
  submissionId: string;
  actorUserId: string;
  operatorPrincipalId: string;
  idempotencyKey: string;
  expectedCreationRevision: number;
  expectedWorkflowRevision: number;
  evidenceRef: string;
}>;
type Row = Readonly<Record<string, unknown>>;

// Database primitive only. The caller must establish operator authority before
// invoking it; the ordinary author/moderation endpoints do not expose it.
// This store owns no provider capability and never mutates processing attempts.
export const reprocessMediaSubmission = Effect.fn("media.operatorReprocess")(function* (
  input: ReprocessInput,
) {
  const reject = (
    reason:
      | "invalid-input"
      | "not-found"
      | "stale-revision"
      | "idempotency-conflict"
      | "transition-rejected"
      | "invalid-row",
  ) =>
    new MediaSubmissionRepositoryError({
      operation: "workflow",
      reason,
      submissionId: input.submissionId,
    });
  if (
    ![
      input.communityId,
      input.submissionId,
      input.actorUserId,
      input.operatorPrincipalId,
      input.idempotencyKey,
      input.evidenceRef,
    ].every(
      (value) =>
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 512 &&
        value.trim() === value &&
        !value.includes("\0"),
    ) ||
    ![input.expectedCreationRevision, input.expectedWorkflowRevision].every(
      (value) => Number.isSafeInteger(value) && value >= 1,
    )
  )
    return yield* Effect.fail(reject("invalid-input"));
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify([
        "media-operator-reprocess-reset-budget-v1",
        input.communityId,
        input.submissionId,
        input.actorUserId,
        input.operatorPrincipalId,
        input.expectedCreationRevision,
        input.expectedWorkflowRevision,
        input.evidenceRef,
      ]),
    )
    .digest("hex");
  const db = yield* ControlPlaneDb;
  return yield* db.withTransaction((tx) =>
    Effect.gen(function* () {
      const loaded = yield* tx.execute<Row>({
        label: "media-operator-reprocess.lock",
        text: "SELECT * FROM media_post_submissions WHERE community_id=$1 AND actor_user_id=$2 AND submission_id=$3 FOR UPDATE",
        values: [input.communityId, input.actorUserId, input.submissionId],
        readonly: false,
      });
      const current = loaded.rows[0];
      if (current === undefined) return yield* Effect.fail(reject("not-found"));
      const operationId = current.operation_id;
      if (typeof operationId !== "string") return yield* Effect.fail(reject("invalid-row"));
      const prior = yield* tx.execute<Row>({
        label: "media-operator-reprocess.replay",
        text: "SELECT request_hash,resulting_creation_revision,resulting_workflow_revision,outbox_event_id FROM media_operator_reprocess_actions WHERE operation_id=$1 AND idempotency_key=$2",
        values: [operationId, input.idempotencyKey],
        readonly: true,
      });
      if (prior.rows[0] !== undefined) {
        const action = prior.rows[0];
        if (action.request_hash !== requestHash)
          return yield* Effect.fail(reject("idempotency-conflict"));
        return {
          kind: "replay" as const,
          submissionId: input.submissionId,
          operationId,
          creationRevision: Number(action.resulting_creation_revision),
          workflowRevision: Number(action.resulting_workflow_revision),
          outboxEventId: String(action.outbox_event_id),
        };
      }
      if (
        Number(current.creation_revision) !== input.expectedCreationRevision ||
        Number(current.workflow_revision) !== input.expectedWorkflowRevision
      )
        return yield* Effect.fail(reject("stale-revision"));
      if (
        current.status !== "processing_failed" ||
        current.failure_code !== "workflow_terminal_unconverged" ||
        current.post_id !== null ||
        !["analysis", "decision", "publish"].includes(String(current.last_safe_phase))
      )
        return yield* Effect.fail(reject("transition-rejected"));

      // Published authority is never reopened. Completed publication/alignment
      // is handled by normal reconciliation; this transition only resumes an
      // unpublished operation and preserves audio/analysis/lyrics identities.
      const publication = yield* tx.execute<Row>({
        label: "media-operator-reprocess.publication",
        text: "SELECT post_id FROM media_publication_projections WHERE operation_id=$1",
        values: [operationId],
        readonly: true,
      });
      if (publication.rows.length !== 0) return yield* Effect.fail(reject("transition-rejected"));
      const replacementBudgetBefore = Number(current.workflow_replacement_sequence);
      if (!Number.isSafeInteger(replacementBudgetBefore) || replacementBudgetBefore < 0)
        return yield* Effect.fail(reject("invalid-row"));
      const creationRevision = input.expectedCreationRevision + 1;
      const workflowRevision = input.expectedWorkflowRevision + 1;
      const outboxEventId = `media-operator-reprocess-${randomUUID()}`;
      const instanceId = deterministicMediaWorkflowInstanceId(operationId, workflowRevision);
      yield* tx.execute({
        label: "media-operator-reprocess.audit",
        text: `INSERT INTO media_operator_reprocess_actions
          (operation_id,submission_id,community_id,actor_user_id,operator_principal_id,idempotency_key,request_hash,
           expected_creation_revision,resulting_creation_revision,expected_workflow_revision,resulting_workflow_revision,
           outbox_event_id,reason_code,evidence_ref,replacement_budget_before,replacement_budget_after)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'workflow_terminal_unconverged',$13,$14,0)`,
        values: [
          operationId,
          input.submissionId,
          input.communityId,
          input.actorUserId,
          input.operatorPrincipalId,
          input.idempotencyKey,
          requestHash,
          input.expectedCreationRevision,
          creationRevision,
          input.expectedWorkflowRevision,
          workflowRevision,
          outboxEventId,
          input.evidenceRef,
          replacementBudgetBefore,
        ],
        readonly: false,
      });
      if (current.current_terms_revision !== null) {
        const copied = yield* tx.execute({
          label: "media-operator-reprocess.terms",
          text: `INSERT INTO media_submission_terms
            (submission_id,community_id,actor_user_id,operation_id,creation_revision,license_preset,
             commercial_remix_share_bps,royalty_allocations,access_mode,terms_snapshot,author_persona_id)
            SELECT submission_id,community_id,actor_user_id,operation_id,$1,license_preset,
              commercial_remix_share_bps,royalty_allocations,access_mode,terms_snapshot,author_persona_id
            FROM media_submission_terms WHERE operation_id=$2 AND submission_id=$3 AND creation_revision=$4`,
          values: [
            creationRevision,
            operationId,
            input.submissionId,
            current.current_terms_revision,
          ],
          readonly: false,
        });
        if (copied.rowCount !== 1) return yield* Effect.fail(reject("invalid-row"));
      }
      const changed = yield* tx.execute<Row>({
        label: "media-operator-reprocess.update",
        text: `UPDATE media_post_submissions SET creation_revision=creation_revision+1,workflow_revision=workflow_revision+1,workflow_replacement_sequence=0,
          current_terms_revision=CASE WHEN current_terms_revision IS NULL THEN NULL ELSE creation_revision+1 END,
          status='processing',phase=CASE WHEN last_safe_phase='publish' THEN 'decision' ELSE last_safe_phase END,
          decision_revision=(SELECT COALESCE(max(d.decision_revision),0) FROM media_publication_decisions d WHERE d.operation_id=media_post_submissions.operation_id),current_decision_revision=NULL,failure_code=NULL,failure_retry_count=NULL,
          retryable=NULL,last_safe_phase=NULL,event_sequence=event_sequence+1,updated_at=clock_timestamp()
          WHERE community_id=$1 AND actor_user_id=$2 AND submission_id=$3 AND creation_revision=$4 AND workflow_revision=$5
          RETURNING *`,
        values: [
          input.communityId,
          input.actorUserId,
          input.submissionId,
          input.expectedCreationRevision,
          input.expectedWorkflowRevision,
        ],
        readonly: false,
      });
      const next = changed.rows[0];
      if (changed.rowCount !== 1 || next === undefined)
        return yield* Effect.fail(reject("stale-revision"));
      yield* tx.execute({
        label: "media-operator-reprocess.event",
        text: `INSERT INTO media_submission_events (submission_id,community_id,actor_user_id,author_persona_id,operation_id,
          event_sequence,event_id,event_kind,creation_revision,audio_revision,analysis_revision,decision_revision,workflow_revision,evidence)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'workflow_replaced',$8,$9,$10,$11,$12,$13::jsonb)`,
        values: [
          input.submissionId,
          input.communityId,
          input.actorUserId,
          next.author_persona_id,
          operationId,
          next.event_sequence,
          `media-event-${randomUUID()}`,
          creationRevision,
          next.audio_revision,
          next.analysis_revision,
          next.decision_revision,
          workflowRevision,
          JSON.stringify({
            event_kind: "workflow_replaced",
            action: "operator_reprocess",
            replacement_budget_before: replacementBudgetBefore,
            replacement_budget_after: 0,
            idempotency_key: input.idempotencyKey,
            operator_principal_id: input.operatorPrincipalId,
            request_hash: requestHash,
            evidence_ref: input.evidenceRef,
          }),
        ],
        readonly: false,
      });
      yield* tx.execute({
        label: "media-operator-reprocess.outbox",
        text: `INSERT INTO media_submission_outbox (outbox_event_id,submission_id,community_id,actor_user_id,author_persona_id,
          operation_id,creation_revision,audio_revision,analysis_revision,lyrics_revision,workflow_revision,workflow_instance_id,
          event_type,effect_identity,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'workflow_replacement',$1,$13::jsonb)`,
        values: [
          outboxEventId,
          input.submissionId,
          input.communityId,
          input.actorUserId,
          next.author_persona_id,
          operationId,
          creationRevision,
          next.audio_revision,
          next.analysis_revision,
          next.current_lyrics_revision,
          workflowRevision,
          instanceId,
          JSON.stringify({
            kind: "workflow_replacement",
            submission_id: input.submissionId,
            operation_id: operationId,
            replacement_sequence: Number(next.workflow_replacement_sequence),
            workflow_revision: workflowRevision,
            workflow_instance_id: instanceId,
          }),
        ],
        readonly: false,
      });
      return {
        kind: "reprocessed" as const,
        submissionId: input.submissionId,
        operationId,
        creationRevision,
        workflowRevision,
        outboxEventId,
      };
    }),
  );
});
