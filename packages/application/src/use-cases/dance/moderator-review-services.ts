import { Data, Effect } from "effect";
import {
  type DanceOwnerDetailV1,
  type DanceOwnerQueueV1,
  type DanceReviewCommandReceiptV1,
  type DanceReviewCommandV1,
  type DanceReviewPrivateResultV1,
  type DanceReviewTaskV1,
  decodeDanceReviewCommandReceiptV1,
  decodeDanceReviewCommandV1,
  decodeDanceReviewPrivateResultV1,
  decodeDanceReviewTaskV1,
  type LatestModeratedDanceReviewV1,
  type ModeratedDancePublicationV1,
} from "../../../../contracts/src/dance-review.ts";
import {
  type ModeratorReview,
  type ReviewActor,
  type ReviewEvent,
  type ReviewFacts,
  type ReviewTransition,
  transitionModeratorReview,
} from "../../../../domain/src/dance/moderator-review.ts";
import { canonicalBodyHash } from "../content/common.ts";

export class DanceReviewServiceFailure extends Data.TaggedError("DanceReviewServiceFailure")<{
  readonly reason:
    | "invalid_request"
    | "not_found"
    | "unauthorized"
    | "idempotency_conflict"
    | "revision_conflict"
    | "unavailable"
    | "outcome_unknown";
}> {}
export type DanceReviewAction = Readonly<{
  actor: ReviewActor;
  operation: DanceReviewCommandV1["operation"] | DanceReviewTaskV1["operation"];
  idempotencyKey: string;
  requestHash: string;
  receiptId: string;
  communityId: string;
  reviewId: string;
}>;
export interface DanceReviewTransaction {
  /** Account lifecycle -> own command key -> review/handoff locks. Enforce
   * current private read/erasure access, without NEW business/evidence guards.
   * Keep all locks until receipt/state/intents commit together. No media URL.
   * A separately authenticated worker may read the exact task subject for
   * erasure/failed-handoff drains after its account fence changes. This is
   * internal cleanup access, never an erased account's private/media access.
   */
  readonly lockAndAuthorizeRead: (
    action: DanceReviewAction,
  ) => Effect.Effect<ModeratorReview, DanceReviewServiceFailure>;
  /** Scope is authenticated actor kind/account + operation + key, not target.
   * This read must distinguish a proven miss from every unknown read outcome.
   */
  readonly findReceipt: (
    action: DanceReviewAction,
  ) => Effect.Effect<
    Readonly<{ requestHash: string; receipt: unknown }> | null,
    DanceReviewServiceFailure
  >;
  readonly clockAfterLocks: () => Effect.Effect<number, DanceReviewServiceFailure>;
  /** Accepted persisted evidence/current owner and bound finite policies only.
   * No provider/object/normalization/inspection I/O inside this transaction.
   */
  readonly facts: (
    state: ModeratorReview,
    actor: ReviewActor,
    operation: DanceReviewAction["operation"],
    now: number,
  ) => Effect.Effect<ReviewFacts, DanceReviewServiceFailure>;
  /** One CAS on review+publication revisions and the observed lifecycle fence,
   * including active status; retain the distinct immutable capture fence.
   * Do not require observed == capture for a worker cleanup-only transition
   * or an unchanged refusal receipt. New review/qualification/release effects
   * still require active original-fence authority. Post-pass cleanup may only
   * change publication status/revision and enqueue same-generation cancel and
   * temporary-cleanup intents bounded by the ORIGINAL transfer deadline.
   * It preserves verdict, qualification, Submit and prior command receipts;
   * it cannot touch an independently owned Post. A fence change between facts
   * and commit must reject the whole write, including cleanup/receipt intents.
   * Persist the immutable
   * command receipt, state, and uniquely keyed result/cleanup/handoff intents.
   * Any qualification intent requires one actual admitted insert in the SAME
   * transaction before the response can expose its reference. No financial
   * consumer/drawing/payout authority is supplied by this interface.
   */
  readonly commit: (
    input: Readonly<{
      action: DanceReviewAction;
      beforeReviewRevision: number;
      beforePublicationRevision: number;
      captureAccountFenceRevision: number;
      observedAccountFenceRevision: number;
      observedAccountActive: boolean;
      transition: ReviewTransition;
      receipt: DanceReviewCommandReceiptV1;
    }>,
  ) => Effect.Effect<void, DanceReviewServiceFailure>;
}
export interface DanceReviewServices {
  /** api-next session + exact Origin/CSRF + current account; never body claims. */
  readonly authenticateAccount: () => Effect.Effect<ReviewActor, DanceReviewServiceFailure>;
  /** Separately admitted internal task identity; never a browser bearer switch. */
  readonly authenticateWorker: () => Effect.Effect<ReviewActor, DanceReviewServiceFailure>;
  /** Port implementation must preserve cancellation, original causes and
   * unknown COMMIT/rollback outcomes; it MUST NOT replay this callback.
   * The production adapter uses the same retained-outcome CP transaction as Funding.
   */
  readonly withTransaction: <A, E, R>(
    use: (tx: DanceReviewTransaction) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | DanceReviewServiceFailure, R>;
}

export interface DanceReviewReadStore {
  readonly getOwnResult: (
    communityId: string,
    reviewId: string,
  ) => Effect.Effect<DanceReviewPrivateResultV1, DanceReviewServiceFailure>;
  readonly getPublication: (
    communityId: string,
    reviewId: string,
  ) => Effect.Effect<ModeratedDancePublicationV1, DanceReviewServiceFailure>;
  readonly getLatest: (
    communityId: string,
    postId: string,
    choreographyId: string,
    revision: number,
  ) => Effect.Effect<LatestModeratedDanceReviewV1, DanceReviewServiceFailure>;
  readonly ownerQueue: (
    communityId: string,
    cursor: string | null,
  ) => Effect.Effect<DanceOwnerQueueV1, DanceReviewServiceFailure>;
  readonly ownerDetail: (
    communityId: string,
    reviewId: string,
  ) => Effect.Effect<DanceOwnerDetailV1, DanceReviewServiceFailure>;
}

/** Account-private DTO only. Queue/media projections and actual read routes
 * need their own current-authorization adapters; no URL or account/wallet/key
 * is copied into an immutable command response.
 */
export function projectPrivateDanceReview(state: ModeratorReview): DanceReviewPrivateResultV1 {
  const c = state.capture,
    p = c.policy;
  const instant = (n: number | null) => (n === null ? null : new Date(n).toISOString());
  return decodeDanceReviewPrivateResultV1({
    version: "dance-private-review-v1",
    review_id: c.reviewId,
    session_id: c.sessionId,
    attempt_id: c.attemptId,
    community_id: c.communityId,
    song_post_id: c.songPostId,
    audio_revision: c.audioRevision,
    choreography_id: c.choreographyId,
    choreography_revision: c.choreographyRevision,
    segment_id: c.segmentId,
    review_revision: state.revision,
    session_terms_hash: c.termsHash,
    qualification_policy_version: p.qualificationVersion,
    qualification_policy_hash: p.qualificationHash,
    captured_policy: {
      version: p.version,
      hash: p.hash,
      rubric_version: p.rubricVersion,
      rubric_hash: p.rubricHash,
      normalization_version: p.normalizationVersion,
      normalization_hash: p.normalizationHash,
      safety_hash: p.safetyHash,
      retention_hash: p.retentionHash,
      admission: p.admission,
      admission_version: p.admissionVersion,
      admission_hash: p.admissionHash,
    },
    state: state.state,
    uploaded_at: instant(c.uploadedAtMs),
    submitted_at: instant(state.submittedAtMs),
    review_deadline: instant(state.reviewDeadlineMs),
    terminal_at: instant(state.terminalAtMs),
    verdict: state.verdict,
    score_bps: null,
    qualification_ref: state.qualificationRef,
    cue_attestation: state.attestation?.cue ?? null,
    initial_submit_receipt:
      state.initialSubmit === null
        ? null
        : {
            receipt_id: state.initialSubmit.id,
            show_publicly_if_passed: state.initialSubmit.showPublicly,
            publication_disclosure_version: state.initialSubmit.disclosureVersion,
            submitted_at: instant(state.initialSubmit.submittedAtMs),
          },
    show_publicly_if_passed: state.showPublicly,
    publication_choice_revision: state.choiceRevision,
    publication_status: state.publication,
    publication_revision: state.publicationRevision,
  });
}

const refuse = (reason: DanceReviewServiceFailure["reason"]) =>
  new DanceReviewServiceFailure({ reason });
function eventFor(
  command: DanceReviewCommandV1 | DanceReviewTaskV1,
  receiptId: string,
): ReviewEvent {
  switch (command.operation) {
    case "submit":
      return {
        kind: "submit",
        showPublicly: command.show_publicly_if_passed,
        disclosureVersion: command.publication_disclosure_version,
        receiptId,
      };
    case "visibility":
      return {
        kind: "visibility",
        showPublicly: command.show_publicly_if_passed,
        disclosureVersion: command.publication_disclosure_version,
      };
    case "verdict":
      return { kind: "verdict", verdict: command.verdict, version: command.version };
    case "publication_failed":
      return { kind: "publication_failed", generation: command.handoff_generation };
    default:
      return { kind: command.operation };
  }
}

const execute = Effect.fn("ModeratorReview.execute")(function* (
  body: unknown,
  services: DanceReviewServices,
  kind: "account" | "worker",
) {
  const actor = yield* kind === "account"
    ? services.authenticateAccount()
    : services.authenticateWorker();
  if (actor.kind !== kind || !actor.accountId) return yield* refuse("unauthorized");
  const command = yield* Effect.try({
    try: () =>
      kind === "account" ? decodeDanceReviewCommandV1(body) : decodeDanceReviewTaskV1(body),
    catch: () => refuse("invalid_request"),
  });
  const requestHash = yield* canonicalBodyHash([
    "pirate.dance-review-command.v1",
    actor.kind,
    actor.accountId,
    command,
  ]).pipe(Effect.mapError(() => refuse("unavailable")));
  const receiptId = yield* canonicalBodyHash([
    "pirate.dance-review-receipt.v1",
    actor.kind,
    actor.accountId,
    command.operation,
    command.idempotency_key,
  ]).pipe(Effect.mapError(() => refuse("unavailable")));
  const action: DanceReviewAction = {
    actor,
    operation: command.operation,
    idempotencyKey: command.idempotency_key,
    requestHash,
    receiptId,
    communityId: command.community_id,
    reviewId: command.review_id,
  };
  return yield* services.withTransaction((tx) =>
    Effect.gen(function* () {
      const before = yield* tx.lockAndAuthorizeRead(action);
      if (
        before.capture.reviewId !== command.review_id ||
        before.capture.communityId !== command.community_id
      )
        return yield* refuse("not_found");
      const old = yield* tx.findReceipt(action);
      if (old !== null) {
        if (old.requestHash !== requestHash) return yield* refuse("idempotency_conflict");
        return yield* Effect.try({
          try: () => {
            const receipt = decodeDanceReviewCommandReceiptV1(old.receipt);
            if (
              receipt.receipt_id !== receiptId ||
              receipt.review_id !== command.review_id ||
              receipt.operation !== command.operation
            )
              throw refuse("unavailable");
            return receipt;
          },
          catch: () => refuse("unavailable"),
        });
      }
      const now = yield* tx.clockAfterLocks();
      const facts = yield* tx.facts(before, actor, command.operation, now);
      const transition = transitionModeratorReview(
        before,
        eventFor(command, receiptId),
        actor,
        command.expected_review_revision,
        now,
        facts,
      );
      const receipt = yield* Effect.try({
        try: () =>
          decodeDanceReviewCommandReceiptV1({
            version: "dance-review-receipt-v1",
            receipt_id: receiptId,
            review_id: command.review_id,
            operation: command.operation,
            outcome: transition.refusal === null ? "applied" : "refused",
            refusal_code: transition.refusal,
            committed_at: new Date(now).toISOString(),
            result: projectPrivateDanceReview(transition.state),
          }),
        catch: () => refuse("unavailable"),
      });
      yield* tx.commit({
        action,
        beforeReviewRevision: before.revision,
        beforePublicationRevision: before.publicationRevision,
        captureAccountFenceRevision: before.capture.accountFenceRevision,
        observedAccountFenceRevision: facts.accountFenceRevision,
        observedAccountActive: facts.accountActive,
        transition,
        receipt,
      });
      return receipt;
    }),
  );
});

export const executeDanceReviewCommand = (body: unknown, services: DanceReviewServices) =>
  execute(body, services, "account");
export const processDanceReviewTask = (body: unknown, services: DanceReviewServices) =>
  execute(body, services, "worker");
