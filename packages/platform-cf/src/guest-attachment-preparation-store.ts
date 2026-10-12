import {
  ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneStatementFailed,
} from "@pirate/application";
import {
  type GuestAttachmentStore,
  type GuestParticipationStoreFailure,
  GuestParticipationStoreRejected,
  type DurableParticipationOutcome,
} from "@pirate/application/guest-participation-authority";
import {
  GuestAttachmentIntentIdV1,
  GuestAttachmentIntentV1,
  GuestAttachmentPreparedV1,
  GuestIdentifierV1,
  GuestSha256V1,
} from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";

type Methods = Pick<GuestAttachmentStore, "createIntent" | "prepareTarget">;
type Input<K extends keyof Methods> = Parameters<Methods[K]>[0];
const Owner = Schema.String.check(
  Schema.isPattern(/^owner_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
);
const Operation = Schema.Struct({
  sourceOwnerId: Owner,
  kind: Schema.Literals(["attachment_intent", "attachment_prepare"]),
  idempotencyKey: GuestIdentifierV1,
  requestHash: GuestSha256V1,
});
const IntentEffect = Schema.Struct({
  kind: Schema.Literal("intent"),
  action: Schema.Literal("issue"),
  intentId: GuestAttachmentIntentIdV1,
});
const Created = Schema.Struct({
  state: Schema.Literal("completed"),
  operation_id: GuestIdentifierV1,
  operation: Operation,
  intent: GuestAttachmentIntentV1,
  cookie_effects: Schema.Array(IntentEffect).check(Schema.isMaxLength(1)),
});
const CreateReply = Schema.Union([
  Schema.Struct({ state: Schema.Literal("issuance_requires_restart") }),
  Created,
]);
const Prepared = Schema.Struct({
  state: Schema.Literal("completed"),
  operation_id: GuestIdentifierV1,
  operation: Operation,
  prepared: GuestAttachmentPreparedV1,
});
const bad = (label: string, started = true) =>
  new ControlPlaneStatementFailed({
    label,
    sqlState: null,
    constraint: null,
    outcomeCertainty: started ? "completed" : "not-started",
  });
const reject = (reason: GuestParticipationStoreRejected["reason"]) =>
  new GuestParticipationStoreRejected({ reason });
function mapped(error: ControlPlaneStatementFailed): GuestParticipationStoreFailure {
  switch (error.sqlState) {
    case "GP001":
      return reject("proof-revoked");
    case "GP002":
      return reject("owner-mismatch");
    case "GP003":
      return reject("authority-conflict");
    case "GP004":
      return reject("credential-cleanup-required");
    case "GP005":
      return reject("idempotency-conflict");
    case "GP006":
      return reject("intent-expired");
    case "GP007":
      return reject("ceremony-cleanup-required");
    case "GP008":
      return reject("target-changed");
    default:
      return error;
  }
}

export function makeControlPlaneGuestAttachmentPreparation(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  newOperationId: () => string = () => `guest_intent_op_${crypto.randomUUID()}`,
): Methods {
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect);
  const transact = Effect.fn("GuestAttachmentPreparation.call")(function* <A>(
    label: string,
    text: string,
    values: readonly unknown[],
    schema: Schema.ConstraintDecoder<A>,
    validate: (reply: A) => void,
  ): Effect.fn.Return<A, ControlPlaneError, ControlPlaneDb> {
    const db = yield* ControlPlaneDb;
    return yield* db.withTransaction((transaction) =>
      Effect.gen(function* () {
        yield* transaction.execute({
          label: `${label}.limits`,
          text: "SELECT set_config('transaction_timeout','3s',true),set_config('lock_timeout','250ms',true),set_config('statement_timeout','2s',true),set_config('idle_in_transaction_session_timeout','2s',true)",
          values: [],
          readonly: true,
        });
        const response = yield* transaction.execute({ label, text, values, readonly: false });
        return yield* Effect.try({
          try: () => {
            if (response.rows.length !== 1) throw new Error();
            const decoded = Schema.decodeUnknownSync(Schema.Struct({ result: schema }), {
              onExcessProperty: "error",
            })(response.rows[0]);
            validate(decoded.result);
            return decoded.result;
          },
          catch: () => bad(`${label}.decode`),
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
    provide(
      transact(label, text, values, schema, validate).pipe(
        Effect.catchTag("ControlPlaneStatementFailed", (error) => Effect.fail(mapped(error))),
      ),
    );
  return {
    createIntent: (input: Input<"createIntent">) => {
      if (
        input.operation.kind !== "attachment_intent" ||
        input.context.selected.credentialId !== input.context.access.credentialId ||
        input.context.selected.ownerId !== input.context.access.ownerId ||
        input.context.selected.origin !== input.context.origin
      )
        return Effect.fail(bad("guest-attachment.create.context", false));
      const provedIntentIds = input.context.provedIntents.map((i) => i.intentId);
      return call(
        "guest-attachment.create",
        "SELECT create_guest_attachment_intent_v1($1,$2::text[],$3,$4,$5::text[],$6,$7,$8,$9,$10) AS result",
        [
          input.context.origin,
          input.context.provedCredentials.map((c) => c.credentialId),
          input.context.selected.credentialId,
          input.expectedOwnerId,
          provedIntentIds,
          input.operation.idempotencyKey,
          input.operation.requestHash,
          newOperationId(),
          input.intentId,
          input.nonceDigest,
        ],
        CreateReply,
        (reply) => {
          if (reply.state === "issuance_requires_restart") return;
          if (
            reply.operation.kind !== "attachment_intent" ||
            reply.operation.idempotencyKey !== input.operation.idempotencyKey ||
            reply.operation.requestHash !== input.operation.requestHash
          )
            throw new Error();
          const fresh = reply.cookie_effects.length !== 0;
          if (
            fresh
              ? reply.intent.intent_id !== input.intentId
              : !provedIntentIds.includes(reply.intent.intent_id)
          )
            throw new Error();
          if (
            reply.cookie_effects.some(
              (e) => e.intentId !== input.intentId || e.intentId !== reply.intent.intent_id,
            )
          )
            throw new Error();
        },
      ).pipe(
        Effect.flatMap((reply) => {
          if (reply.state === "issuance_requires_restart")
            return Effect.fail(reject("issuance-requires-restart"));
          return Effect.succeed({
            state: "completed",
            operation: reply.operation,
            outcomeId: reply.operation_id,
            result: { intent: reply.intent, cookieEffects: reply.cookie_effects },
          } satisfies DurableParticipationOutcome<
            Readonly<{
              intent: Schema.Schema.Type<typeof GuestAttachmentIntentV1>;
              cookieEffects: readonly Schema.Schema.Type<typeof IntentEffect>[];
            }>
          >);
        }),
      );
    },
    prepareTarget: Effect.fn("GuestAttachmentPreparation.prepareTarget")(function* (
      input: Input<"prepareTarget">,
    ) {
      const context = input.context;
      if (
        input.intentId !== context.intent.intentId ||
        context.intent.credentialId !== context.selected.credentialId ||
        context.intent.ownerId !== context.selected.ownerId ||
        context.selected.origin !== context.origin ||
        context.intent.origin !== context.origin ||
        (context.account.kind !== "ordinary_account" &&
          context.account.kind !== "persona_wallet_setup")
      )
        return yield* Effect.fail(reject("owner-mismatch"));
      // sessionBinding is produced by transport from the verified exact protected
      // cookie, never raw cookie/JWT/body account ID. No additional digest retained.
      const sessionDigest = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(GuestSha256V1)(context.account.sessionBinding),
        catch: () => bad("guest-attachment.prepare.session-binding", false),
      });
      const reply = yield* call(
        "guest-attachment.prepare",
        "SELECT prepare_guest_attachment_target_v1($1,$2::text[],$3,$4,$5::text[],$6,$7,$8) AS result",
        [
          context.origin,
          context.provedCredentials.map((c) => c.credentialId),
          context.selected.credentialId,
          context.selected.ownerId,
          context.provedIntents.map((i) => i.intentId),
          context.intent.intentId,
          context.account.accountId,
          sessionDigest,
        ],
        Prepared,
        (result) => {
          if (
            result.operation.kind !== "attachment_prepare" ||
            result.operation.sourceOwnerId !== context.intent.ownerId ||
            result.prepared.intent_id !== input.intentId ||
            result.prepared.account_confirmation.account_id !== context.account.accountId
          )
            throw new Error();
          // Key/hash/revision are derived from the locked full natural tuple by SQL.
          Schema.decodeUnknownSync(GuestSha256V1)(result.operation.idempotencyKey);
        },
      );
      return {
        state: "completed",
        operation: reply.operation,
        outcomeId: reply.operation_id,
        result: reply.prepared,
      } satisfies DurableParticipationOutcome<Schema.Schema.Type<typeof GuestAttachmentPreparedV1>>;
    }),
  };
}
