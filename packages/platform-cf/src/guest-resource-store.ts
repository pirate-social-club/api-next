import {
  ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneStatementFailed,
  type DurableParticipationOutcome,
  GuestParticipationStoreRejected,
  type GuestProviderCallReservation,
  type GuestResourceAdmissionStore,
  type GuestResourceReservation,
  type ParticipationOperationIdentity,
} from "@pirate/application";
import { GuestIdentifierV1, GuestSha256V1 } from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";
import { readGuestResourceAdmissionPolicy } from "./guest-resource-policy.ts";

type Methods = GuestResourceAdmissionStore;
type Input<K extends keyof Methods> = Parameters<Methods[K]>[0];
const Owner = Schema.String.check(
  Schema.isPattern(/^owner_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
);
const Operation = Schema.Struct({
  sourceOwnerId: Owner,
  kind: Schema.Literals(["study_start", "study_answer"]),
  idempotencyKey: GuestIdentifierV1,
  requestHash: GuestSha256V1,
});
const Id = Schema.String.check(
  Schema.isPattern(/^gr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
);
const CallId = Schema.String.check(
  Schema.isPattern(/^gpc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
);
const ReleaseId = Schema.String.check(
  Schema.isPattern(/^grr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
);
const Version = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const Units = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 }));
const PositiveCost = Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,77}$/u));
const Cost = Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]{0,77})$/u));
const SessionResult = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("reserved"),
    reservationId: Id,
    sourceOwnerId: Owner,
    operation: Operation,
    remainingUnits: Units,
    policyVersion: Version,
    costPolicyVersion: Version,
  }),
  Schema.Struct({
    state: Schema.Literals(["rate_limited", "budget_refused", "unavailable"]),
    retryAfterSeconds: Schema.NullOr(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3600 })),
    ),
  }),
]);
const SessionReply = Schema.Struct({
  state: Schema.Literal("completed"),
  outcome_id: Id,
  result: SessionResult,
});
const ProviderResult = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("reserved"),
    callId: CallId,
    reservationId: Id,
    maximumCostMicros: PositiveCost,
  }),
  Schema.Struct({ state: Schema.Literal("unknown"), callId: CallId, reservationId: Id }),
  Schema.Struct({
    state: Schema.Literal("completed"),
    callId: CallId,
    checkpointId: GuestIdentifierV1,
  }),
]);
const ProviderReply = Schema.Union([
  Schema.Struct({ state: Schema.Literal("completed"), outcome_id: CallId, result: ProviderResult }),
  Schema.Struct({ state: Schema.Literal("known_aborted") }),
]);
const CompleteReply = Schema.Struct({ state: Schema.Literal("completed"), outcome_id: CallId });
const ReleaseReply = Schema.Struct({ state: Schema.Literal("completed"), outcome_id: ReleaseId });
const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
const invalid = (label: string, started = false) =>
  new ControlPlaneStatementFailed({
    label,
    sqlState: null,
    constraint: null,
    outcomeCertainty: started ? "completed" : "not-started",
  });
const operationMatches = (a: ParticipationOperationIdentity, b: ParticipationOperationIdentity) =>
  a.sourceOwnerId === b.sourceOwnerId &&
  a.kind === b.kind &&
  a.idempotencyKey === b.idempotencyKey &&
  a.requestHash === b.requestHash;
const jsonOperation = (
  sourceOwnerId: string,
  operation: ParticipationOperationIdentity,
  kinds: readonly string[],
) => {
  const parsed = decode(Operation, operation);
  if (parsed.sourceOwnerId !== sourceOwnerId || !kinds.includes(parsed.kind)) throw new Error();
  return JSON.stringify(parsed);
};

