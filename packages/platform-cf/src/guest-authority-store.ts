import {
  ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneStatementFailed,
} from "@pirate/application";
import {
  type GuestAuthorityStore,
  type GuestAuthorityTransition,
  type GuestParticipationStoreFailure,
  GuestParticipationStoreRejected,
  type DurableParticipationOutcome,
  type ParticipationOperationIdentity,
} from "@pirate/application/guest-participation-authority";
import {
  GuestAuthorityV1,
  GuestCredentialIdV1,
  GuestIdentifierV1,
  GuestSha256V1,
} from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";

type Methods = Pick<
  GuestAuthorityStore,
  "issuePending" | "confirm" | "renew" | "issueRotation" | "acknowledgeRotation"
>;
type Input<K extends keyof Methods> = Parameters<Methods[K]>[0];
const Owner = Schema.String.check(
  Schema.isPattern(/^owner_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
);
const Operation = Schema.Struct({
  sourceOwnerId: Owner,
  kind: Schema.Literals(["bootstrap_issue", "credential_rotate"]),
  idempotencyKey: GuestIdentifierV1,
  requestHash: GuestSha256V1,
});
const Cookie = Schema.Struct({
  kind: Schema.Literal("credential"),
  action: Schema.Literals(["issue", "refresh", "expire"]),
  credentialId: GuestCredentialIdV1,
});
const Transition = Schema.Struct({
  authority: GuestAuthorityV1,
  cookie_effects: Schema.Array(Cookie).check(Schema.isMaxLength(1)),
});
const CompletedIssue = Schema.Struct({
  state: Schema.Literal("completed"),
  operation_id: GuestIdentifierV1,
  operation: Operation,
  ...Transition.fields,
});
const Issue = Schema.Union([
  Schema.Struct({ state: Schema.Literal("issuance_requires_restart") }),
  CompletedIssue,
]);
type IssueReply = Schema.Schema.Type<typeof Issue>;
type CompletedReply = Schema.Schema.Type<typeof CompletedIssue>;
type TransitionReply = Schema.Schema.Type<typeof Transition>;
const badProjection = (label: string, started = true) =>
  new ControlPlaneStatementFailed({
    label,
    sqlState: null,
    constraint: null,
    outcomeCertainty: started ? "completed" : "not-started",
  });
const rejected = (reason: GuestParticipationStoreRejected["reason"]) =>
  new GuestParticipationStoreRejected({ reason });

/** Match only exact safe codes. Commit/rollback unknown never enters this handler. */
function statementFailure(error: ControlPlaneStatementFailed): GuestParticipationStoreFailure {
  switch (error.sqlState) {
    case "GP001":
      return rejected("proof-revoked");
    case "GP002":
      return rejected("owner-mismatch");
    case "GP003":
      return rejected("authority-conflict");
    case "GP004":
      return rejected("credential-cleanup-required");
    case "GP005":
      return rejected("idempotency-conflict");
    default:
      return error;
  }
}
const transition = (reply: TransitionReply): GuestAuthorityTransition => ({
  authority: reply.authority,
  cookieEffects: reply.cookie_effects,
});

export function makeControlPlaneGuestAuthorityTransitions(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  newOperationId: () => string = () => `guest_op_${crypto.randomUUID()}`,
): Methods {
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect);
  const runCall = Effect.fn("GuestAuthorityTransitions.call")(function* <A>(
    label: string,
    text: string,
    values: readonly unknown[],
    schema: Schema.ConstraintDecoder<A>,
    validate: (reply: A) => void,
  ) {
    const db = yield* ControlPlaneDb;
    // Decode within the owning transaction; return effects only after COMMIT.
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
            const row = Schema.decodeUnknownSync(Schema.Struct({ result: schema }), {
              onExcessProperty: "error",
            })(result.rows[0]);
            validate(row.result);
            return row.result;
          },
          catch: () => badProjection(`${label}.decode`),
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
      runCall(label, text, values, schema, validate).pipe(
        Effect.catchTag("ControlPlaneStatementFailed", (error) =>
          Effect.fail(statementFailure(error)),
        ),
      ),
    );

  const validateAuthority = (reply: TransitionReply, allowedIds: readonly string[]) => {
    const records = reply.authority.proved_credentials;
    const ids = records.map((c) => c.credential_id);
    for (const record of records) Schema.decodeUnknownSync(Owner)(record.owner_id);
    const selected = reply.authority.selected;
    const selectedRecord = records.find((c) => c.credential_id === selected?.credential_id);
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id) => !allowedIds.includes(id)) ||
      reply.authority.pointer_repair !== null ||
      (selected !== null &&
        (selectedRecord === undefined ||
          selected.owner_id !== selectedRecord.owner_id ||
          selected.credential_state !== selectedRecord.credential_state ||
          selected.session_until !== selectedRecord.session_until))
    )
      throw new Error();
  };
  const validateIssue = (
    reply: IssueReply,
    input: ParticipationOperationIdentity,
    kind: "bootstrap_issue" | "credential_rotate",
    allowedIds: readonly string[],
    issuedId: string,
    expectedOwnerId: string | null,
  ) => {
    if (reply.state === "issuance_requires_restart") return;
    // Exact immutable operation tuple; sourceOwnerId is deliberately not reconstructed
    // from caller candidate/current root. It can be a now-aliased historical source.
    if (
      reply.operation.kind !== kind ||
      reply.operation.idempotencyKey !== input.idempotencyKey ||
      reply.operation.requestHash !== input.requestHash
    )
      throw new Error();
    const fresh = reply.cookie_effects.length !== 0;
    validateAuthority(reply, fresh ? [...allowedIds, issuedId] : allowedIds);
    if (
      reply.authority.selected === null ||
      (fresh && reply.authority.selected.credential_id !== issuedId)
    )
      throw new Error();
    const selected = reply.authority.selected;
    if (
      kind === "bootstrap_issue"
        ? (selected.credential_state !== "pending_bootstrap" &&
            selected.credential_state !== "confirmed") ||
          (fresh && selected.credential_state !== "pending_bootstrap")
        : selected.credential_state !== "pending_successor" || selected.owner_id !== expectedOwnerId
    )
      throw new Error();
    if (reply.cookie_effects.some((e) => e.action !== "issue" || e.credentialId !== issuedId))
      throw new Error();
  };
  const completed = (
    reply: CompletedReply,
  ): DurableParticipationOutcome<GuestAuthorityTransition> => ({
    state: "completed",
    operation: reply.operation,
    outcomeId: reply.operation_id,
    result: transition(reply),
  });
  const issueOutcome = (reply: IssueReply) =>
    reply.state === "issuance_requires_restart"
      ? Effect.fail(rejected("issuance-requires-restart"))
      : Effect.succeed(completed(reply));
  const credentialIds = (input: {
    readonly provedCredentials: readonly { readonly credentialId: string }[];
  }) => input.provedCredentials.map((c) => c.credentialId);

  return {
    issuePending: (input: Input<"issuePending">) => {
      if (input.issuance.operation.kind !== "bootstrap_issue")
        return Effect.fail(badProjection("guest-authority.issue.context", false));
      const ids = credentialIds(input.context);
      return call(
        "guest-authority.issue",
        "SELECT issue_guest_pending_v1($1,$2::text[],$3,$4,$5,$6,$7,$8,$9) AS result",
        [
          input.context.origin,
          ids,
          input.context.selected?.credentialId ?? null,
          input.issuance.operation.idempotencyKey,
          input.issuance.operation.requestHash,
          newOperationId(),
          input.newOwnerId,
          input.issuance.credentialId,
          input.issuance.tokenDigest,
        ],
        Issue,
        (reply) =>
          validateIssue(
            reply,
            input.issuance.operation,
            "bootstrap_issue",
            ids,
            input.issuance.credentialId,
            null,
          ),
      ).pipe(Effect.flatMap(issueOutcome));
    },
    confirm: (input: Input<"confirm">) => {
      if (input.credentialId !== input.context.selected.credentialId)
        return Effect.fail(rejected("owner-mismatch"));
      const ids = credentialIds(input.context);
      return call(
        "guest-authority.confirm",
        "SELECT confirm_guest_pending_v1($1,$2::text[],$3,$4) AS result",
        [input.context.origin, ids, input.context.selected.credentialId, input.expectedOwnerId],
        Transition,
        (reply) => {
          validateAuthority(reply, ids);
          if (
            reply.cookie_effects.length !== 0 ||
            reply.authority.selected?.credential_id !== input.credentialId ||
            reply.authority.selected.credential_state !== "confirmed"
          )
            throw new Error();
          // Confirm can converge EMPTY aliases. Final owner may differ from pre-convergence expected owner.
        },
      ).pipe(Effect.map(transition));
    },
    renew: (input: Input<"renew">) => {
      const ids = credentialIds(input.context);
      return call(
        "guest-authority.renew",
        "SELECT renew_guest_authority_v1($1,$2::text[],$3,$4) AS result",
        [input.context.origin, ids, input.context.selected.credentialId, input.expectedOwnerId],
        Transition,
        (reply) => {
          validateAuthority(reply, ids);
          if (
            reply.authority.selected?.credential_id !== input.context.selected.credentialId ||
            reply.authority.selected.credential_state !== "confirmed" ||
            reply.authority.selected.owner_id !== input.expectedOwnerId ||
            reply.cookie_effects.length !== 1 ||
            reply.cookie_effects.some(
              (e) =>
                e.action !== "refresh" || e.credentialId !== input.context.selected.credentialId,
            )
          )
            throw new Error();
        },
      ).pipe(Effect.map(transition));
    },
    issueRotation: (input: Input<"issueRotation">) => {
      if (input.issuance.operation.kind !== "credential_rotate")
        return Effect.fail(badProjection("guest-authority.rotate.context", false));
      const ids = credentialIds(input.context);
      return call(
        "guest-authority.rotate",
        "SELECT issue_guest_rotation_v1($1,$2::text[],$3,$4,$5,$6,$7,$8,$9) AS result",
        [
          input.context.origin,
          ids,
          input.context.selected.credentialId,
          input.expectedOwnerId,
          input.issuance.operation.idempotencyKey,
          input.issuance.operation.requestHash,
          newOperationId(),
          input.issuance.credentialId,
          input.issuance.tokenDigest,
        ],
        Issue,
        (reply) =>
          validateIssue(
            reply,
            input.issuance.operation,
            "credential_rotate",
            ids,
            input.issuance.credentialId,
            input.expectedOwnerId,
          ),
      ).pipe(Effect.flatMap(issueOutcome));
    },
    acknowledgeRotation: (input: Input<"acknowledgeRotation">) => {
      if (
        input.successorCredentialId !== input.context.selected.credentialId ||
        input.predecessorCredentialId !== input.context.selected.predecessorCredentialId
      )
        return Effect.fail(rejected("owner-mismatch"));
      const ids = credentialIds(input.context);
      return call(
        "guest-authority.acknowledge",
        "SELECT acknowledge_guest_rotation_v1($1,$2::text[],$3,$4,$5) AS result",
        [
          input.context.origin,
          ids,
          input.predecessorCredentialId,
          input.context.selected.credentialId,
          input.expectedOwnerId,
        ],
        Transition,
        (reply) => {
          validateAuthority(reply, ids);
          if (
            reply.authority.selected?.credential_id !== input.successorCredentialId ||
            reply.authority.selected.credential_state !== "confirmed" ||
            reply.authority.selected.owner_id !== input.expectedOwnerId ||
            reply.cookie_effects.some(
              (e) => e.action !== "expire" || e.credentialId !== input.predecessorCredentialId,
            )
          )
            throw new Error();
        },
      ).pipe(Effect.map(transition));
    },
  };
}
