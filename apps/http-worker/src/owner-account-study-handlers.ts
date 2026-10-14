import { PERSONA_WALLET_SETUP_SESSION_SCOPE } from "@pirate/application/use-cases/identity-registration-handler";
import {
  ControlPlaneOperationTimedOut,
  ControlPlaneStatementFailed,
  ControlPlaneTransactionOutcomeUnknown,
  GuestParticipationStoreRejected,
  StudyV2CommandRejected,
  StudyV2StoreFailed,
} from "@pirate/application/use-cases/owner-financial-study";
import {
  AuthError,
  BadRequest,
  GetAccountStudyRewardPreviewV1,
  GetOwnerAccountStudySessionV1,
  GetOwnerAccountStudyStartOperationV1,
  GetPublicGuestStudyPreparedContentV2,
  GuestConflict,
  GuestPendingConflict,
  InternalError,
  NotFound,
  ProviderUnavailable,
  StartOwnerAccountStudySessionV1,
  StudyAnswerSubmissionV2,
  SubmitOwnerAccountStudyAnswerV1,
} from "@pirate/contracts";
import type { OwnerAccountStudyFacade } from "@pirate/platform-cf/owner-account-study-facade";
import { Effect, Schema } from "effect";
import {
  type DecodedRequest,
  type EndpointHandlerResult,
  withEndpointResult,
} from "./transport.ts";

const definitions = {
  GetPublicGuestStudyPreparedContentV2,
  GetAccountStudyRewardPreviewV1,
  StartOwnerAccountStudySessionV1,
  GetOwnerAccountStudySessionV1,
  GetOwnerAccountStudyStartOperationV1,
  SubmitOwnerAccountStudyAnswerV1,
} as const;
export type OwnerAccountStudyHandlerName = keyof typeof definitions;
function ordinary(request: DecodedRequest) {
  if (
    request.principal?.kind !== "user" ||
    request.principal.scopes?.includes(PERSONA_WALLET_SETUP_SESSION_SCOPE) ||
    request.browserParticipation !== undefined
  )
    throw new AuthError({ message: "Ordinary browser authentication required" });
  return request.principal.subject;
}
function read<S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  } catch {
    throw new BadRequest({ message: "Invalid Study request" });
  }
}
function egress<S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  } catch {
    throw new InternalError({ message: "Study projection is unavailable" });
  }
}
type Operation = Readonly<{ kind: "study_start" | "study_answer"; key: string }>;
const uncertain = (error: unknown) =>
  error instanceof ControlPlaneTransactionOutcomeUnknown ||
  ((error instanceof ControlPlaneOperationTimedOut ||
    error instanceof ControlPlaneStatementFailed) &&
    error.outcomeCertainty === "unknown") ||
  (error instanceof StudyV2StoreFailed && error.reason === "outcome-unknown");
function wire(error: unknown, operation?: Operation) {
  if (
    error instanceof AuthError ||
    error instanceof BadRequest ||
    error instanceof NotFound ||
    error instanceof InternalError ||
    error instanceof ProviderUnavailable
  )
    return error;
  if (
    (uncertain(error) ||
      (error instanceof StudyV2CommandRejected && error.reason === "command-in-flight")) &&
    operation !== undefined
  )
    return new GuestPendingConflict({
      message: "Original Study operation requires confirmation",
      details: {
        reason_code: "operation_pending_confirmation",
        operation: {
          operation_kind: operation.kind,
          idempotency_key: operation.key,
          operation_id: null,
        },
        retry_after_seconds: 5,
      },
    });
  if (error instanceof StudyV2CommandRejected) {
    switch (error.reason) {
      case "not-found":
      case "transcript-evidence-not-found":
        return new NotFound({ message: "Study target is unavailable", cause: error });
      case "idempotency-conflict":
        return new GuestConflict({
          message: "Original Study request conflicts",
          details: { reason_code: "idempotency_conflict" },
        });
      case "attempt-conflict":
      case "insufficient-exercises":
        return new GuestConflict({
          message: "Study source is unavailable",
          details: { reason_code: "guest_authority_conflict" },
        });
      case "provider-unavailable":
      case "command-in-flight":
        return new ProviderUnavailable({ message: "Study operation is unavailable", cause: error });
      default:
        return new BadRequest({ message: "Study request is invalid", cause: error });
    }
  }
  if (error instanceof GuestParticipationStoreRejected && error.reason === "not-found")
    return new NotFound({ message: "Study target is unavailable", cause: error });
  if (error instanceof ControlPlaneStatementFailed) {
    if (error.sqlState === "GP002" || error.sqlState === "GP009")
      return new NotFound({ message: "Study target is unavailable", cause: error });
    if (error.sqlState === "GP005")
      return new GuestConflict({
        message: "Original Study request conflicts",
        details: { reason_code: "idempotency_conflict" },
      });
    if (error.sqlState === "GP006")
      return new GuestConflict({
        message: "Study reward preview changed",
        details: { reason_code: "reward_preview_changed" },
      });
  }
  return new ProviderUnavailable({ message: "Study operation is unavailable", cause: error });
}
export function makeOwnerAccountStudyHandlers(
  facade: OwnerAccountStudyFacade,
): Readonly<
  Record<OwnerAccountStudyHandlerName, (request: DecodedRequest) => Promise<EndpointHandlerResult>>
