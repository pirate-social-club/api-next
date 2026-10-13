import {
  ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneStatementFailed,
} from "@pirate/application";
import {
  type GuestAttachmentStore,
  type GuestParticipationStoreFailure,
  GuestParticipationStoreRejected,
  type ParticipationOperationIdentity,
} from "@pirate/application/guest-participation-authority";
import type {
  OwnerRewardCreditClaimStore,
  OwnerRewardCreditStore,
  OwnerRewardRecipientResolver,
  RewardCreditRecipientStore,
} from "@pirate/application/owner-reward-credit-ports";
import {
  GuestAttachmentBindingV1,
  GuestIdentifierV1,
  GuestOperationKindV1,
  GuestSha256V1,
  OwnerRewardCreditV1,
} from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";

const Operation = Schema.Struct({
  sourceOwnerId: GuestIdentifierV1,
  kind: GuestOperationKindV1,
  idempotencyKey: GuestIdentifierV1,
  requestHash: GuestSha256V1,
});
const Cookie = Schema.Struct({
  kind: Schema.Literal("credential"),
  action: Schema.Literal("expire"),
  credentialId: GuestIdentifierV1,
});
const AttachmentResult = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("bound"),
    binding: GuestAttachmentBindingV1,
    cookieEffects: Schema.Array(Cookie).check(Schema.isMaxLength(4)),
  }),
  Schema.Struct({ state: Schema.Literal("participation_conflict"), outcomeId: GuestIdentifierV1 }),
]);
const Claimed = Schema.Struct({
  outcome: Schema.Literals([
    "accepted",
    "subject_conflict",
    "verification_missing",
    "verification_stale",
    "verification_failed",
    "not_claimable",
  ]),
  credit: OwnerRewardCreditV1,
});
const Completed = <A>(result: Schema.ConstraintDecoder<A>) =>
  Schema.Struct({
    state: Schema.Literal("completed"),
    outcomeId: GuestIdentifierV1,
    operation: Operation,
    result,
  });
const AttachmentReply = Completed(AttachmentResult);
const Recipient = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("bound"),
    personaId: GuestIdentifierV1,
    walletAddress: Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{40}$/u)),
  }),
  Schema.Struct({
    state: Schema.Literal("held"),
    reason: Schema.Literals(["unbound", "persona_unavailable", "wallet_unavailable"]),
  }),
]);
const rejected = (reason: GuestParticipationStoreRejected["reason"]) =>
  new GuestParticipationStoreRejected({ reason });
const malformed = (label: string) =>
  new ControlPlaneStatementFailed({
    label,
    sqlState: null,
    constraint: null,
    outcomeCertainty: "completed",
  });
