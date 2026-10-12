// PRIVATE REVIEW PROPOSAL. No public route, flag, frozen port or client edit.
import {
  Clock,
  ControlPlaneOperationTimedOut,
  ControlPlaneStatementFailed,
  ControlPlaneTransactionOutcomeUnknown,
  canonicalBodyHash,
  type DurableParticipationOutcome,
  type GuestLearningAccess,
  type GuestLearningRetentionStore,
  type GuestParticipationReadStore,
  GuestParticipationStoreRejected,
  type GuestRecoveryAccess,
  IdGen,
  type ParticipationOperationIdentity,
} from "@pirate/application";
import type { OwnerLearnerAudioDeletionStore } from "@pirate/application/owner-learner-audio-deletion";
import {
  DeleteGuestLearnerAudioV1,
  GetGuestStudySessionV1,
  GetGuestStudyStartOperationV1,
  GetPublicStudyPreparedContentV1,
  GuestAuthError,
  GuestBadRequest,
  GuestConflict,
  GuestOperationLocatorV1,
  GuestPendingConflict,
  GuestSha256V1,
  InternalError,
  ListGuestParticipationsV1,
  NotFound,
  ProviderUnavailable,
  RateLimited,
  SetGuestLearningRetentionV1,
  StartGuestStudySessionV1,
  SubmitGuestStudyAnswerV1,
} from "@pirate/contracts";
import { Effect, Schema } from "effect";
import { LearnerAudioStorageOutcomeUnknown } from "../../../packages/application/src/learner-audio-io-outcome.ts";
import {
  type makeOwnerGuestStudyService,
  OwnerGuestStudyCommandRejected,
} from "../../../packages/application/src/owner-guest-study-service.ts";
import type { makeOwnerLearnerAudioDeletionIo } from "../../../packages/platform-cf/src/owner-audio-deletion-io.ts";
import { makeGuestStudyTrustedEdge } from "./guest-study-runtime-configuration.ts";
import {
  type DecodedRequest,
  type EndpointHandlerResult,
  withEndpointResult,
} from "./transport.ts";

const definitions = {
  GetPublicStudyPreparedContentV1,
  StartGuestStudySessionV1,
  GetGuestStudyStartOperationV1,
  GetGuestStudySessionV1,
  SubmitGuestStudyAnswerV1,
  ListGuestParticipationsV1,
  SetGuestLearningRetentionV1,
  DeleteGuestLearnerAudioV1,
} as const;
export type GuestLearningControllerName = keyof typeof definitions;
type Study = ReturnType<typeof makeOwnerGuestStudyService>;
type DeletionIo = ReturnType<typeof makeOwnerLearnerAudioDeletionIo>;
export interface GuestLearningControllerServices {
  readonly study: Study;
  readonly participations: GuestParticipationReadStore;
  readonly retention: GuestLearningRetentionStore;
  readonly deletion: OwnerLearnerAudioDeletionStore;
  readonly deletionIo: Pick<DeletionIo, "executeBatch">;
  readonly clock: Clock["Service"];
  readonly ids: IdGen["Service"];
  readonly retryAfterSeconds: number;
}
const internal = () => new InternalError({ message: "Study operation unavailable" });
const invalid = () =>
  new GuestBadRequest({
    message: "Invalid Study request",
    details: { reason_code: "guest_request_invalid" },
  });
