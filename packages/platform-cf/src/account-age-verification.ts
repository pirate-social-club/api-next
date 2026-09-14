import {
  type AccountAgeVerification,
  AgeVerificationStoreError,
  type AgeVerificationStoreService,
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "@pirate/application";
import {
  type VerificationIntentResolver,
  VerificationProviderPlanInput,
  VerificationStartStorageFailed,
} from "@pirate/application/verification";
import {
  ACCOUNT_AGE_18_REQUIREMENTS,
  type AccountAgeVerificationPolicy,
  ageVerificationReservationHash,
  documentProviderBindingHash,
} from "@pirate/domain";
import { Effect, type Layer, Schema } from "effect";
import {
  DocumentCeremonyDataInvalid,
  resolveOrIssueDocumentCeremony,
} from "./document-ceremony-store.ts";

type Row = Readonly<Record<string, unknown>>;
type Transaction = ControlPlaneTransaction;
const identity = { version: "account-age-verification-v1", minimum_age: 18 } as const;
// This bounds an uncompleted ceremony, never the lifetime of accepted age evidence.
const ceremonyTtlSeconds = 15 * 60;
const Reservation = Schema.Struct({
  action_kind: Schema.Literal("adult_view"),
  actor_id: Schema.NonEmptyString,
  intent_id: Schema.NonEmptyString,
  requirement_hash: Schema.NonEmptyString,
  policy_hash: Schema.NonEmptyString,
  provider_id: Schema.Literals(["self.pass", "zkpassport"]),
  provider_binding_hash: Schema.NonEmptyString,
});
const invalid = () => new AgeVerificationStoreError();
const lock = (tx: Transaction, actorId: string) =>
  tx.execute({
    label: "age-verification.account.lock",
    readonly: false,
    text: "SELECT pg_advisory_xact_lock(hashtextextended('account-age-18:' || $1, 0))",
    values: [actorId],
  });
const hasCapability = (tx: Transaction, actorId: string) =>
  Effect.gen(function* () {
    const result = yield* tx.execute<Row>({
      label: "age-verification.capability",
      readonly: true,
      text: "SELECT current_account_age_capability_v1($1) AS capability",
      values: [actorId],
    });
    if (
      result.rows.length !== 1 ||
      !["general", "adult_18"].includes(String(result.rows[0]?.capability))
    ) {
      return yield* invalid();
    }
    return result.rows[0]?.capability === "adult_18";
  });
const current = (tx: Transaction, actorId: string) =>
  Effect.gen(function* () {
    const result = yield* tx.execute<Row>({
      label: "age-verification.current",
      readonly: false,
      text: `SELECT state.intent_id, state.actor_id, state.status, state.requirement_hash,
                  state.generation, state.current_ceremony_intent_id, state.current_provider_id,
                  state.current_provider_binding_hash, attempt.reservation_request,
                  attempt.reservation_request_hash, attempt.provider_id,
                  attempt.provider_binding_hash, attempt.generation AS attempt_generation,
                  attempt.expires_at > clock_timestamp() AS attempt_live,
                  (session.proof_session_id IS NULL OR
                    (session.status='pending' AND session.expires_at>clock_timestamp())) AS session_startable,
                  session.status AS session_status
             FROM account_age_verification_current AS current
             JOIN age_verification_requirement_states AS state
               ON state.actor_id=current.account_id AND state.intent_id=current.intent_id
             JOIN age_verification_ceremony_attempts AS attempt
               ON attempt.ceremony_intent_id=state.current_ceremony_intent_id
              AND attempt.actor_id=state.actor_id AND attempt.intent_id=state.intent_id
              AND attempt.action_kind=state.action_kind AND attempt.requirement_kind=state.requirement_kind
             LEFT JOIN proof_sessions AS session ON session.intent_id=attempt.ceremony_intent_id
               AND session.actor_id=attempt.actor_id
            WHERE current.account_id=$1 AND state.action_kind='adult_view' AND state.requirement_kind='age_18'
            FOR UPDATE OF state`,
      values: [actorId],
    });
    if (result.rows.length > 1) return yield* invalid();
    return result.rows[0] ?? null;
  });
function validCurrent(row: Row, actorId: string, policy: AccountAgeVerificationPolicy): boolean {
  const reservation = Schema.decodeUnknownOption(Reservation, { onExcessProperty: "error" })(
    row.reservation_request,
  );
  if (reservation._tag === "None") return false;
  const value = reservation.value;
  const binding = policy.provider_bindings.find((item) => item.provider_id === row.provider_id);
  return (
    binding !== undefined &&
    row.actor_id === actorId &&
    row.status === "pending" &&
    row.attempt_live === true &&
    Number.isSafeInteger(Number(row.generation)) &&
    Number(row.generation) > 0 &&
    String(row.generation) === String(row.attempt_generation) &&
    row.current_provider_id === row.provider_id &&
    row.current_provider_binding_hash === row.provider_binding_hash &&
    row.provider_binding_hash === documentProviderBindingHash(binding) &&
    row.requirement_hash === policy.requirement_hash &&
    typeof row.current_ceremony_intent_id === "string" &&
    value.actor_id === actorId &&
    value.intent_id === row.intent_id &&
    value.requirement_hash === policy.requirement_hash &&
    value.policy_hash === policy.policy_hash &&
    value.provider_id === row.provider_id &&
    value.provider_binding_hash === row.provider_binding_hash &&
    row.reservation_request_hash === ageVerificationReservationHash(value)
  );
}
function issue(
  tx: Transaction,
  actorId: string,
  intentId: string,
  policy: AccountAgeVerificationPolicy,
  selected: AccountAgeVerificationPolicy["provider_bindings"][number],
) {
  const bindingHash = documentProviderBindingHash(selected);
  return resolveOrIssueDocumentCeremony(
    tx,
    {
      actionKind: "adult_view",
      actorId,
      intentId,
      requirementHash: policy.requirement_hash,
      acceptedProviderIds: ["self.pass", "zkpassport"],
      selectedProviderId: selected.provider_id,
      selectedBinding: {
        bindingHash,
        configurationKind: selected.provider_configuration.kind,
        configurationRef: selected.provider_configuration.reference,
        configurationVersion: selected.provider_configuration.version,
      },
      reservationRequest: {
        action_kind: "adult_view",
        actor_id: actorId,
        intent_id: intentId,
        requirement_hash: policy.requirement_hash,
        policy_hash: policy.policy_hash,
        provider_id: selected.provider_id,
        provider_binding_hash: bindingHash,
      },
      ttlSeconds: ceremonyTtlSeconds,
    },
    { namespace: "age18" },
  );
}

export function makeControlPlaneAccountAgeVerification(
  database: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  policy: AccountAgeVerificationPolicy | null,
): Readonly<{ store: AgeVerificationStoreService; intents: VerificationIntentResolver }> {
  const store: AgeVerificationStoreService = {
    getVerification: ({ accountId }) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((tx) =>
          Effect.gen(function* () {
            yield* lock(tx, accountId);
            if (yield* hasCapability(tx, accountId))
              return { ...identity, status: "verified" } as const;
            if (policy === null) return { ...identity, status: "unavailable" } as const;
            const row = yield* current(tx, accountId);
            const reusable =
              row !== null &&
              validCurrent(row, accountId, policy) &&
              row.session_startable === true;
            const selected = reusable
              ? policy.provider_bindings.find((binding) => binding.provider_id === row.provider_id)
              : policy.provider_bindings[0];
            if (selected === undefined) return yield* invalid();
            const intentId = reusable ? String(row.intent_id) : `age18_${crypto.randomUUID()}`;
            if (!reusable && row !== null) {
              yield* tx.execute({
                label: "age-verification.retire",
                readonly: false,
                text: `UPDATE age_verification_requirement_states SET status='expired', updated_at=clock_timestamp()
                    WHERE actor_id=$1 AND intent_id=$2 AND status='pending'`,
                values: [accountId, row.intent_id],
              });
            }
            const attempt = yield* issue(tx, accountId, intentId, policy, selected);
            if (!reusable) {
              yield* tx.execute({
                label: "age-verification.bind-current",
                readonly: false,
                text: `INSERT INTO account_age_verification_current (account_id,intent_id) VALUES ($1,$2)
                    ON CONFLICT (account_id) DO UPDATE SET intent_id=EXCLUDED.intent_id, updated_at=clock_timestamp()`,
                values: [accountId, intentId],
              });
            }
            return {
              ...identity,
              status: "verification_required",
              requirement_hash: policy.requirement_hash,
              ceremony_intent_id: attempt.ceremonyIntentId,
              generation: attempt.generation,
              provider_id: selected.provider_id,
              accepted_provider_ids: ["self.pass", "zkpassport"],
            } as const satisfies AccountAgeVerification;
          }),
        );
      }).pipe(
        Effect.mapError((error) =>
          error instanceof DocumentCeremonyDataInvalid ? invalid() : error,
        ),
        Effect.provide(database),
      ),
  };
  const intents: VerificationIntentResolver = {
    resolve: (input) => {
      if (!("intent_id" in input) || !input.intent_id.startsWith("age18-") || policy === null)
        return Effect.succeed(null);
      return Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((tx) =>
          Effect.gen(function* () {
            yield* lock(tx, input.actor_id);
            const row = yield* current(tx, input.actor_id);
            if (
              row === null ||
              row.current_ceremony_intent_id !== input.intent_id ||
              !validCurrent(row, input.actor_id, policy)
            )
              return null;
            if (
              row.session_startable !== true &&
              !(row.session_status === "completed" && (yield* hasCapability(tx, input.actor_id)))
            )
              return null;
            const selected = policy.provider_bindings.find(
              (binding) => binding.provider_id === input.provider_id,
            );
            if (selected === undefined) return null;
            const attempt = yield* issue(
              tx,
              input.actor_id,
              String(row.intent_id),
              policy,
              selected,
            );
            const plan = Schema.decodeUnknownOption(VerificationProviderPlanInput)({
              method: selected.method,
              scope: selected.scope,
              requested_requirements: ACCOUNT_AGE_18_REQUIREMENTS,
              requested_claim_ids: ["age.minimum", "credential.subject_unique", "document.valid"],
              subject_binding_intent: "establish",
              protocol_version: selected.protocol_version,
              environment: selected.environment,
            });
            if (plan._tag === "None") return yield* invalid();
            return { ...plan.value, resolved_intent_id: attempt.ceremonyIntentId };
          }),
        );
      }).pipe(
        Effect.provide(database),
        Effect.mapError(() => new VerificationStartStorageFailed()),
      );
    },
  };
  return { store, intents };
}
