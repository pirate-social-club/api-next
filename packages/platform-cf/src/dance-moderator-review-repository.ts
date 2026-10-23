import { Effect, type Layer, Schema } from "effect";
import {
  ControlPlaneAcquireFailed,
  ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneOperationTimedOut,
  ControlPlaneStatementFailed,
  type ControlPlaneTransaction,
  ControlPlaneTransactionOutcomeUnknown,
} from "../../application/src/ports.ts";
import { ActivityQualificationStorageFailed } from "../../application/src/rewards/activity-qualification.ts";
import {
  DanceReviewServiceFailure,
  type DanceReviewServices,
  type DanceReviewTransaction,
  projectPrivateDanceReview,
} from "../../application/src/use-cases/dance/moderator-review-services.ts";
import {
  DanceOwnerDetailV1,
  DanceOwnerQueueV1,
  ModeratedDancePublicationV1,
} from "../../contracts/src/dance-review.ts";
import type { QualificationIntent, ReviewActor } from "../../domain/src/dance/moderator-review.ts";
import {
  ModeratorReviewFactsSchema,
  ModeratorReviewSchema,
} from "../../domain/src/dance/moderator-review-schema.ts";
import { recordQualificationProjections } from "./activity-qualification-repository.ts";
import { withRetainedControlPlaneCommandTransaction } from "./control-plane-command-transaction.ts";

const json = (value: unknown) => JSON.stringify(value);
const failure = (reason: DanceReviewServiceFailure["reason"]) =>
  new DanceReviewServiceFailure({ reason });
const mapError = <E>(error: E | ControlPlaneError): E | DanceReviewServiceFailure => {
  if (
    error instanceof ControlPlaneTransactionOutcomeUnknown ||
    (error instanceof ControlPlaneOperationTimedOut && error.outcomeCertainty === "unknown")
  )
    return failure("outcome_unknown");
  if (error instanceof ControlPlaneStatementFailed) {
    if (error.sqlState === "DRV02") return failure("not_found");
    if (error.sqlState === "DRV03") return failure("idempotency_conflict");
    if (error.sqlState === "DRV05") return failure("revision_conflict");
    if (error.sqlState === "DRV06") return failure("invalid_request");
    return failure("unavailable");
  }
  if (error instanceof ControlPlaneAcquireFailed || error instanceof ControlPlaneOperationTimedOut)
    return failure("unavailable");
  return error;
};
const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value),
    catch: () => failure("unavailable"),
  });
const packet = Effect.fn("DanceReviewRepository.packet")(
  function* (
    tx: Pick<ControlPlaneTransaction, "execute">,
    label: string,
    text: string,
    values: readonly unknown[],
    readonly: boolean,
  ) {
    const result = yield* tx.execute<{ packet: unknown }>({ label, text, values, readonly });
    if (
      result.rows.length !== 1 ||
      result.rows[0] === undefined ||
      !Object.hasOwn(result.rows[0], "packet")
    )
      return yield* failure("outcome_unknown");
    return result.rows[0].packet;
  },
  Effect.mapError((e) => mapError<DanceReviewServiceFailure>(e)),
);

export type DanceReviewAuthorization = Readonly<{
  account: () => Effect.Effect<ReviewActor, DanceReviewServiceFailure>;
  worker: () => Effect.Effect<ReviewActor, DanceReviewServiceFailure>;
}>;

/** The real adapter to the separate categorical review aggregate. No provider,
 * object copying, safety inference, media URL or financial operation occurs in
 * a transaction. The existing CP transaction implementation runs once.
 */
export function makeControlPlaneModeratorReviewStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  authorization: DanceReviewAuthorization,
) {
  const provided = <A, E, R>(effect: Effect.Effect<A, E | ControlPlaneError, R | ControlPlaneDb>) =>
    effect.pipe(Effect.provide(runtime), Effect.mapError(mapError));
  const services: DanceReviewServices = {
    authenticateAccount: authorization.account,
    authenticateWorker: authorization.worker,
    withTransaction: (use) =>
      provided(
        withRetainedControlPlaneCommandTransaction((tx) => {
          const ports: DanceReviewTransaction = {
            lockAndAuthorizeRead: (action) =>
              packet(
                tx,
                "dance-review.authorized-lock",
                "SELECT lock_moderated_dance_review_v1($1::jsonb) AS packet",
                [json(action)],
                false,
              ).pipe(Effect.flatMap((value) => decode(ModeratorReviewSchema, value))),
            findReceipt: (action) =>
              packet(
                tx,
                "dance-review.receipt.read",
                "SELECT read_moderated_dance_receipt_v1($1::jsonb) AS packet",
                [json(action)],
                true,
              ).pipe(
                Effect.flatMap((value) =>
                  value === null
                    ? Effect.succeed(null)
                    : decode(
                        Schema.Struct({ requestHash: Schema.String, receipt: Schema.Unknown }),
                        value,
                      ),
                ),
              ),
            clockAfterLocks: () =>
              packet(
                tx,
                "dance-review.locked-clock",
                "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS packet",
                [],
                true,
              ).pipe(
                Effect.flatMap((value) =>
                  decode(
                    Schema.NumberFromString.check(
                      Schema.isInt(),
                      Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
                    ),
                    value,
                  ),
                ),
              ),
            facts: (state, actor, operation, now) =>
              packet(
                tx,
                "dance-review.current-facts",
                "SELECT moderated_dance_review_facts_v1($1,$2::jsonb,$3,$4::bigint) AS packet",
                [state.capture.reviewId, json(actor), operation, now],
                true,
              ).pipe(Effect.flatMap((value) => decode(ModeratorReviewFactsSchema, value))),
            commit: (input) =>
              Effect.gen(function* () {
                const result = yield* packet(
                  tx,
                  "dance-review.commit",
                  "SELECT commit_moderated_dance_review_v1($1::jsonb) AS packet",
                  [json(input)],
                  false,
                );
                const confirmed = yield* decode(
                  Schema.Struct({
                    committed: Schema.Literal(true),
                    qualificationId: Schema.NullOr(Schema.NonEmptyString),
                  }),
                  result,
                );
                const qualification: QualificationIntent | null | undefined =
                  input.transition.intents.find(
                    (intent) => intent.kind === "qualification",
                  )?.qualification;
                if (qualification !== undefined && qualification !== null) {
                  if (
                    confirmed.qualificationId !== qualification.id ||
                    input.transition.state.qualificationRef !== qualification.id
                  )
                    return yield* failure("outcome_unknown");
                  yield* recordQualificationProjections(tx, {
                    accountId: qualification.accountId,
                    communityId: qualification.communityId,
                    personaId: input.transition.state.capture.personaId,
                    postId: qualification.songPostId,
                    activity: "dance",
                    qualificationId: qualification.id,
                    qualifiedAt: new Date(qualification.qualifiedAtMs).toISOString(),
                    streakDay: qualification.submissionDay,
                    timezone: qualification.timezone,
                  }).pipe(
                    Effect.mapError((e) =>
                      e instanceof ActivityQualificationStorageFailed
                        ? failure(
                            e.reason === "outcome-unknown" ? "outcome_unknown" : "unavailable",
                          )
                        : mapError<DanceReviewServiceFailure>(e),
                    ),
                  );
                } else if (confirmed.qualificationId !== null)
                  return yield* failure("outcome_unknown");
              }),
          };
          return use(ports);
        }),
      ),
  };
  const getOwnResult = Effect.fn("DanceReviewRepository.getOwnResult")(function* (
    communityId: string,
    reviewId: string,
  ) {
    const actor = yield* authorization.account();
    if (actor.kind !== "account") return yield* failure("unauthorized");
    const value = yield* provided(
      Effect.gen(function* () {
        return yield* packet(
          yield* ControlPlaneDb,
          "dance-review.result.read",
          "SELECT read_owned_moderated_dance_review_v1($1,$2,$3) AS packet",
          [actor.accountId, communityId, reviewId],
          true,
        );
      }),
    );
    if (value === null) return yield* failure("not_found");
    return projectPrivateDanceReview(yield* decode(ModeratorReviewSchema, value));
  });
  const read = Effect.fn("DanceReviewRepository.read")(function* (
    kind: "latest" | "queue" | "owner" | "publication",
    args: readonly unknown[],
  ) {
    const actor = yield* authorization.account();
    if (actor.kind !== "account") return yield* failure("unauthorized");
    const sql =
      kind === "publication"
        ? "SELECT read_owned_moderated_dance_publication_v1($1,$2,$3) AS packet"
        : kind === "latest"
          ? "SELECT latest_owned_moderated_dance_review_v1($1,$2,$3,$4,$5::bigint) AS packet"
          : kind === "queue"
            ? "SELECT owner_moderated_dance_queue_v1($1,$2,$3) AS packet"
            : "SELECT owner_moderated_dance_detail_v1($1,$2,$3) AS packet";
    const value = yield* provided(
      Effect.gen(function* () {
        return yield* packet(
          yield* ControlPlaneDb,
          `dance-review.${kind}.read`,
          sql,
          [actor.accountId, ...args],
          true,
        );
      }),
    );
    if (value === null) return yield* failure("not_found");
    return value;
  });
  const getLatest = Effect.fn("DanceReviewRepository.getLatest")(function* (
    communityId: string,
    postId: string,
    choreographyId: string,
    revision: number,
  ) {
    const value = yield* read("latest", [communityId, postId, choreographyId, revision]);
    const result = yield* decode(
      Schema.Struct({
        latest: Schema.NullOr(ModeratorReviewSchema),
        activeSessionId: Schema.NullOr(Schema.NonEmptyString),
      }),
      value,
    );
    return {
      object: "latest_moderated_dance_review" as const,
      latest_submitted: result.latest === null ? null : projectPrivateDanceReview(result.latest),
      active_session_id: result.activeSessionId,
    };
  });
  const ownerQueue = (communityId: string, cursor: string | null) =>
    read("queue", [communityId, cursor]).pipe(
      Effect.flatMap((value) => decode(DanceOwnerQueueV1, value)),
    );
  const ownerDetail = (communityId: string, reviewId: string) =>
    read("owner", [communityId, reviewId]).pipe(
      Effect.flatMap((value) => decode(DanceOwnerDetailV1, value)),
    );
  const getPublication = (communityId: string, reviewId: string) =>
    read("publication", [communityId, reviewId]).pipe(
      Effect.flatMap((value) => decode(ModeratedDancePublicationV1, value)),
    );
  return { ...services, getOwnResult, getLatest, getPublication, ownerQueue, ownerDetail };
}