function requestValue<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  } catch {
    throw invalid();
  }
}
function projected<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  } catch {
    throw internal();
  }
}
function learning(
  input: DecodedRequest,
  operation: "start" | "read" | "answer" | "operation_result",
): GuestLearningAccess {
  const c = input.browserParticipation;
  if (
    input.principal !== null ||
    c === undefined ||
    c.authority !== "learning" ||
    c.operation !== operation
  )
    throw internal();
  // Account association does not exist in this practice-only source checkpoint.
  // Retained ordinary API/TG handlers continue separately. Never reshape an
  // ordinary account session into the frozen guest wire/session/source branch.
  if (c.access.kind !== "guest") throw internal();
  if (c.access.origin !== c.origin) throw internal();
  return c.access;
}
function recovery(
  input: DecodedRequest,
  operation: "participations" | "retention" | "delete_audio",
): GuestRecoveryAccess {
  const c = input.browserParticipation;
  if (
    input.principal !== null ||
    c === undefined ||
    c.authority !== "recovery" ||
    c.operation !== operation
  )
    throw internal();
  if (c.access.kind !== "guest" || c.access.origin !== c.origin) throw internal();
  return c.access;
}
const unknown = (error: unknown) =>
  error instanceof ControlPlaneTransactionOutcomeUnknown ||
  ((error instanceof ControlPlaneOperationTimedOut ||
    error instanceof ControlPlaneStatementFailed) &&
    error.outcomeCertainty === "unknown");