function mapped(error: ControlPlaneStatementFailed): GuestParticipationStoreFailure {
  switch (error.sqlState) {
    case "GP001":
      return rejected("proof-revoked");
    case "GP002":
      return rejected("owner-mismatch");
    case "GP003":
      return rejected("authority-conflict");
    case "GP005":
      return rejected("idempotency-conflict");
    case "GP006":
      return rejected("intent-expired");
    case "GP008":
      return rejected("target-changed");
    case "GP009":
      return rejected("not-found");
    case "GP013":
      return rejected("recipient-selection-conflict");
    default:
      return error;
  }
}
function sameOperation(
  actual: ParticipationOperationIdentity,
  expected: ParticipationOperationIdentity,
) {
  if (
    actual.sourceOwnerId !== expected.sourceOwnerId ||
    actual.kind !== expected.kind ||
    actual.idempotencyKey !== expected.idempotencyKey ||
    actual.requestHash !== expected.requestHash
  )
    throw new Error();
}
export function makeControlPlaneOwnerRecipientStores(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): {
  attachment: Pick<GuestAttachmentStore, "confirm" | "findBoundAttachment">;
  credits: OwnerRewardCreditStore;
  recipients: RewardCreditRecipientStore;
  claims: OwnerRewardCreditClaimStore;
  resolver: OwnerRewardRecipientResolver;
} {
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect);
  const transaction = Effect.fn("OwnerRecipient.call")(function* <A>(
    label: string,
    text: string,
    values: readonly unknown[],
    schema: Schema.ConstraintDecoder<A>,
    validate: (value: A) => void,
  ): Effect.fn.Return<A, ControlPlaneError, ControlPlaneDb> {
    const db = yield* ControlPlaneDb;
    return yield* db.withTransaction((tx) =>
      Effect.gen(function* () {
        yield* tx.execute({
          label: `${label}.limits`,
          text: "SELECT set_config('transaction_timeout','3s',true),set_config('lock_timeout','250ms',true),set_config('statement_timeout','2s',true),set_config('idle_in_transaction_session_timeout','2s',true)",
          values: [],
          readonly: true,
        });
        const rows = yield* tx.execute({ label, text, values, readonly: false });
        return yield* Effect.try({
          try: () => {
            if (rows.rows.length !== 1) throw new Error();
            const reply = Schema.decodeUnknownSync(Schema.Struct({ result: schema }), {
              onExcessProperty: "error",
            })(rows.rows[0]);
            validate(reply.result);
            return reply.result;
          },
          catch: () => malformed(`${label}.decode`),
        });
      }),
    );
  });
  const call = <A>(
    label: string,
    text: string,
    values: readonly unknown[],
    schema: Schema.ConstraintDecoder<A>,
    validate: (value: A) => void,
  ) =>
    provide(
      transaction(label, text, values, schema, validate).pipe(
        Effect.catchTag("ControlPlaneStatementFailed", (e) => Effect.fail(mapped(e))),
      ),
    );
  const checkCredit = (
    credit: Schema.Schema.Type<typeof OwnerRewardCreditV1>,
    id: string,
    op: ParticipationOperationIdentity,
  ) => {
    if (credit.credit_id !== id || credit.owner_id !== op.sourceOwnerId) throw new Error();
  };
  return {
    attachment: {
      confirm: (input) => {
        const c = input.context;
        if (
          c.authority !== "attachment" ||
          c.operation !== "confirm_target" ||
          !c.originAndCsrfChecked ||
          !c.accountCsrfChecked ||
          c.selected.state !== "confirmed" ||
          c.access.ownerId !== c.selected.ownerId ||
          c.access.credentialId !== c.selected.credentialId ||
          c.selected.origin !== c.origin ||
          c.access.origin !== c.origin ||
          c.intent.intentId !== input.intentId ||
          c.intent.ownerId !== c.selected.ownerId ||
          c.intent.credentialId !== c.selected.credentialId ||
          c.account.accountId !== input.expectedAccountId ||
          input.operation.kind !== "attachment_confirm" ||
          input.operation.sourceOwnerId !== c.selected.ownerId ||
          input.operation.idempotencyKey !== `${input.intentId}:${input.targetRevision}`
        )
          return Effect.fail(rejected("owner-mismatch"));
        return call(
          "guest-attachment.confirm",
          "SELECT confirm_guest_owner_attachment_v1($1,$2::text[],$3,$4,$5::text[],$6,$7,$8,$9,$10,$11) AS result",
          [
            c.origin,
            c.provedCredentials.map((p) => p.credentialId),
            c.selected.credentialId,
            c.selected.ownerId,
            c.provedIntents.map((p) => p.intentId),
            input.intentId,
            c.account.accountId,
            c.account.sessionBinding,
            input.targetRevision,
            input.operation.idempotencyKey,
            input.operation.requestHash,
          ],
          AttachmentReply,
          (reply) => {
            if (reply.state === "completed") {
              sameOperation(reply.operation, input.operation);
              if (reply.result.state === "bound") {
                if (
                  reply.result.binding.attachment_id !== input.intentId ||
                  reply.result.binding.owner_id !== c.selected.ownerId ||
                  reply.result.binding.account_id !== c.account.accountId
                )
                  throw new Error();
                const ids = reply.result.cookieEffects.map((effect) => effect.credentialId);
                if (
                  new Set(ids).size !== ids.length ||
                  ids.some((id) => !c.provedCredentials.some((p) => p.credentialId === id))
                )
                  throw new Error();
              } else if (reply.result.outcomeId !== reply.outcomeId) throw new Error();
            }
          },
        );
      },
      findBoundAttachment: (input) =>
        call(
          "guest-attachment.bound.read",
          "SELECT find_bound_guest_attachment_v1($1,$2) AS result",
          [input.account.accountId, input.attachmentId],
          Schema.NullOr(GuestAttachmentBindingV1),
          (reply) => {
            // Native bound-only canonical access authorizes current B; immutable returned
            // binding.account_id remains original A. The exact original locator must match.
            if (reply !== null && reply.attachment_id !== input.attachmentId) throw new Error();
          },
        ),
    },
    credits: {
      resolveAuthority: (input) => {
        if (input.account.kind !== "ordinary_account") return Effect.fail(rejected("not-found"));
        return call(
          "owner-credit.authority",
          "SELECT resolve_owner_credit_authority_v1($1,$2) AS result",
          [input.account.accountId, input.creditId],
          Schema.NullOr(
            Schema.Union([
              Schema.Struct({
                kind: Schema.Literal("account_owner"),
                ownerId: GuestIdentifierV1,
                accountId: GuestIdentifierV1,
                originalPersonaId: GuestIdentifierV1,
                credit: OwnerRewardCreditV1,
              }),
              Schema.Struct({
                kind: Schema.Literal("guest_owner"),
                ownerId: GuestIdentifierV1,
                boundAccountId: GuestIdentifierV1,
                credit: OwnerRewardCreditV1,
              }),
            ]),
          ),
          (reply) => {
            if (
              reply !== null &&
              (reply.credit.credit_id !== input.creditId ||
                reply.credit.owner_id !== reply.ownerId ||
                (reply.kind === "account_owner" ? reply.accountId : reply.boundAccountId) !==
                  input.account.accountId)
            )
              throw new Error();
          },
        );
      },
    },
    recipients: {
      select: (input) => {
        if (
          input.account.kind !== "ordinary_account" ||
          input.operation.kind !== "recipient_selection"
        )
          return Effect.fail(rejected("recipient-selection-conflict"));
        return call(
          "owner-credit.select",
          "SELECT select_owner_credit_recipient_v1($1,$2,$3,$4,$5,$6) AS result",
          [
            input.account.accountId,
            input.creditId,
            input.personaId,
            input.operation.sourceOwnerId,
            input.operation.idempotencyKey,
            input.operation.requestHash,
          ],
          Completed(OwnerRewardCreditV1),
          (reply) => {
            sameOperation(reply.operation, input.operation);
            checkCredit(reply.result, input.creditId, input.operation);
            if (
              reply.result.recipient.kind !== "guest_owner" ||
              reply.result.recipient.selection?.persona_id !== input.personaId
            )
              throw new Error();
          },
        );
      },
    },
    claims: {
      claim: (input) => {
        if (input.account.kind !== "ordinary_account" || input.operation.kind !== "owner_claim")
          return Effect.fail(rejected("not-found"));
        return call(
          "owner-credit.claim",
          "SELECT claim_owner_reward_credit_v1($1,$2,$3,$4,$5,$6) AS result",
          [
            input.account.accountId,
            input.creditId,
            input.selectionRevision,
            input.operation.sourceOwnerId,
            input.operation.idempotencyKey,
            input.operation.requestHash,
          ],
          Completed(Claimed),
          (reply) => {
            sameOperation(reply.operation, input.operation);
            checkCredit(reply.result.credit, input.creditId, input.operation);
            const r = reply.result.credit.recipient;
            if (
              r.kind === "account_owner"
                ? input.selectionRevision !== null
                : r.selection?.revision !== input.selectionRevision
            )
              throw new Error();
            if (
              reply.result.outcome === "accepted" &&
              reply.result.credit.claim.status !== "accepted"
            )
              throw new Error();
          },
        );
      },
      operatorAccept: (input) => {
        if (input.operator.role !== "api_next_operator") return Effect.fail(rejected("not-found"));
        return call(
          "owner-credit.operator",
          "SELECT operator_accept_owner_reward_credit_v1($1,$2,$3,$4,$5) AS result",
          [
            input.creditId,
            input.recordedSelectionRevision,
            input.audit.actorRole,
            input.audit.reason,
            input.audit.evidenceReference,
          ],
          Completed(Claimed),
          (reply) => {
            if (
              reply.operation.kind !== "owner_claim" ||
              reply.result.credit.credit_id !== input.creditId ||
              reply.result.credit.owner_id !== reply.operation.sourceOwnerId ||
              reply.result.outcome !== "accepted" ||
              reply.result.credit.claim.status !== "accepted"
            )
              throw new Error();
            const r = reply.result.credit.recipient;
            if (
              r.kind === "account_owner"
                ? input.recordedSelectionRevision !== null
                : r.binding?.selection_revision !== input.recordedSelectionRevision
            )
              throw new Error();
          },
        );
      },
    },
    resolver: {
      resolve: (input) =>
        call(
          "owner-credit.recipient",
          "SELECT resolve_owner_credit_recipient_private_v1($1) AS result",
          [input.creditId],
          Recipient,
          () => {},
        ),
    },
  };
}