> {
  const output = <S extends Schema.ConstraintDecoder<unknown>>(
    schema: S,
    value: unknown,
    status = 200,
  ) => withEndpointResult(egress(schema, value), status, { "cache-control": "private, no-store" });
  const run = <A, E>(effect: Effect.Effect<A, E>, operation?: Operation) =>
    Effect.runPromise(effect.pipe(Effect.mapError((error) => wire(error, operation))));
  return {
    GetPublicGuestStudyPreparedContentV2: async (request) => {
      const path = read(GetPublicGuestStudyPreparedContentV2.request.path, request.params),
        query = read(GetPublicGuestStudyPreparedContentV2.request.query, request.query);
      return output(
        GetPublicGuestStudyPreparedContentV2.response,
        await run(
          facade.publicPrepared({
            communityId: path.communityId,
            postId: path.postId,
            targetLanguage: query.target_language ?? null,
            learnerBand: query.learner_band ?? null,
          }),
        ),
      );
    },
    GetAccountStudyRewardPreviewV1: async (request) => {
      const accountId = ordinary(request),
        path = read(GetAccountStudyRewardPreviewV1.request.path, request.params),
        query = read(GetAccountStudyRewardPreviewV1.request.query, request.query);
      return output(
        GetAccountStudyRewardPreviewV1.response,
        await run(
          facade.preview({
            accountId,
            communityId: path.communityId,
            postId: path.postId,
            personaId: query.persona_id,
            targetLanguage: query.target_language ?? null,
            learnerBand: query.learner_band ?? null,
          }),
        ),
      );
    },
    StartOwnerAccountStudySessionV1: async (request) => {
      const accountId = ordinary(request),
        path = read(StartOwnerAccountStudySessionV1.request.path, request.params),
        body = read(StartOwnerAccountStudySessionV1.request.body, request.body);
      const result = await run(
        facade.start({ accountId, communityId: path.communityId, postId: path.postId, body }),
        { kind: "study_start", key: body.idempotency_key },
      );
      return output(StartOwnerAccountStudySessionV1.response, result, 201);
    },
    GetOwnerAccountStudySessionV1: async (request) => {
      const accountId = ordinary(request),
        path = read(GetOwnerAccountStudySessionV1.request.path, request.params);
      return output(
        GetOwnerAccountStudySessionV1.response,
        await run(
          facade.getSession({
            accountId,
            communityId: path.communityId,
            sessionId: path.sessionId,
          }),
        ),
      );
    },
    GetOwnerAccountStudyStartOperationV1: async (request) => {
      const accountId = ordinary(request),
        path = read(GetOwnerAccountStudyStartOperationV1.request.path, request.params);
      return output(
        GetOwnerAccountStudyStartOperationV1.response,
        await run(
          facade.findStart({
            accountId,
            communityId: path.communityId,
            postId: path.postId,
            idempotencyKey: path.idempotencyKey,
          }),
        ),
      );
    },
    SubmitOwnerAccountStudyAnswerV1: async (request) => {
      const accountId = ordinary(request),
        path = read(SubmitOwnerAccountStudyAnswerV1.request.path, request.params),
        headers = read(SubmitOwnerAccountStudyAnswerV1.request.headers, request.headers);
      const common = {
        accountId,
        communityId: path.communityId,
        sessionId: path.sessionId,
        sessionItemId: path.sessionItemId,
        attemptNumber: Number(headers["x-study-attempt-number"]),
        idempotencyKey: headers["idempotency-key"],
      };
      let result: Schema.Schema.Type<typeof SubmitOwnerAccountStudyAnswerV1.response>;
      if (request.body instanceof Uint8Array) {
        if (
          headers["content-type"] === "application/json" ||
          headers["x-audio-duration-ms"] === undefined ||
          request.body.byteLength < 1 ||
          request.body.byteLength > 524288
        )
          throw new BadRequest({ message: "Study audio is invalid" });
        result = await run(
          facade.submitAudio({
            ...common,
            audio: request.body,
            audioContentType: headers["content-type"],
            audioDurationMs: Number(headers["x-audio-duration-ms"]),
          }),
          { kind: "study_answer", key: common.idempotencyKey },
        );
      } else {
        if (headers["content-type"] !== "application/json")
          throw new BadRequest({ message: "Study submission kind is invalid" });
        result = await run(
          facade.submitChoice({ ...common, answer: read(StudyAnswerSubmissionV2, request.body) }),
          { kind: "study_answer", key: common.idempotencyKey },
        );
      }
      return output(SubmitOwnerAccountStudyAnswerV1.response, result);
    },
  };
}