export function makeGuestLearningControllers(services: GuestLearningControllerServices) {
  if (
    !Number.isInteger(services.retryAfterSeconds) ||
    services.retryAfterSeconds < 1 ||
    services.retryAfterSeconds > 3600
  )
    throw new Error("Reviewed reconciliation delay required");
  const pending = (
    operation: GuestOperationLocatorV1,
    reason:
      | "operation_pending_confirmation"
      | "learning_finalization_pending"
      | "learner_audio_deletion_in_progress" = "operation_pending_confirmation",
  ) =>
    new GuestPendingConflict({
      message: "Operation awaiting confirmation",
      details: { reason_code: reason, operation, retry_after_seconds: services.retryAfterSeconds },
    });
  const wire = (
    error: unknown,
    name: GuestLearningControllerName,
    locator?: GuestOperationLocatorV1,
  ): Error => {
    if (unknown(error)) return locator === undefined ? internal() : pending(locator);
    if (error instanceof LearnerAudioStorageOutcomeUnknown)
      return locator === undefined ? internal() : pending(locator, "learning_finalization_pending");
    if (error instanceof OwnerGuestStudyCommandRejected)
      return error.reason === "invalid-input"
        ? invalid()
        : name === "SubmitGuestStudyAnswerV1"
          ? new ProviderUnavailable({ message: "Study transcription unavailable" })
          : internal();
    if (!(error instanceof GuestParticipationStoreRejected)) return internal();
    switch (error.reason) {
      case "proof-revoked":
        return new GuestAuthError({
          message: "Guest proof revoked",
          details: { reason_code: "guest_proof_revoked" },
        });
      case "lease-expired":
        return new GuestAuthError({
          message: "Learning lease expired",
          details: { reason_code: "guest_learning_lease_expired" },
        });
      case "owner-mismatch":
        return new GuestConflict({
          message: "Original source differs",
          details: { reason_code: "guest_owner_mismatch" },
        });
      case "authority-conflict":
        return new GuestConflict({
          message: "Select original source",
          details: { reason_code: "guest_authority_conflict" },
        });
      case "idempotency-conflict":
        return new GuestConflict({
          message: "Original command differs",
          details: { reason_code: "idempotency_conflict" },
        });
      case "not-found":
        return new NotFound({ message: "Study target unavailable" });
      case "deletion-in-progress":
        return locator === undefined
          ? internal()
          : pending(locator, "learner_audio_deletion_in_progress");
      default:
        return internal();
    }
  };
  const run = <A, E>(
    effect: Effect.Effect<A, E, Clock | IdGen>,
    name: GuestLearningControllerName,
    locator?: GuestOperationLocatorV1,
  ) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(Clock, services.clock),
        Effect.provideService(IdGen, services.ids),
        Effect.catch((error) => Effect.fail(wire(error, name, locator))),
      ),
    );
  const locator = (
    kind: GuestOperationLocatorV1["operation_kind"],
    key: string,
    id: string | null = null,
  ): GuestOperationLocatorV1 =>
    projected(GuestOperationLocatorV1, {
      operation_kind: kind,
      idempotency_key: key,
      operation_id: id,
    });
  const complete = <A>(
    outcome: DurableParticipationOutcome<A>,
    owner: string,
    kind: ParticipationOperationIdentity["kind"],
    key: string,
  ): A => {
    if (
      outcome.operation.sourceOwnerId !== owner ||
      outcome.operation.kind !== kind ||
      outcome.operation.idempotencyKey !== key
    )
      throw internal();
    projected(GuestSha256V1, outcome.operation.requestHash);
    if (outcome.state === "pending_confirmation")
      throw pending(locator(kind, key, outcome.outcomeId));
    // An acknowledged known abort never becomes lesson success, admission or a
    // promise that an absent row is safe to replace. Start lookup alone exposes
    // the frozen not_started witness after its actual serialized reconciliation.
    if (outcome.state === "known_aborted") throw internal();
    projected(GuestOperationLocatorV1, locator(kind, key, outcome.outcomeId));
    return outcome.result;
  };
  const response = (
    name: GuestLearningControllerName,
    body: unknown,
    status?: number,
  ): EndpointHandlerResult =>
    withEndpointResult(projected(definitions[name].response, body), status, {
      "Cache-Control": "private, no-store",
    });
  const operation = async (
    access: GuestRecoveryAccess,
    kind: "learning_retention" | "learner_audio_deletion",
    key: string,
    body: unknown,
  ): Promise<ParticipationOperationIdentity> => ({
    sourceOwnerId: access.ownerId,
    kind,
    idempotencyKey: key,
    requestHash: await Effect.runPromise(
      canonicalBodyHash(["pirate_guest_learning_recovery_v1", access.origin, kind, body]),
    ),
  });
  const deletionProjection = (body: unknown, key: string) => {
    const result = projected(DeleteGuestLearnerAudioV1.response, body);
    if (
      result.operation.operation_kind !== "learner_audio_deletion" ||
      result.operation.idempotency_key !== key ||
      (result.state === "completed" && result.operation.operation_id === null)
    )
      throw internal();
    return response("DeleteGuestLearnerAudioV1", result, result.state === "completed" ? 200 : 202);
  };
  return Object.freeze({
    async dispatch(
      name: GuestLearningControllerName,
      input: DecodedRequest,
    ): Promise<EndpointHandlerResult> {
      switch (name) {
        case "GetPublicStudyPreparedContentV1": {
          if (input.principal !== null || input.browserParticipation !== undefined)
            throw internal();
          const path = requestValue(GetPublicStudyPreparedContentV1.request.path, input.params);
          const query = requestValue(GetPublicStudyPreparedContentV1.request.query, input.query);
          const result = projected(
            GetPublicStudyPreparedContentV1.response,
            await run(
              services.study.getPreparedContent({
                communityId: path.communityId,
                postId: path.postId,
                targetLanguage: query.target_language ?? null,
                learnerBand: query.learner_band ?? null,
              }),
              name,
            ),
          );
          if (result.reward_preview !== null) throw internal();
          return response(name, result);
        }
        case "StartGuestStudySessionV1": {
          const access = learning(input, "start"),
            path = requestValue(StartGuestStudySessionV1.request.path, input.params);
          const body = requestValue(StartGuestStudySessionV1.request.body, input.body);
          if (body.reward_mode !== "practice_only" || body.reward_preview_terms_hash !== null)
            throw internal();
          const c = input.browserParticipation;
          if (c === undefined) throw internal();
          const trustedEdge = await makeGuestStudyTrustedEdge(c.origin, input.edgeClientIp);
          if (trustedEdge === null) throw internal();
          const result = await run(
            services.study.startSession({
              access,
              communityId: path.communityId,
              postId: path.postId,
              body,
              trustedEdge,
            }),
            name,
            locator("study_start", body.idempotency_key),
          );
          if (result.kind === "resource_refused") {
            const refusal = complete(
              result.outcome,
              access.ownerId,
              "study_start",
              body.idempotency_key,
            );
            if (refusal.state === "reserved") throw internal();
            if (refusal.state === "rate_limited") {
              if (
                refusal.retryAfterSeconds !== null &&
                (!Number.isInteger(refusal.retryAfterSeconds) ||
                  refusal.retryAfterSeconds < 1 ||
                  refusal.retryAfterSeconds > 3600)
              )
                throw internal();
              throw new RateLimited({
                message: "Study resource allowance refused",
                ...(refusal.retryAfterSeconds === null
                  ? {}
                  : { retry_after_seconds: refusal.retryAfterSeconds }),
              });
            }
            // Provider/budget composition has no authority to offer a free or
            // monetary alternative. Start's frozen errors do not include ProviderUnavailable.
            throw internal();
          }
          const owned = complete(
            result.outcome,
            access.ownerId,
            "study_start",
            body.idempotency_key,
          );
          if (
            owned.source.kind !== "guest" ||
            owned.source.ownerId !== access.ownerId ||
            owned.session.object !== "guest_study_session_v1" ||
            owned.session.owner_id !== owned.source.ownerId ||
            owned.session.community_id !== path.communityId ||
            owned.session.post_id !== path.postId
          )
            throw internal();
          if (
            owned.session.reward_mode !== "practice_only" ||
            owned.session.reward_terms !== null ||
            owned.session.participation.state !== "practice_only"
          )
            throw internal();
          return response(name, owned.session, 201);
        }
        case "GetGuestStudyStartOperationV1": {
          const access = learning(input, "operation_result"),
            path = requestValue(GetGuestStudyStartOperationV1.request.path, input.params);
          const result = projected(
            GetGuestStudyStartOperationV1.response,
            await run(
              services.study.findStartOperation({
                access,
                sourceOwnerId: access.ownerId,
                communityId: path.communityId,
                postId: path.postId,
                idempotencyKey: path.idempotencyKey,
              }),
              name,
            ),
          );
          if (
            result.state === "completed" &&
            (result.session.owner_id !== access.ownerId ||
              result.session.community_id !== path.communityId ||
              result.session.post_id !== path.postId ||
              result.session.reward_mode !== "practice_only" ||
              result.session.reward_terms !== null ||
              result.session.participation.state !== "practice_only")
          )
            throw internal();
          return response(name, result);
        }
        case "GetGuestStudySessionV1": {
          const access = learning(input, "read"),
            path = requestValue(GetGuestStudySessionV1.request.path, input.params);
          const body = await run(
            services.study.getSession({
              access,
              communityId: path.communityId,
              sessionId: path.sessionId,
            }),
            name,
          );
          if (
            body.owner_id !== access.ownerId ||
            body.community_id !== path.communityId ||
            body.session_id !== path.sessionId
          )
            throw internal();
          if (
            body.reward_mode !== "practice_only" ||
            body.reward_terms !== null ||
            body.participation.state !== "practice_only"
          )
            throw internal();
          return response(name, body);
        }
        case "SubmitGuestStudyAnswerV1": {
          const access = learning(input, "answer"),
            path = requestValue(SubmitGuestStudyAnswerV1.request.path, input.params);
          const headers = requestValue(SubmitGuestStudyAnswerV1.request.headers, input.headers);
          const base = {
            access,
            communityId: path.communityId,
            sessionId: path.sessionId,
            sessionItemId: path.sessionItemId,
            attemptNumber: Number(headers["x-study-attempt-number"]),
            idempotencyKey: headers["idempotency-key"],
          };
          const original = locator("study_answer", base.idempotencyKey);
          const submission = input.body;
          const outcome =
            submission instanceof Uint8Array
              ? await run(
                  (() => {
                    if (
                      headers["content-type"] === "application/json" ||
                      headers["x-audio-duration-ms"] === undefined ||
                      submission.byteLength === 0 ||
                      submission.byteLength > 524288
                    )
                      throw invalid();
                    return services.study.submitSpokenAnswer({
                      ...base,
                      audio: submission,
                      audioContentType: headers["content-type"],
                      audioDurationMs: Number(headers["x-audio-duration-ms"]),
                    });
                  })(),
                  name,
                  original,
                )
              : await run(
                  (() => {
                    if (headers["content-type"] !== "application/json") throw invalid();
                    const answer = requestValue(SubmitGuestStudyAnswerV1.request.body, input.body);
                    return services.study.submitAnswer({ ...base, answer });
                  })(),
                  name,
                  original,
                );
          const owned = complete(outcome, access.ownerId, "study_answer", base.idempotencyKey);
          if (
            owned.source.kind !== "guest" ||
            owned.source.ownerId !== access.ownerId ||
            owned.answer.object !== "guest_study_answer_result_v1" ||
            owned.answer.session.owner_id !== owned.source.ownerId ||
            owned.answer.session.community_id !== path.communityId ||
            owned.answer.session.session_id !== path.sessionId ||
            owned.answer.session_item_id !== path.sessionItemId ||
            owned.answer.attempt_number !== base.attemptNumber
          )
            throw internal();
          if (
            owned.answer.session.reward_mode !== "practice_only" ||
            owned.answer.session.reward_terms !== null ||
            owned.answer.participation.state !== "practice_only" ||
            JSON.stringify(owned.participation) !== JSON.stringify(owned.answer.participation)
          )
            throw internal();
          return response(name, owned.answer);
        }
        case "ListGuestParticipationsV1": {
          const access = recovery(input, "participations"),
            query = requestValue(ListGuestParticipationsV1.request.query, input.query);
          const result = await run(
            services.participations.list({
              access,
              cursor: query.cursor ?? null,
              limit: query.limit === undefined ? 25 : Number(query.limit),
            }),
            name,
          );
          if (result.items.length > (query.limit === undefined ? 25 : Number(query.limit)))
            throw internal();
          return response(name, { items: result.items, next_cursor: result.nextCursor });
        }
        case "SetGuestLearningRetentionV1": {
          const access = recovery(input, "retention"),
            body = requestValue(SetGuestLearningRetentionV1.request.body, input.body);
          const op = await operation(access, "learning_retention", body.idempotency_key, {
            mode: body.mode,
          });
          const outcome = await run(
            services.retention.set({ access, operation: op, mode: body.mode }),
            name,
            locator(op.kind, op.idempotencyKey),
          );
          if (outcome.operation.requestHash !== op.requestHash) throw internal();
          const result = complete(outcome, access.ownerId, op.kind, op.idempotencyKey);
          if (result.mode !== body.mode) throw internal();
          return response(name, result);
        }
        case "DeleteGuestLearnerAudioV1": {
          const access = recovery(input, "delete_audio"),
            headers = requestValue(DeleteGuestLearnerAudioV1.request.headers, input.headers);
          const op = await operation(
            access,
            "learner_audio_deletion",
            headers["idempotency-key"],
            {},
          );
          // The I/O adapter returns only after its short prepare transaction;
          // bucket DELETE happens outside SQL, then exact original batch finalize.
          const outcome = await Effect.runPromise(
            services.deletionIo
              .executeBatch({ access, operation: op, maximumArtifacts: 1000 })
              .pipe(
                Effect.matchEffect({
                  onSuccess: (value) => Effect.succeed({ kind: "outcome" as const, value }),
                  onFailure: (error) =>
                    unknown(error)
                      ? services.deletion
                          .findOperation({
                            access,
                            sourceOwnerId: access.ownerId,
                            idempotencyKey: op.idempotencyKey,
                          })
                          .pipe(
                            Effect.map((value) => ({ kind: "lookup" as const, value })),
                            Effect.catch((failure) =>
                              Effect.fail(wire(failure, name, locator(op.kind, op.idempotencyKey))),
                            ),
                          )
                      : Effect.fail(wire(error, name, locator(op.kind, op.idempotencyKey))),
                }),
              ),
          );
          if (outcome.kind === "lookup")
            return deletionProjection(outcome.value, op.idempotencyKey);
          if (outcome.value.operation.requestHash !== op.requestHash) throw internal();
          const deleted = complete(outcome.value, access.ownerId, op.kind, op.idempotencyKey);
          if (
            outcome.value.state === "completed" &&
            deleted.operation.operation_id !== outcome.value.outcomeId
          )
            throw internal();
          return deletionProjection(deleted, op.idempotencyKey);
        }
      }
    },
  });
}