/** Private receipt mapper. No browser policy, resource policy defaults or provider I/O. */
export function makeControlPlaneGuestResourceAdmissionStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): Methods {
  const run = Effect.fn("GuestResourceAdmissionStore.call")(function* <A>(
    label: string,
    text: string,
    values: readonly unknown[],
    schema: Schema.ConstraintDecoder<A>,
    validate: (reply: A) => void,
  ) {
    const db = yield* ControlPlaneDb;
    return yield* db.withTransaction((transaction) =>
      Effect.gen(function* () {
        yield* transaction.execute({
          label: `${label}.limits`,
          text: "SELECT set_config('transaction_timeout','3s',true),set_config('lock_timeout','250ms',true),set_config('statement_timeout','2s',true),set_config('idle_in_transaction_session_timeout','2s',true)",
          values: [],
          readonly: true,
        });
        const result = yield* transaction.execute({ label, text, values, readonly: false });
        return yield* Effect.try({
          try: () => {
            if (result.rows.length !== 1) throw new Error();
            const row = decode(Schema.Struct({ result: schema }), result.rows[0]);
            validate(row.result);
            return row.result;
          },
          catch: () => invalid(`${label}.decode`, true),
        });
      }),
    );
  });
  const call = <A>(
    label: string,
    text: string,
    values: readonly unknown[],
    schema: Schema.ConstraintDecoder<A>,
    validate: (reply: A) => void,
  ) =>
    run(label, text, values, schema, validate).pipe(
      Effect.catchTag("ControlPlaneStatementFailed", (error) => {
        const reason =
          error.sqlState === "GP002"
            ? "owner-mismatch"
            : error.sqlState === "GP005"
              ? "idempotency-conflict"
              : error.sqlState === "GP006"
                ? "resource-policy-unavailable"
                : null;
        return Effect.fail(
          reason === null ? error : new GuestParticipationStoreRejected({ reason }),
        );
      }),
      Effect.provide(runtime),
    );
  const prepare = <A>(label: string, action: () => A) =>
    Effect.try({
      try: action,
      catch: (error) =>
        error instanceof GuestParticipationStoreRejected &&
        error.reason === "resource-policy-unavailable"
          ? error
          : invalid(label),
    });

  return {
    reserveSession: (input: Input<"reserveSession">) =>
      prepare("guest-resource.session.input", () => {
        const operation = jsonOperation(input.sourceOwnerId, input.operation, ["study_start"]);
        decode(GuestIdentifierV1, input.sessionId);
        decode(Units, input.worstCasePaidAttemptUnits);
        decode(Cost, input.worstCaseCostMicros);
        if (
          input.trustedEdge.kind !== "trusted_edge" ||
          input.trustedEdge.fingerprint.length < 1 ||
          input.trustedEdge.fingerprint.length > 256
        )
          throw new Error();
        const policy = readGuestResourceAdmissionPolicy(input.policy);
        if (policy === null)
          throw new GuestParticipationStoreRejected({ reason: "resource-policy-unavailable" });
        return [
          input.sourceOwnerId,
          operation,
          input.sessionId,
          input.worstCasePaidAttemptUnits,
          input.worstCaseCostMicros,
          input.trustedEdge.fingerprint,
          JSON.stringify(policy),
        ];
      }).pipe(
        Effect.flatMap((values) =>
          call(
            "guest-resource.session",
            "SELECT reserve_guest_resource_session_v1($1,$2::jsonb,$3,$4::integer,$5,$6,$7::jsonb) AS result",
            values,
            SessionReply,
            (reply) => {
              if (
                reply.result.state === "reserved" &&
                (reply.result.reservationId !== reply.outcome_id ||
                  reply.result.sourceOwnerId !== input.sourceOwnerId ||
                  !operationMatches(reply.result.operation, input.operation) ||
                  reply.result.remainingUnits !== input.worstCasePaidAttemptUnits)
              )
                throw new Error();
              // Stored version/candidate metadata may predate current configuration on replay.
            },
          ),
        ),
        Effect.map(
          (reply): DurableParticipationOutcome<GuestResourceReservation> => ({
            state: "completed",
            operation: input.operation,
            outcomeId: reply.outcome_id,
            result: reply.result,
          }),
        ),
      ),
    reserveProviderCall: (input: Input<"reserveProviderCall">) =>
      prepare("guest-resource.provider.input", () => {
        const operation = jsonOperation(input.sourceOwnerId, input.operation, ["study_answer"]);
        decode(GuestIdentifierV1, input.sessionId);
        decode(Id, input.reservationId);
        decode(PositiveCost, input.maximumCostMicros);
        decode(Version, input.costPolicyVersion);
        if (input.units !== 1) throw new Error();
        return [
          input.sourceOwnerId,
          operation,
          input.sessionId,
          input.reservationId,
          input.units,
          input.maximumCostMicros,
          input.costPolicyVersion,
        ];
      }).pipe(
        Effect.flatMap((values) =>
          call(
            "guest-resource.provider",
            "SELECT reserve_guest_provider_call_v1($1,$2::jsonb,$3,$4,$5::integer,$6,$7) AS result",
            values,
            ProviderReply,
            (reply) => {
              if (reply.state === "known_aborted") return;
              if (
                reply.result.callId !== reply.outcome_id ||
                (reply.result.state !== "completed" &&
                  reply.result.reservationId !== input.reservationId) ||
                (reply.result.state === "reserved" &&
                  reply.result.maximumCostMicros !== input.maximumCostMicros)
              )
                throw new Error();
            },
          ),
        ),
        Effect.map(
          (reply): DurableParticipationOutcome<GuestProviderCallReservation> =>
            reply.state === "known_aborted"
              ? { state: "known_aborted", operation: input.operation }
              : {
                  state: "completed",
                  operation: input.operation,
                  outcomeId: reply.outcome_id,
                  result: reply.result,
                },
        ),
      ),
    completeProviderCall: (input: Input<"completeProviderCall">) =>
      prepare("guest-resource.complete.input", () => {
        const operation = jsonOperation(input.sourceOwnerId, input.operation, ["study_answer"]);
        decode(Id, input.reservationId);
        decode(CallId, input.callId);
        const disposition = decode(
          Schema.Union([
            Schema.Struct({
              state: Schema.Literal("completed"),
              checkpointId: GuestIdentifierV1,
              costMicros: Cost,
            }),
            Schema.Struct({ state: Schema.Literals(["not_invoked", "failed", "unknown"]) }),
          ]),
          input.disposition,
        );
        return [
          input.sourceOwnerId,
          operation,
          input.reservationId,
          input.callId,
          disposition.state,
          disposition.state === "completed" ? disposition.checkpointId : null,
          disposition.state === "completed" ? disposition.costMicros : null,
        ];
      }).pipe(
        Effect.flatMap((values) =>
          call(
            "guest-resource.complete",
            "SELECT complete_guest_provider_call_v1($1,$2::jsonb,$3,$4,$5,$6,$7) AS result",
            values,
            CompleteReply,
            (reply) => {
              if (reply.outcome_id !== input.callId) throw new Error();
            },
          ),
        ),
        Effect.map(
          (reply): DurableParticipationOutcome<void> => ({
            state: "completed",
            operation: input.operation,
            outcomeId: reply.outcome_id,
            result: undefined,
          }),
        ),
      ),
    releaseSessionRemainder: (input: Input<"releaseSessionRemainder">) =>
      prepare("guest-resource.release.input", () => {
        const operation = jsonOperation(input.sourceOwnerId, input.operation, [
          "study_start",
          "study_answer",
        ]);
        decode(Id, input.reservationId);
        decode(GuestIdentifierV1, input.sessionId);
        decode(Schema.Literals(["completed", "expired"]), input.authoritativeTerminalState);
        return [
          input.sourceOwnerId,
          operation,
          input.sessionId,
          input.reservationId,
          input.authoritativeTerminalState,
        ];
      }).pipe(
        Effect.flatMap((values) =>
          call(
            "guest-resource.release",
            "SELECT release_guest_resource_session_v1($1,$2::jsonb,$3,$4,$5) AS result",
            values,
            ReleaseReply,
            () => undefined,
          ),
        ),
        Effect.map(
          (reply): DurableParticipationOutcome<void> => ({
            state: "completed",
            operation: input.operation,
            outcomeId: reply.outcome_id,
            result: undefined,
          }),
        ),
      ),
  };
}
